//! System tray: Open / Mute / Deafen / Quit menu, click-to-open, and an unread dot composited onto the icon.

use crate::appicon::{self, Variant};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "vokko-main";
const TOOLTIP: &str = "Vokko";
const TOOLTIP_UNREAD: &str = "Vokko: unread messages";
/// Discord's "danger" red, used for the unread dot.
const DOT_RGB: [u8; 3] = [0xed, 0x42, 0x45];

pub const MENU_OPEN: &str = "open";
pub const MENU_MUTE: &str = "mute";
pub const MENU_DEAFEN: &str = "deafen";
pub const MENU_QUIT: &str = "quit";

/// Whether a tray icon exists (close-to-tray only makes sense then) and the last unread state shown.
#[derive(Default)]
pub struct TrayState {
    inner: Mutex<TrayFlags>,
}

#[derive(Default)]
struct TrayFlags {
    present: bool,
    unread: bool,
    /// The app icon the user picked; the default one until the webview says otherwise.
    variant: Option<&'static Variant>,
}

impl TrayState {
    pub fn present(&self) -> bool {
        self.inner.lock().map(|flags| flags.present).unwrap_or(false)
    }

    fn set_present(&self, present: bool) {
        if let Ok(mut flags) = self.inner.lock() {
            flags.present = present;
        }
    }

    /// Records the new unread state; returns whether it changed.
    fn set_unread(&self, unread: bool) -> bool {
        match self.inner.lock() {
            Ok(mut flags) => std::mem::replace(&mut flags.unread, unread) != unread,
            Err(_) => false,
        }
    }

    fn variant(&self) -> &'static Variant {
        self.inner.lock().ok().and_then(|flags| flags.variant).unwrap_or_else(appicon::default_variant)
    }

    fn set_variant(&self, variant: &'static Variant) {
        if let Ok(mut flags) = self.inner.lock() {
            flags.variant = Some(variant);
        }
    }

    fn unread(&self) -> bool {
        self.inner.lock().map(|flags| flags.unread).unwrap_or(false)
    }
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Vokko", true, None::<&str>)?;
    // Voice does not exist yet; the entries are in place so the menu has Discord's shape.
    let mute = MenuItem::with_id(app, MENU_MUTE, "Mute", false, None::<&str>)?;
    let deafen = MenuItem::with_id(app, MENU_DEAFEN, "Deafen", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Vokko", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &mute, &deafen, &separator, &quit])
}

/// Creates the tray icon. On failure the caller keeps close-to-tray off so the window can't be lost.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let menu = build_menu(app)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(app.state::<TrayState>().variant().tray)?)
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => crate::window::show_main(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::window::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    app.state::<TrayState>().set_present(true);
    Ok(tray)
}

/// Draws (or removes) the unread dot on the tray icon.
pub fn set_unread<R: Runtime>(app: &AppHandle<R>, unread: bool) -> Result<(), String> {
    let state = app.state::<TrayState>();
    if !state.present() || !state.set_unread(unread) {
        return Ok(());
    }
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| "tray icon is gone".to_owned())?;
    show(&tray, state.variant(), unread)?;
    tray.set_tooltip(Some(if unread { TOOLTIP_UNREAD } else { TOOLTIP })).map_err(|error| error.to_string())
}

/// Switches the tray icon to another app icon variant, keeping the unread dot as it is.
pub fn set_variant<R: Runtime>(app: &AppHandle<R>, variant: &'static Variant) -> Result<(), String> {
    let state = app.state::<TrayState>();
    state.set_variant(variant);
    if !state.present() {
        return Ok(());
    }
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| "tray icon is gone".to_owned())?;
    show(&tray, variant, state.unread())
}

fn show<R: Runtime>(tray: &TrayIcon<R>, variant: &Variant, unread: bool) -> Result<(), String> {
    let base = Image::from_bytes(variant.tray).map_err(|error| error.to_string())?;
    let icon = if unread {
        let mut rgba = base.rgba().to_vec();
        overlay_dot(&mut rgba, base.width(), base.height());
        Image::new_owned(rgba, base.width(), base.height())
    } else {
        base
    };
    tray.set_icon(Some(icon)).map_err(|error| error.to_string())
}

/// Composites an anti-aliased red dot over the bottom-right of an RGBA buffer.
fn overlay_dot(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as f32, height as f32);
    let (cx, cy, radius) = (w * 0.72, h * 0.72, w * 0.25);
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }
            let at = ((y * width + x) * 4) as usize;
            let Some(pixel) = rgba.get_mut(at..at + 4) else {
                continue;
            };
            for (channel, dot) in pixel.iter_mut().zip(DOT_RGB) {
                *channel = (f32::from(dot) * coverage + f32::from(*channel) * (1.0 - coverage)).round() as u8;
            }
            let alpha = f32::from(pixel[3]).max(coverage * 255.0);
            pixel[3] = alpha.round() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_is_red_at_its_centre_and_leaves_the_far_corner_alone() {
        let (w, h) = (32_u32, 32_u32);
        let mut rgba = vec![0_u8; (w * h * 4) as usize];
        overlay_dot(&mut rgba, w, h);
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(at(23, 23), [DOT_RGB[0], DOT_RGB[1], DOT_RGB[2], 255]);
        assert_eq!(at(0, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn menu_ids_are_distinct() {
        let ids = [MENU_OPEN, MENU_MUTE, MENU_DEAFEN, MENU_QUIT];
        for (i, a) in ids.iter().enumerate() {
            assert!(ids.iter().skip(i + 1).all(|b| a != b));
        }
    }
}
