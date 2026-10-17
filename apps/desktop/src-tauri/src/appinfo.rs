//! Display name and icon of a detected or added app, for rich presence. The webview names a running executable (`chrome.exe`); the
//! path is looked up here from the process list and never leaves this module: only the name and a PNG of the icon go back.
//! Windows reads the exe's version info and embedded icon, macOS the enclosing `.app` bundle, Linux gives the name only.

#[cfg(any(windows, target_os = "macos"))]
use base64::Engine as _;
use serde::Serialize;
use std::path::Path;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    /// "Google Chrome": the file description (Windows) or bundle name (macOS), else the executable name without `.exe`.
    pub name: String,
    /// The icon as a base64 PNG, absent when it could not be read (and always on Linux). The server resizes it to 64x64.
    pub icon: Option<String>,
}

/// First non-blank of the primary and secondary name (Windows: `FileDescription`, `ProductName`; macOS: `CFBundleDisplayName`,
/// `CFBundleName`), else `stem`.
#[cfg(any(windows, target_os = "macos", test))]
fn display_name(primary: Option<String>, secondary: Option<String>, stem: &str) -> String {
    [primary, secondary].into_iter().flatten().map(|name| name.trim().to_owned()).find(|name| !name.is_empty()).unwrap_or_else(|| stem.to_owned())
}

/// Opaque pixels have alpha 255. Icons without an alpha channel (older ones, most hand-made) mark their shape with a second
/// 1-bit-style bitmap instead: its black pixels are the icon, its white ones the background. `bgra` is 4 bytes per pixel, `mask` the same
/// layout (only the red byte counts). Returns RGBA.
#[cfg(any(windows, test))]
fn bgra_to_rgba(bgra: &[u8], mask: Option<&[u8]>) -> Vec<u8> {
    let has_alpha = bgra.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0);
    let mut out = Vec::with_capacity(bgra.len());
    for (index, pixel) in bgra.as_chunks::<4>().0.iter().enumerate() {
        let alpha = if has_alpha {
            pixel[3]
        } else {
            match mask.and_then(|mask| mask.get(index * 4 + 2)) {
                Some(red) if *red != 0 => 0,
                _ => 255,
            }
        };
        out.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
    }
    out
}

#[cfg(windows)]
fn read(path: &Path, stem: &str) -> AppInfo {
    let meta = win::read(path);
    let icon = meta.icon.and_then(|raw| {
        let rgba = bgra_to_rgba(&raw.bgra, raw.mask.as_deref());
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, raw.width, raw.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
        Some(base64::engine::general_purpose::STANDARD.encode(out))
    });
    AppInfo { name: display_name(meta.description, meta.product, stem), icon }
}

#[cfg(target_os = "macos")]
fn read(path: &Path, stem: &str) -> AppInfo {
    let meta = mac::read(path);
    AppInfo { name: display_name(meta.display_name, meta.name, stem), icon: meta.icon_png.map(|png| base64::engine::general_purpose::STANDARD.encode(png)) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn read(_path: &Path, stem: &str) -> AppInfo {
    AppInfo { name: stem.to_owned(), icon: None }
}

/// The name and icon of the running executable called `exe` (a file name as the process list gives it). `None` when no such process
/// is running or the OS hides where it lives. Runs off the main thread: it walks the process list and decodes an icon.
#[tauri::command]
pub async fn desktop_app_info(exe: String) -> Result<Option<AppInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::games::running_exe_path(&exe)?;
        let stem = path.file_stem()?.to_string_lossy().into_owned();
        Some(read(&path, &stem))
    })
    .await
    .map_err(|error| format!("cannot read app info: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_falls_back_from_description_to_product_to_file_stem() {
        let some = |text: &str| Some(text.to_owned());
        assert_eq!(display_name(some("Google Chrome"), some("Chrome"), "chrome"), "Google Chrome");
        assert_eq!(display_name(None, some("Claude"), "claude"), "Claude");
        assert_eq!(display_name(some("   "), some("Claude"), "claude"), "Claude", "a blank description does not count");
        assert_eq!(display_name(some(""), None, "claude"), "claude");
        assert_eq!(display_name(None, None, "eldenring"), "eldenring");
    }

    #[test]
    fn pixels_become_rgba_with_alpha_from_the_icon_or_its_mask() {
        // one translucent blue pixel (B=200 G=100 R=50 A=128): the alpha channel wins and the mask is ignored
        assert_eq!(bgra_to_rgba(&[200, 100, 50, 128], Some(&[255, 255, 255, 0])), [50, 100, 200, 128]);
        // no alpha anywhere: a black mask pixel is the icon (opaque), a white one the background (clear)
        assert_eq!(bgra_to_rgba(&[200, 100, 50, 0, 1, 2, 3, 0], Some(&[0, 0, 0, 0, 255, 255, 255, 0])), [50, 100, 200, 255, 3, 2, 1, 0]);
        // no alpha and no mask: opaque
        assert_eq!(bgra_to_rgba(&[200, 100, 50, 0], None), [50, 100, 200, 255]);
    }
}
