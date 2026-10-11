//! Custom app icons: the variant the user picked in Appearance is applied to the window/taskbar icon, the tray icon
//! (with its unread dot, see tray.rs) and the macOS Dock. The art is rasterized from `assets/app-icons/*.svg` by
//! `npm run app-icons` into `icons/app/`.

use crate::tray;
use tauri::image::Image;
use tauri::{AppHandle, Manager, Runtime};

/// One icon variant: its id (the file stem in `assets/app-icons` and the value of the `appIcon` pref) and its rasters.
pub struct Variant {
    pub id: &'static str,
    /// 256 px, full bleed: window and taskbar.
    pub window: &'static [u8],
    /// 512 px with macOS's transparent inset: Dock (only embedded on macOS).
    #[cfg(target_os = "macos")]
    pub dock: &'static [u8],
    /// 64 px: tray (the unread dot is composited onto it).
    pub tray: &'static [u8],
}

macro_rules! variant {
    ($id:literal) => {
        Variant {
            id: $id,
            window: include_bytes!(concat!("../icons/app/", $id, "-256.png")),
            #[cfg(target_os = "macos")]
            dock: include_bytes!(concat!("../icons/app/", $id, "-dock.png")),
            tray: include_bytes!(concat!("../icons/app/", $id, "-64.png")),
        }
    };
}

/// Keep in sync with `src/appicon/variants.ts`; the first one is the default (the Rust test checks the list against the SVG sources).
pub static VARIANTS: [Variant; 8] = [
    variant!("default"),
    variant!("gradient"),
    variant!("flame"),
    variant!("pastel"),
    variant!("galaxy"),
    variant!("mono"),
    variant!("inverted"),
    variant!("outline"),
];

pub fn find(id: &str) -> Option<&'static Variant> {
    VARIANTS.iter().find(|variant| variant.id == id)
}

pub fn default_variant() -> &'static Variant {
    &VARIANTS[0]
}

/// Applies the variant with this id everywhere the platform allows. Unknown ids are rejected (the webview never sends one).
#[tauri::command]
pub fn desktop_set_app_icon(app: AppHandle, id: String) -> Result<(), String> {
    let variant = find(&id).ok_or_else(|| format!("unknown app icon: {id}"))?;
    apply(&app, variant)
}

fn apply<R: Runtime>(app: &AppHandle<R>, variant: &'static Variant) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(crate::window::MAIN_WINDOW) {
        let icon = Image::from_bytes(variant.window).map_err(|error| error.to_string())?;
        window.set_icon(icon).map_err(|error| error.to_string())?;
    }
    tray::set_variant(app, variant)?;
    log::info!("app icon: {}", variant.id);
    #[cfg(target_os = "macos")]
    dock::set(app, variant);
    Ok(())
}

/// Dock icon. `NSApplication.setApplicationIconImage` is an `unsafe` binding (the workspace forbids unsafe code), so the
/// icon is put on the Dock tile instead: an image view as its content view, which is how a running app draws its own tile.
/// Cmd+Tab and the Dock entry of a not running app keep the bundle icon.
#[cfg(target_os = "macos")]
mod dock {
    use super::Variant;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage, NSImageScaling, NSImageView};
    use objc2_foundation::NSData;
    use tauri::{AppHandle, Runtime};

    pub fn set<R: Runtime>(app: &AppHandle<R>, variant: &'static Variant) {
        let dock = variant.dock;
        let reset = std::ptr::eq(variant, super::default_variant());
        let result = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let tile = NSApplication::sharedApplication(mtm).dockTile();
            if reset {
                // The default variant is the bundle icon: drop the custom view so the Dock draws the real one again.
                tile.setContentView(None);
            } else {
                let data = NSData::with_bytes(dock);
                let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
                    log::warn!("cannot decode the Dock icon");
                    return;
                };
                let view = NSImageView::imageViewWithImage(&image, mtm);
                view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
                // The view starts at the image's natural size (512 pt), the tile is about 128 pt: fit it, or the Dock crops the art.
                view.setFrameSize(tile.size());
                tile.setContentView(Some(&view));
            }
            tile.display();
        });
        if let Err(error) = result {
            log::warn!("cannot update the Dock icon: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    /// Width of a PNG (IHDR is the first chunk).
    fn png_width(bytes: &[u8]) -> Option<u32> {
        let is_png = bytes.get(..8)? == b"\x89PNG\r\n\x1a\n";
        let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
        is_png.then_some(width)
    }

    #[test]
    fn ids_parse_and_unknown_ids_are_rejected() {
        assert_eq!(find("flame").map(|variant| variant.id), Some("flame"));
        assert_eq!(default_variant().id, "default");
        assert!(find("").is_none());
        assert!(find("Flame").is_none());
        assert!(find("../default").is_none());
    }

    #[test]
    fn variants_match_the_svg_sources() -> Result<(), Box<dyn Error>> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/app-icons");
        let mut stems = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "svg")
                && let Some(stem) = path.file_stem().and_then(|stem| stem.to_str())
            {
                stems.push(stem.to_owned());
            }
        }
        stems.sort();
        let mut ids: Vec<String> = VARIANTS.iter().map(|variant| variant.id.to_owned()).collect();
        ids.sort();
        assert_eq!(stems, ids);
        Ok(())
    }

    #[test]
    fn rasters_are_pngs_of_the_expected_size() {
        for variant in &VARIANTS {
            assert_eq!(png_width(variant.window), Some(256), "{} window", variant.id);
            #[cfg(target_os = "macos")]
            assert_eq!(png_width(variant.dock), Some(512), "{} dock", variant.id);
            assert_eq!(png_width(variant.tray), Some(64), "{} tray", variant.id);
        }
    }
}
