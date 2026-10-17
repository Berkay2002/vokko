//! macOS-only shell pieces: the native menu bar, Dock reopen and the Dock bounce. The Dock badge is driven from the webview
//! through the window API (`src/notify/badge.ts`), so nothing needs unsafe code here.
//!
//! Custom menu items emit [`MENU_EVENT`] with an action name; the webview maps it onto an action it already has
//! (`src/shell/NativeMenuBridge.tsx`). Nothing happens in Rust beyond bringing the window forward.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, UserAttentionType};

pub const MENU_EVENT: &str = "desktop-menu";

const ID_SETTINGS: &str = "mac-settings";
const ID_QUICK_SWITCHER: &str = "mac-quick-switcher";
const ID_INBOX: &str = "mac-inbox";
const ID_HELP: &str = "mac-help";
const ID_SHORTCUTS: &str = "mac-shortcuts";
const ID_REPORT_PROBLEM: &str = "mac-report-problem";
#[cfg(debug_assertions)]
const ID_RELOAD: &str = "mac-reload";

/// Menu item id -> the action name the webview receives. Ids are prefixed so they can never match the tray's.
const ACTIONS: [(&str, &str); 6] = [
    (ID_SETTINGS, "settings"),
    (ID_QUICK_SWITCHER, "quick-switcher"),
    (ID_INBOX, "inbox"),
    (ID_HELP, "help"),
    (ID_SHORTCUTS, "shortcuts"),
    (ID_REPORT_PROBLEM, "report-problem"),
];

fn action_for(id: &str) -> Option<&'static str> {
    ACTIONS.iter().find(|(item, _)| *item == id).map(|(_, action)| *action)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<(Menu<R>, Submenu<R>, Submenu<R>)> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata { name: Some(name.clone()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let separator = || PredefinedMenuItem::separator(app);

    let settings = MenuItem::with_id(app, ID_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {name}")), Some(about))?,
            &separator()?,
            &settings,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // The app has no zoom setting, so View carries full screen (and Reload in debug builds) only.
    let view = Submenu::new(app, "View", true)?;
    view.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
    #[cfg(debug_assertions)]
    {
        view.append(&separator()?)?;
        view.append(&MenuItem::with_id(app, ID_RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?)?;
    }

    // No accelerators on the two below: the webview already handles Cmd+K and Cmd+I, and a menu key equivalent would swallow them.
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[&MenuItem::with_id(app, ID_QUICK_SWITCHER, "Quick Switcher…", true, None::<&str>)?, &MenuItem::with_id(app, ID_INBOX, "Inbox", true, None::<&str>)?],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::close_window(app, None)?,
            &separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, ID_HELP, format!("{name} Help"), true, None::<&str>)?,
            &MenuItem::with_id(app, ID_SHORTCUTS, "Keyboard Shortcuts", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ID_REPORT_PROBLEM, "Report a Problem…", true, None::<&str>)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit, &view, &go, &window, &help])?;
    Ok((menu, window, help))
}

/// Installs the menu bar, wires its events and logs what was built (the only readback available without Accessibility access).
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (menu, window, help) = build_menu(app)?;
    app.set_menu(menu.clone())?;
    window.set_as_windows_menu_for_nsapp()?;
    help.set_as_help_menu_for_nsapp()?;
    app.on_menu_event(on_menu_event);

    let titles: Vec<String> = menu
        .items()?
        .iter()
        .filter_map(|item| item.as_submenu().map(|sub| format!("{} ({})", sub.text().unwrap_or_default(), sub.items().map(|items| items.len()).unwrap_or(0))))
        .collect();
    log::info!("macOS menu bar: {}", titles.join(", "));
    #[cfg(debug_assertions)]
    debug_watch_dock(app);
    if let Some(window) = app.get_webview_window(crate::window::MAIN_WINDOW) {
        log::info!("main window decorated: {:?}", window.is_decorated());
    }
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    #[cfg(debug_assertions)]
    if id == ID_RELOAD {
        if let Some(webview) = app.get_webview_window(crate::window::MAIN_WINDOW)
            && let Err(error) = webview.reload()
        {
            log::warn!("cannot reload: {error}");
        }
        return;
    }
    let Some(action) = action_for(id) else {
        return;
    };
    // The window may be hidden in the tray; the action is pointless without it.
    crate::window::show_main(app);
    if let Err(error) = app.emit(MENU_EVENT, action) {
        log::warn!("cannot deliver menu action {action}: {error}");
    }
}

/// Bounces the Dock icon once. The webview has already decided it is warranted (a mention or DM that passes the notification
/// prefs, window in the background); macOS ignores the request while the app is active.
#[tauri::command]
pub fn desktop_request_attention(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(crate::window::MAIN_WINDOW).ok_or_else(|| "main window is gone".to_owned())?;
    log::info!("Dock bounce requested");
    window.request_user_attention(Some(UserAttentionType::Informational)).map_err(|error| error.to_string())
}

/// Debug builds only: `VOKKO_DEBUG_DOCK=1` logs the Dock tile's badge label whenever it changes. Screen capture is not always
/// available, and this reads back what AppKit really holds instead of what the webview believes it sent.
#[cfg(debug_assertions)]
fn debug_watch_dock<R: Runtime>(app: &AppHandle<R>) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use std::sync::{Arc, Mutex};

    if std::env::var_os("VOKKO_DEBUG_DOCK").is_none() {
        return;
    }
    let app = app.clone();
    let last: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let last = last.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let label = NSApplication::sharedApplication(mtm).dockTile().badgeLabel().map(|label| label.to_string());
                if let Ok(mut last) = last.lock()
                    && *last != label
                {
                    log::info!("Dock badge label: {label:?}");
                    *last = label;
                }
            });
        }
    });
}

/// Clicking the Dock icon with no visible window (hidden to the tray, or minimized) brings the window back.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
        crate::window::show_main(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray;

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(action_for(ID_SETTINGS), Some("settings"));
        assert_eq!(action_for(ID_QUICK_SWITCHER), Some("quick-switcher"));
        assert_eq!(action_for(ID_HELP), Some("help"));
        assert_eq!(action_for("unknown"), None);
    }

    #[test]
    fn ids_and_actions_are_distinct_and_do_not_collide_with_the_tray() {
        let tray_ids = [tray::MENU_OPEN, tray::MENU_MUTE, tray::MENU_DEAFEN, tray::MENU_QUIT];
        for (i, (id, action)) in ACTIONS.iter().enumerate() {
            assert!(!tray_ids.contains(id), "{id} collides with a tray id");
            assert!(ACTIONS.iter().skip(i + 1).all(|(other, other_action)| other != id && other_action != action));
        }
    }
}
