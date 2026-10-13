use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::multipart::Field;
use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HeaderName, LOCATION};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use tokio::io::AsyncWriteExt;
use vokko_protocol::api::Attachment;
use vokko_protocol::api::permissions::ATTACH_FILES;

use crate::access::channel_access;
use crate::auth::AuthUser;
use crate::config::MAX_PENDING_BYTES_PER_USER;
use crate::error::{ApiErr, ApiResult};
use crate::extract::parse_id;
use crate::media::{self, encode_filename, plain_content_type, sanitize_filename, sniff_image};
use crate::state::AppState;
use crate::storage::Presign;
use crate::store::attachment_api;

/// Hitting the body limit surfaces as a multipart error carrying 413; everything else is a malformed form.
fn multipart_error(error: MultipartError, message: &str) -> ApiErr {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE { ApiErr::payload_too_large() } else { ApiErr::invalid("file", message) }
}

/// `max_upload_bytes` is the largest file; the body limit leaves 1 MiB for the multipart envelope.
pub fn routes(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/attachments", post(upload).layer(DefaultBodyLimit::max(max_upload_bytes + 1024 * 1024)))
        .route("/attachments/{id}/{key}/{filename}", get(download))
}

const MIB: i64 = 1024 * 1024;
/// Bytes kept in memory for `sniff_image` (image headers, and a JPEG's size marker after its metadata: camera files can carry
/// several MiB of ICC/MPF/XMP segments before it).
const SNIFF_BYTES: usize = 4 * 1024 * 1024;

/// A user's pending-upload quota: 100 MiB, or one file of the largest size when the per-file limit is above that.
pub(super) fn pending_quota(max_upload_bytes: usize) -> i64 {
    MAX_PENDING_BYTES_PER_USER.max(i64::try_from(max_upload_bytes).unwrap_or(i64::MAX))
}

pub(super) fn quota_error(quota: i64) -> ApiErr {
    let mut error = ApiErr::payload_too_large();
    error.body.message = format!("Too many pending uploads: send a message with them first ({} MiB limit).", quota / MIB);
    error
}

/// Bytes of `user_id`'s pending uploads (not attached, not claimed by a profile, icon, ...), as counted against the quota.
pub(super) const PENDING_BYTES: &str =
    "SELECT COALESCE(SUM(size), 0)::BIGINT FROM attachments WHERE uploader_id = $1 AND message_id IS NULL AND claimed_at IS NULL";

/// A staging file that is removed when this is dropped: on every error path, and when the request future is dropped mid-upload
/// (client disconnect, shutdown, panic), so an aborted upload never leaves an untracked file behind.
struct PendingFile(Option<std::path::PathBuf>);

impl Drop for PendingFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            // off the async worker when there is a runtime (the usual case: a dropped request future)
            match tokio::runtime::Handle::try_current() {
                Ok(runtime) => {
                    runtime.spawn_blocking(move || std::fs::remove_file(path));
                }
                Err(_) => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

/// An attachments row that is deleted, with any bytes stored for it, unless `keep` is called. Armed just before the row is inserted,
/// so an upload that fails or whose request future is dropped (client disconnect, shutdown) after the insert never leaves a row
/// counting against the uploader's pending quota until the periodic cleanup. On drop the delete runs as a spawned task.
struct PendingRow {
    state: Option<AppState>,
    id: i64,
}

impl PendingRow {
    fn new(state: &AppState, id: i64) -> Self {
        Self { state: Some(state.clone()), id }
    }

    fn keep(mut self) {
        self.state = None;
    }

    /// Removes the row and its bytes before returning, so the error response already reflects the freed quota.
    async fn discard(mut self) {
        if let Some(state) = self.state.take() {
            remove_row(&state, self.id).await;
        }
    }
}

/// Only while the row is still an unclaimed pending upload (as `media::cleanup_pending` matches them): once the id has been attached to
/// a message or claimed as an avatar, icon, ..., the row and its bytes are left alone.
async fn remove_row(state: &AppState, id: i64) {
    let deleted: Result<Option<(i64,)>, _> = sqlx::query_as(&format!(
        "DELETE FROM attachments a WHERE id = $1 AND message_id IS NULL AND claimed_at IS NULL AND NOT {} RETURNING id",
        media::IN_USE
    ))
    .bind(id)
    .fetch_optional(&state.db)
    .await;
    match deleted {
        Ok(Some(_)) => media::remove_files(state, &[id]).await,
        Ok(None) => {}
        Err(error) => tracing::warn!("cannot remove aborted upload {id}: {error}"),
    }
}

impl Drop for PendingRow {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            let id = self.id;
            // Without a runtime (never the case for a request) the periodic pending-upload cleanup removes it instead.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { remove_row(&state, id).await });
            }
        }
    }
}

/// Writes one multipart field to `path`; returns its size and its first `SNIFF_BYTES`, or `None` once it grows past `max_bytes`.
/// The size is what actually arrived, whatever the client declared.
async fn receive_file(field: &mut Field<'_>, path: &std::path::Path, max_bytes: usize) -> ApiResult<Option<(usize, Vec<u8>)>> {
    let mut file = tokio::fs::File::create(path).await?;
    let mut head: Vec<u8> = Vec::new();
    let mut size = 0_usize;
    while let Some(chunk) = field.chunk().await.map_err(|error| multipart_error(error, "Upload interrupted."))? {
        size += chunk.len();
        if size > max_bytes {
            return Ok(None);
        }
        if head.len() < SNIFF_BYTES {
            head.extend_from_slice(&chunk[..chunk.len().min(SNIFF_BYTES - head.len())]);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(Some((size, head)))
}

/// Stores image bytes the server fetched itself (a GIF picked for an avatar) as the caller's pending upload in `channel_id`, with the same
/// checks, quota and cleanup as [`upload`]. The bytes must be a PNG, JPEG, GIF or WebP image.
pub async fn store_fetched_image(state: &AppState, user_id: i64, channel_id: i64, bytes: Vec<u8>) -> ApiResult<Attachment> {
    let image = sniff_image(&bytes[..bytes.len().min(SNIFF_BYTES)]).ok_or_else(|| ApiErr::invalid("url", "Must be a PNG, JPEG, GIF or WebP image."))?;
    let extension = image.content_type.trim_start_matches("image/");
    let filename = format!("avatar.{extension}");
    let (content_type, size) = (image.content_type.to_owned(), bytes.len() as i64);
    let (width, height) = (Some(image.width as i32), Some(image.height as i32));
    let (attachment_id, key) = (state.ids.next(), media::new_key());
    let quota = pending_quota(state.config.max_upload_bytes);
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)").bind(UPLOAD_LOCK_SPACE).bind((user_id ^ (user_id >> 32)) as i32).execute(&mut *tx).await?;
    let (pending,): (i64,) = sqlx::query_as(PENDING_BYTES).bind(user_id).fetch_one(&mut *tx).await?;
    if pending.saturating_add(size) > quota {
        return Err(quota_error(quota));
    }
    let row = PendingRow::new(state, attachment_id);
    sqlx::query(
        "INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, width, height, key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(attachment_id)
    .bind(channel_id)
    .bind(user_id)
    .bind(&filename)
    .bind(&content_type)
    .bind(size)
    .bind(width)
    .bind(height)
    .bind(&key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Err(error) = state.storage.put(attachment_id, axum::body::Bytes::from(bytes)).await {
        row.discard().await;
        return Err(error.into());
    }
    row.keep();
    Ok(attachment_api(state, attachment_id, &key, filename, Some(content_type), size, width, height))
}

async fn upload(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>, mut multipart: Multipart) -> ApiResult<Json<Attachment>> {
    let channel_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, channel_id).await?;
    access.require(ATTACH_FILES)?;
    let _slot = state.uploads.acquire(user_id).ok_or_else(|| ApiErr::rate_limited(1.0))?;
    let quota = pending_quota(state.config.max_upload_bytes);
    while let Some(mut field) = multipart.next_field().await.map_err(|error| multipart_error(error, "Malformed multipart body."))? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("file"));
        let declared = field.content_type().map(str::to_owned);
        // A user already at the quota is refused before anything is written, and the stream stops as soon as the bytes that really
        // arrive pass what is left of it.
        let (pending,): (i64,) = sqlx::query_as(PENDING_BYTES).bind(user_id).fetch_one(&state.db).await?;
        if pending >= quota {
            return Err(quota_error(quota));
        }
        let left = usize::try_from(quota - pending).unwrap_or(usize::MAX);
        let max_bytes = state.config.max_upload_bytes.min(left);
        // Streamed to a staging file (files may be hundreds of MiB); only the head is kept in memory to recognise images.
        let attachment_id = state.ids.next();
        let incoming = state.incoming_dir();
        tokio::fs::create_dir_all(&incoming).await?;
        let path = incoming.join(attachment_id.to_string());
        let _staged = PendingFile(Some(path.clone()));
        let Some((size, head)) = receive_file(&mut field, &path, max_bytes).await? else {
            return Err(if max_bytes < state.config.max_upload_bytes { quota_error(quota) } else { ApiErr::payload_too_large() });
        };
        if size == 0 {
            return Err(ApiErr::invalid("file", "The file is empty."));
        }
        let (content_type, width, height) = match sniff_image(&head) {
            Some(image) => (image.content_type.to_owned(), Some(image.width as i32), Some(image.height as i32)),
            None => (plain_content_type(declared.as_deref(), &filename), None, None),
        };
        let key = media::new_key();
        // The quota is checked again against the real size, under a per-user lock so concurrent uploads cannot each pass it.
        let mut tx = state.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1, $2)").bind(UPLOAD_LOCK_SPACE).bind((user_id ^ (user_id >> 32)) as i32).execute(&mut *tx).await?;
        let (pending,): (i64,) = sqlx::query_as(PENDING_BYTES).bind(user_id).fetch_one(&mut *tx).await?;
        if pending.saturating_add(size as i64) > quota {
            return Err(quota_error(quota));
        }
        // Armed before the row can exist: until `keep`, dropping this (an error below, or the request future dropped by a client
        // disconnect) removes the row and any stored bytes, so an aborted upload stops counting against the quota at once.
        let row = PendingRow::new(&state, attachment_id);
        sqlx::query(
            "INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, width, height, key)              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(attachment_id)
        .bind(channel_id)
        .bind(user_id)
        .bind(&filename)
        .bind(&content_type)
        .bind(size as i64)
        .bind(width)
        .bind(height)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        // The row exists before the bytes are stored, so concurrent uploads see this one's size in the quota while it streams out.
        if let Err(error) = state.storage.put_file(attachment_id, &path).await {
            row.discard().await;
            return Err(error.into());
        }
        row.keep();
        return Ok(Json(attachment_api(&state, attachment_id, &key, filename, Some(content_type), size as i64, width, height)));
    }
    Err(ApiErr::invalid("file", "Missing `file` part."))
}

/// First key of the upload quota's advisory lock (the second is the user). Polls hash message ids into that slot; a rare collision only
/// makes two unrelated requests wait for each other.
const UPLOAD_LOCK_SPACE: i32 = 1;

async fn download(State(state): State<AppState>, Path((id, key, url_filename)): Path<(String, String, String)>) -> ApiResult<Response> {
    // Every failure below is the same 404 so a caller cannot tell a wrong key from a missing id.
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_attachment)?;
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT filename, content_type, key FROM attachments WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    let Some((filename, content_type, Some(stored_key))) = row else { return Err(ApiErr::unknown_attachment()) };
    if !media::keys_match(&stored_key, &key) || url_filename != filename {
        return Err(ApiErr::unknown_attachment());
    }
    let content_type = content_type.unwrap_or_else(|| "application/octet-stream".to_owned());
    let inline = matches!(content_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp");
    let disposition = format!(
        "{}; filename=\"{}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        filename.replace(['"', '\\'], "_").replace(|c: char| !c.is_ascii(), "_"),
        encode_filename(&filename)
    );
    // Presigned mode: the key and filename were checked above, so the bucket only sees callers that passed the same rules.
    if let Some(url) = state.storage.presigned_url(id, &Presign { content_type: &content_type, disposition: &disposition }) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::FOUND;
        let headers = response.headers_mut();
        headers.insert(LOCATION, HeaderValue::from_str(&url).map_err(|_| ApiErr::internal())?);
        // The URL expires, so the redirect itself is not cached.
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(response);
    }
    let object = state.storage.open(id).await.map_err(|error| {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot read attachment {id}: {error}");
        }
        ApiErr::unknown_attachment()
    })?;
    let mut response = Response::new(object.body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_str(&content_type).map_err(|_| ApiErr::internal())?);
    headers.insert(CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(|_| ApiErr::internal())?);
    headers.insert(CONTENT_LENGTH, HeaderValue::from(object.length));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    headers.insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::{PendingFile, SNIFF_BYTES};
    use crate::media::sniff_image;

    #[test]
    fn a_dropped_upload_removes_its_staging_file() {
        let dir = std::env::temp_dir().join(format!("vokko-pending-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("upload");
        std::fs::write(&path, b"partial").expect("write");
        drop(PendingFile(Some(path.clone())));
        assert!(!path.exists());
        // a file that was already moved into storage is fine too
        drop(PendingFile(Some(path.clone())));
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn a_jpeg_with_large_metadata_is_still_recognised() {
        // 1.2 MiB of APP2 (ICC) segments before the SOF marker, as in camera files
        let mut jpeg = vec![0xff, 0xd8];
        let segment = 0xfff0_usize;
        for _ in 0..20 {
            jpeg.extend_from_slice(&[0xff, 0xe2, (segment >> 8) as u8, segment as u8]);
            jpeg.extend(vec![0_u8; segment - 2]);
        }
        assert!(jpeg.len() > 1_200_000);
        jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58]);
        jpeg.extend([0_u8; 64]);
        let head = &jpeg[..jpeg.len().min(SNIFF_BYTES)];
        let sniffed = sniff_image(head).expect("recognised");
        assert_eq!((sniffed.content_type, sniffed.width, sniffed.height), ("image/jpeg", 600, 300));
    }
}
