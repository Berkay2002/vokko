//! Attachment keys and file cleanup (bytes live in `storage`), content-type sniffing and image dimensions.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::auth::random_hex;
use crate::config::{CLEANUP_INTERVAL, PENDING_MAX_AGE};
use crate::state::AppState;

/// Uploads one user may stream at once: each can stage up to the per-file limit on disk before the quota re-check.
pub const MAX_CONCURRENT_UPLOADS: usize = 3;

/// In-flight uploads per user.
#[derive(Default)]
pub struct UploadSlots(Arc<Mutex<HashMap<i64, usize>>>);

/// Held for the length of one upload; dropping it frees the slot.
pub struct UploadSlot {
    slots: Arc<Mutex<HashMap<i64, usize>>>,
    user_id: i64,
}

impl UploadSlots {
    /// `None` when the user already has `MAX_CONCURRENT_UPLOADS` uploads in flight.
    pub fn acquire(&self, user_id: i64) -> Option<UploadSlot> {
        let mut map = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let count = map.entry(user_id).or_insert(0);
        if *count >= MAX_CONCURRENT_UPLOADS {
            return None;
        }
        *count += 1;
        Some(UploadSlot { slots: self.0.clone(), user_id })
    }
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        let mut map = self.slots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = map.get_mut(&self.user_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.user_id);
            }
        }
    }
}

/// 128-bit random download key (32 hex chars) from the CSPRNG.
pub fn new_key() -> String {
    random_hex(16)
}

/// Constant-time string comparison (the length is not secret: keys are always 32 chars).
pub fn keys_match(stored: &str, given: &str) -> bool {
    let (a, b) = (stored.as_bytes(), given.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Stored asset path `<id>/<key>/<percent-encoded filename>`; `AppState::asset_url` prefixes the origin and `/api/v1/attachments/`.
pub fn asset_path(id: i64, key: &str, filename: &str) -> String {
    format!("{id}/{key}/{}", encode_filename(filename))
}

/// SQL condition (the `attachments` row is aliased `a`): something still shows the upload, i.e. a user's or a server profile's avatar or
/// banner, a user's profile widget image, a guild icon or banner, a group icon, a sticker, an event cover, an application icon or a webhook
/// avatar. It matches on the upload id (the first path segment) because legacy rows store `<id>/<filename>`. Use it as `AND NOT {IN_USE}`
/// wherever an upload is released or swept, so a claim that was cleared by mistake can never get a picture that is still shown deleted.
pub const IN_USE: &str = "(EXISTS (SELECT 1 FROM users u WHERE a.id::text IN (split_part(u.avatar_path, '/', 1), split_part(u.banner_path, '/', 1))) \
     OR EXISTS (SELECT 1 FROM users u, jsonb_path_query(u.widgets, '$.**.image_path') p WHERE split_part(p #>> '{}', '/', 1) = a.id::text) \
     OR EXISTS (SELECT 1 FROM guild_members gm WHERE a.id::text IN (split_part(gm.avatar_path, '/', 1), split_part(gm.banner_path, '/', 1))) \
     OR EXISTS (SELECT 1 FROM guilds g WHERE a.id::text IN (split_part(g.icon_path, '/', 1), split_part(g.banner_path, '/', 1))) \
     OR EXISTS (SELECT 1 FROM channels c WHERE split_part(c.icon_path, '/', 1) = a.id::text) \
     OR EXISTS (SELECT 1 FROM stickers s WHERE s.attachment_id = a.id) \
     OR EXISTS (SELECT 1 FROM message_stickers m WHERE m.attachment_id = a.id) \
     OR EXISTS (SELECT 1 FROM emojis em WHERE em.attachment_id = a.id) \
     OR EXISTS (SELECT 1 FROM soundboard_sounds ss WHERE ss.attachment_id = a.id) \
     OR EXISTS (SELECT 1 FROM scheduled_events e WHERE split_part(e.image_path, '/', 1) = a.id::text) \
     OR EXISTS (SELECT 1 FROM applications ap WHERE split_part(ap.icon_path, '/', 1) = a.id::text) \
     OR EXISTS (SELECT 1 FROM webhooks w WHERE split_part(w.avatar_path, '/', 1) = a.id::text))";

/// Row-locks the given uploads in one statement, by ascending id. Every transaction that locks more than one `attachments` row takes
/// them this way (or with another single `ORDER BY id FOR UPDATE` over a superset, as account delete does) before it claims, attaches
/// or releases any of them, so two transactions can never hold each other's uploads. Nothing happens for an empty list.
pub async fn lock_uploads(conn: &mut sqlx::PgConnection, ids: &[i64]) -> Result<(), sqlx::Error> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT id FROM attachments WHERE id = ANY($1) ORDER BY id FOR UPDATE").bind(ids).execute(conn).await?;
    Ok(())
}

/// Where the local backend keeps an attachment's bytes.
pub fn file_path(state: &AppState, attachment_id: i64) -> PathBuf {
    state.attachments_dir().join(attachment_id.to_string())
}

/// Parallel deletes per batch handed to a remote backend.
const REMOTE_DELETE_CONCURRENCY: usize = 8;

/// Best-effort removal of stored files (rows are removed by the caller). Local disk deletes before returning; a remote
/// backend (one request per file) deletes in a detached task, so a big guild or account delete neither holds the request
/// open nor stops halfway when the client gives up.
pub async fn remove_files(state: &AppState, attachment_ids: &[i64]) {
    if attachment_ids.is_empty() {
        return;
    }
    if state.storage.deletes_inline() {
        for id in attachment_ids {
            if let Err(error) = state.storage.delete(*id).await {
                tracing::warn!("cannot remove attachment file {id}: {error}");
            }
        }
        return;
    }
    let storage = state.storage.clone();
    let ids = attachment_ids.to_vec();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        futures_util::stream::iter(ids)
            .for_each_concurrent(REMOTE_DELETE_CONCURRENCY, |id| {
                let storage = storage.clone();
                async move {
                    if let Err(error) = storage.delete(id).await {
                        tracing::warn!("cannot remove attachment file {id}: {error}");
                    }
                }
            })
            .await;
    });
}

/// Deletes pending uploads (`message_id IS NULL AND claimed_at IS NULL`) older than `max_age`, rows and files; returns how many.
/// Avatars and icons are attachments with a NULL `message_id` too, but they have `claimed_at` set when they are
/// assigned (`routes::users::image_path_on`), so they are never matched here; [`IN_USE`] keeps them even when a claim
/// was cleared while they were being assigned.
pub async fn cleanup_pending(state: &AppState, max_age: Duration) -> usize {
    let deleted: Result<Vec<(i64,)>, _> = sqlx::query_as(&format!(
        "DELETE FROM attachments a WHERE message_id IS NULL AND claimed_at IS NULL AND created_at < now() - make_interval(secs => $1) \
         AND NOT {IN_USE} RETURNING id"
    ))
    .bind(max_age.as_secs_f64())
    .fetch_all(&state.db)
    .await;
    match deleted {
        Ok(rows) => {
            let ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
            remove_files(state, &ids).await;
            ids.len()
        }
        Err(error) => {
            tracing::warn!("pending attachment cleanup failed: {error}");
            0
        }
    }
}

/// Periodic `cleanup_pending`; the task ends with the runtime.
pub fn spawn_cleanup(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
        loop {
            interval.tick().await;
            let removed = cleanup_pending(&state, PENDING_MAX_AGE).await;
            if removed > 0 {
                tracing::info!("removed {removed} stale pending uploads");
            }
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sniffed {
    pub content_type: &'static str,
    pub width: u32,
    pub height: u32,
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?])))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?])))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(*bytes.get(at)?) | u32::from(*bytes.get(at + 1)?) << 8 | u32::from(*bytes.get(at + 2)?) << 16)
}

/// Recognises PNG, JPEG, GIF and WebP by their magic bytes and reads the pixel size from the header.
/// Anything else (including SVG, which can carry script) is not treated as an image.
pub fn sniff_image(bytes: &[u8]) -> Option<Sniffed> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
        let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
        return Some(Sniffed { content_type: "image/png", width, height });
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(Sniffed { content_type: "image/gif", width: le16(bytes, 6)?, height: le16(bytes, 8)? });
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return jpeg_size(bytes).map(|(width, height)| Sniffed { content_type: "image/jpeg", width, height });
    }
    if bytes.len() > 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let (width, height) = match &bytes[12..16] {
            b"VP8 " if bytes.get(23..26)? == [0x9d, 0x01, 0x2a] => (le16(bytes, 26)? & 0x3fff, le16(bytes, 28)? & 0x3fff),
            b"VP8L" if bytes.get(20) == Some(&0x2f) => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => (le24(bytes, 24)? + 1, le24(bytes, 27)? + 1),
            _ => return None,
        };
        return Some(Sniffed { content_type: "image/webp", width, height });
    }
    None
}

fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        if (0xd0..=0xd9).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        let length = be16(bytes, at + 2)? as usize;
        let is_frame = matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
        if is_frame {
            return Some((be16(bytes, at + 7)?, be16(bytes, at + 5)?));
        }
        at += 2 + length;
    }
    None
}

/// Content type for a non-image upload: the declared type unless it could execute in a browser, then a few well known extensions.
pub fn plain_content_type(declared: Option<&str>, filename: &str) -> String {
    let declared = declared.map(|value| value.split(';').next().unwrap_or("").trim().to_lowercase()).filter(|value| value.contains('/'));
    let risky = |value: &str| {
        value.contains("html")
            || value.contains("xml")
            || value.contains("javascript")
            || value.contains("svg")
            || value.starts_with("image/")
            || value.contains("ecmascript")
    };
    if let Some(declared) = declared.filter(|value| !risky(value) && value != "application/octet-stream") {
        return declared;
    }
    let extension = filename.rsplit_once('.').map(|(_, extension)| extension.to_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_owned()
}

/// Strips directories and control characters; never empty.
pub fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '"' | '<' | '>' | ':' | '|' | '?' | '*')).take(200).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() { "file".to_owned() } else { cleaned }
}

/// RFC 5987 percent-encoding for `filename*=`.
pub fn encode_filename(name: &str) -> String {
    let mut out = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_slots_cap_each_user_and_free_on_drop() {
        let slots = UploadSlots::default();
        let held: Vec<UploadSlot> = (0..MAX_CONCURRENT_UPLOADS).map(|_| slots.acquire(1).expect("slot")).collect();
        assert!(slots.acquire(1).is_none(), "a fourth upload waits");
        assert!(slots.acquire(2).is_some(), "other users are not affected");
        drop(held);
        assert!(slots.acquire(1).is_some());
        assert!(slots.0.lock().expect("lock").is_empty(), "freed entries are removed");
    }

    #[test]
    fn png_gif_dimensions() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&640_u32.to_be_bytes());
        png.extend_from_slice(&480_u32.to_be_bytes());
        assert_eq!(sniff_image(&png), Some(Sniffed { content_type: "image/png", width: 640, height: 480 }));
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0x20, 0x01, 0x10, 0x00]);
        assert_eq!(sniff_image(&gif), Some(Sniffed { content_type: "image/gif", width: 288, height: 16 }));
    }

    #[test]
    fn jpeg_dimensions_skip_other_segments() {
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
        jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58]);
        assert_eq!(sniff_image(&jpeg), Some(Sniffed { content_type: "image/jpeg", width: 600, height: 300 }));
    }

    #[test]
    fn webp_variants() {
        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0".to_vec();
        lossless.push(0x2f);
        let bits: u32 = (99) | (49 << 14);
        lossless.extend_from_slice(&bits.to_le_bytes());
        lossless.extend_from_slice(&[0; 8]);
        assert_eq!(sniff_image(&lossless), Some(Sniffed { content_type: "image/webp", width: 100, height: 50 }));
        let mut extended = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        extended.extend_from_slice(&[0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00]);
        extended.extend_from_slice(&[0; 4]);
        assert_eq!(sniff_image(&extended), Some(Sniffed { content_type: "image/webp", width: 800, height: 480 }));
    }

    #[test]
    fn not_images() {
        assert_eq!(sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), None);
        assert_eq!(sniff_image(b"plain text"), None);
        assert_eq!(plain_content_type(Some("text/html"), "x.html"), "application/octet-stream");
        assert_eq!(plain_content_type(Some("image/png"), "x.png"), "application/octet-stream");
        assert_eq!(plain_content_type(Some("application/pdf"), "a.pdf"), "application/pdf");
        assert_eq!(plain_content_type(None, "notes.txt"), "text/plain");
    }

    #[test]
    fn filenames_are_cleaned() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\dir\\pic.png"), "pic.png");
        assert_eq!(sanitize_filename("  "), "file");
        assert_eq!(encode_filename("a b.png"), "a%20b.png");
    }
}
