//! Main-window helpers shared by the tray, single-instance and deep-link paths.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

pub const MAIN_WINDOW: &str = "main";

/// Shows, un-minimizes and focuses the main window (it may be hidden in the tray).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(error) = window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus()) {
        log::warn!("cannot show the main window: {error}");
    }
}

/// Whether the page draws the minimize / maximize / close buttons itself. macOS keeps its native traffic lights; elsewhere the
/// OS frame is removed at startup and the title bar in the page takes over (with `data-tauri-drag-region` for dragging).
pub const fn custom_controls() -> bool {
    !cfg!(target_os = "macos")
}

/// Removes the OS title bar on platforms where the page draws its own. Call before the window is first shown.
pub fn use_custom_controls<R: Runtime>(app: &AppHandle<R>) {
    if !custom_controls() {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(error) = window.set_decorations(false) {
        log::warn!("cannot remove the window frame: {error}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChrome {
    /// The page draws the window buttons.
    pub custom_controls: bool,
    /// `windows`, `macos` or `linux`.
    pub platform: &'static str,
}

#[tauri::command]
pub fn desktop_window_chrome() -> WindowChrome {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    WindowChrome { custom_controls: custom_controls(), platform }
}
