//! Notification clicks. `tauri-plugin-notification` reports a click on a desktop notification once a handler exists
//! (macOS and Windows wait on the shown notification, Linux listens to the notification server). A click brings the
//! window forward and emits [`CLICK_EVENT`] with the notification id; the webview maps the id back to the channel it
//! named (`src/notify/desktop.ts`).

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt as _};

pub const CLICK_EVENT: &str = "desktop-notification-click";

/// The id of the notification whose body was clicked. Other actions (none are offered today) report nothing.
fn clicked(performed: &ActionPerformed) -> Option<i32> {
    (performed.action_id() == "tap").then(|| performed.notification().map(|notification| notification.id())).flatten()
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let result = app.notification().on_action(move |performed| {
        let Some(id) = clicked(performed) else {
            return;
        };
        crate::window::show_main(&handle);
        if let Err(error) = handle.emit(CLICK_EVENT, id) {
            log::warn!("cannot deliver a notification click: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("notification clicks unavailable: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn performed(value: serde_json::Value) -> ActionPerformed {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_tap_reports_the_notification_id() {
        let tap = performed(serde_json::json!({ "actionId": "tap", "inputValue": null, "notification": { "id": 42, "title": "#general" } }));
        assert_eq!(clicked(&tap), Some(42));
    }

    #[test]
    fn other_actions_and_unreadable_notifications_report_nothing() {
        let other = performed(serde_json::json!({ "actionId": "reply", "inputValue": null, "notification": { "id": 42 } }));
        assert_eq!(clicked(&other), None);
        let unreadable = performed(serde_json::json!({ "actionId": "tap", "inputValue": null, "notification": { "id": "x" } }));
        assert_eq!(clicked(&unreadable), None);
    }
}
