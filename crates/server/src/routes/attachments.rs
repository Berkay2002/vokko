use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HeaderName, LOCATION};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
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

async fn upload(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>, mut multipart: Multipart) -> ApiResult<Json<Attachment>> {
    let channel_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, channel_id).await?;
    access.require(ATTACH_FILES)?;
    while let Some(mut field) = multipart.next_field().await.map_err(|error| multipart_error(error, "Malformed multipart body."))? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("file"));
        let declared = field.content_type().map(str::to_owned);
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|error| multipart_error(error, "Upload interrupted."))? {
            if bytes.len() + chunk.len() > state.config.max_upload_bytes {
                return Err(ApiErr::payload_too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(ApiErr::invalid("file", "The file is empty."));
        }
        let (content_type, width, height) = match sniff_image(&bytes) {
            Some(image) => (image.content_type.to_owned(), Some(image.width as i32), Some(image.height as i32)),
            None => (plain_content_type(declared.as_deref(), &filename), None, None),
        };
        let attachment_id = state.ids.next();
        let size = bytes.len();
        state.storage.put(attachment_id, bytes.into()).await?;
        let key = media::new_key();
        // Quota check and insert in one statement so concurrent uploads cannot both slip under the limit.
        let inserted = sqlx::query(
            "INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, width, height, key)              SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9              WHERE (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE uploader_id = $3 AND message_id IS NULL AND claimed_at IS NULL) + $6 <= $10",
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
        .bind(MAX_PENDING_BYTES_PER_USER)
        .execute(&state.db)
        .await;
        match inserted {
            Ok(done) if done.rows_affected() == 1 => {}
            Ok(_) => {
                media::remove_files(&state, &[attachment_id]).await;
                let mut error = ApiErr::payload_too_large();
                error.body.message = "Too many pending uploads: send a message with them first (100 MiB limit).".to_owned();
                return Err(error);
            }
            Err(error) => {
                media::remove_files(&state, &[attachment_id]).await;
                return Err(error.into());
            }
        }
        return Ok(Json(attachment_api(&state, attachment_id, &key, filename, Some(content_type), size as i64, width, height)));
    }
    Err(ApiErr::invalid("file", "Missing `file` part."))
}

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
