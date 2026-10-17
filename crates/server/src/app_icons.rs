//! App icons for Playing activities. A client uploads the icon of the program it detected; the server decodes it, fits it onto a
//! transparent 64x64 canvas, re-encodes it with fixed settings and keeps those bytes under their SHA-256. The uploaded bytes are
//! never stored or served. An activity references the result as `assets.large_image = "app:<hash>"`.
use std::io::Cursor;

use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits, RgbaImage};
use sha2::{Digest, Sha256};
use vokko_protocol::api::Activity;

use crate::state::AppState;

/// Largest upload in bytes (a 256x256 icon is about 100 KiB).
pub const MAX_BYTES: usize = 128 * 1024;
/// Largest side of an uploaded image; the decoder refuses to allocate for anything bigger than the header says is fine.
const MAX_SIDE: u32 = 512;
const MAX_DECODE_BYTES: u64 = 4 * 1024 * 1024;
/// The stored icon is this many pixels on each side.
pub const SIZE: u32 = 64;
/// Distinct icons one user can add; re-uploading an icon that exists is free.
pub const MAX_PER_USER: i64 = 64;

/// The 64x64 PNG for an uploaded PNG, or `None` when the bytes are not a PNG within the limits. The format is never guessed.
pub fn normalize(upload: &[u8]) -> Option<Vec<u8>> {
    let mut reader = ImageReader::with_format(Cursor::new(upload), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let decoded = reader.decode().ok()?.to_rgba8();
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    // Fit inside the square without distorting, centred on a transparent canvas.
    let scale = f64::from(SIZE) / f64::from(width.max(height));
    let fitted_width = ((f64::from(width) * scale).round() as u32).clamp(1, SIZE);
    let fitted_height = ((f64::from(height) * scale).round() as u32).clamp(1, SIZE);
    let fitted = imageops::resize(&decoded, fitted_width, fitted_height, FilterType::Lanczos3);
    let mut canvas = RgbaImage::new(SIZE, SIZE);
    imageops::replace(&mut canvas, &fitted, i64::from((SIZE - fitted_width) / 2), i64::from((SIZE - fitted_height) / 2));
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Default, PngFilter::Adaptive).write_image(canvas.as_raw(), SIZE, SIZE, ExtendedColorType::Rgba8).ok()?;
    Some(out)
}

/// Lowercase hex SHA-256 of the stored bytes: the icon's address.
pub fn hash_of(png: &[u8]) -> String {
    Sha256::digest(png).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 64 lowercase hex digits.
pub fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Removes the `app:` image from activities whose icon the server does not have (the client may be ahead of an upload, or on
/// another server); the activity itself stays.
pub async fn drop_unknown(state: &AppState, list: &mut [Activity]) {
    let wanted: Vec<String> = list.iter().filter_map(|activity| activity.app_hash().map(str::to_owned)).collect();
    if wanted.is_empty() {
        return;
    }
    let known: Vec<(String,)> = sqlx::query_as("SELECT hash FROM app_icons WHERE hash = ANY($1)").bind(&wanted).fetch_all(&state.db).await.unwrap_or_default();
    for activity in list.iter_mut() {
        if activity.app_hash().is_some_and(|hash| !known.iter().any(|(stored,)| stored == hash)) {
            activity.assets = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, image::Rgba(color));
        let mut out = Vec::new();
        PngEncoder::new(&mut out).write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8).unwrap();
        out
    }

    #[test]
    fn output_is_64_square_and_deterministic() {
        let stored = normalize(&png(256, 256, [200, 10, 10, 255])).unwrap();
        let decoded = image::load_from_memory_with_format(&stored, ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 64));
        assert_eq!(normalize(&png(256, 256, [200, 10, 10, 255])).unwrap(), stored);
        assert!(is_hash(&hash_of(&stored)));
    }

    #[test]
    fn wide_images_are_fitted_not_stretched() {
        let stored = normalize(&png(128, 32, [0, 0, 255, 255])).unwrap();
        let decoded = image::load_from_memory_with_format(&stored, ImageFormat::Png).unwrap().to_rgba8();
        assert_eq!(decoded.get_pixel(32, 32).0[3], 255, "the middle is the image");
        assert_eq!(decoded.get_pixel(32, 2).0[3], 0, "the top margin is transparent");
    }

    #[test]
    fn only_small_pngs_decode() {
        assert!(normalize(b"GIF89a....").is_none());
        assert!(normalize(&[]).is_none());
        assert!(normalize(&png(513, 8, [0, 0, 0, 255])).is_none(), "wider than the limit");
        let mut cut = png(64, 64, [1, 2, 3, 255]);
        cut.truncate(cut.len() / 2);
        assert!(normalize(&cut).is_none());
    }

    #[test]
    fn hashes_are_64_lowercase_hex() {
        assert!(is_hash(&"ab01".repeat(16)));
        for bad in ["", "ab", &"AB01".repeat(16), &"ab01".repeat(17), &format!("{}g", "a".repeat(63))] {
            assert!(!is_hash(bad), "{bad}");
        }
    }
}
