//! Main-window helpers shared by the tray, single-instance and deep-link paths.

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
