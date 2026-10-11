//! Global shortcut registry. Nothing is registered by default; the voice round binds push-to-talk
//! through these commands and listens for `desktop-shortcut` events (`pressed` then `released`).
//!
//! Limits of the OS hotkey APIs: a shortcut needs a non-modifier key, and mouse buttons can't be bound.

use serde::Serialize;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const SHORTCUT_EVENT: &str = "desktop-shortcut";
const MAX_ID_LEN: usize = 64;

#[derive(Default)]
pub struct ShortcutRegistry {
    /// binding id → accelerator string as given by the caller
    entries: Mutex<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShortcutBinding {
    pub id: String,
    pub accelerator: String,
}

#[derive(Clone, Serialize)]
struct ShortcutEvent {
    id: String,
    state: &'static str,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// Binds `accelerator` (e.g. `"Ctrl+Shift+K"`, `"F13"`) to `id`, replacing any earlier binding of that id.
#[tauri::command]
pub fn desktop_shortcut_register(app: AppHandle, registry: State<'_, ShortcutRegistry>, id: String, accelerator: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("shortcut id must be 1-64 characters of letters, digits, '-', '_', '.' or ':'".to_owned());
    }
    let shortcut = Shortcut::from_str(&accelerator).map_err(|error| format!("invalid accelerator {accelerator:?}: {error}"))?;
    let mut entries = registry.entries.lock().map_err(|_| "shortcut registry unavailable".to_owned())?;
    let previous = entries.get(&id).and_then(|previous| Shortcut::from_str(previous).ok());
    if previous == Some(shortcut) {
        // Same accelerator re-registered under the same id: its handler is already in place.
        entries.insert(id, accelerator);
        return Ok(());
    }
    if let Some(old) = previous {
        app.global_shortcut().unregister(old).map_err(|error| error.to_string())?;
        entries.remove(&id);
    }
    let event_id = id.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            let state = match event.state {
                ShortcutState::Pressed => "pressed",
                ShortcutState::Released => "released",
            };
            if let Err(error) = app.emit(SHORTCUT_EVENT, ShortcutEvent { id: event_id.clone(), state }) {
                log::warn!("cannot emit shortcut event: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    entries.insert(id, accelerator);
    Ok(())
}

#[tauri::command]
pub fn desktop_shortcut_unregister(app: AppHandle, registry: State<'_, ShortcutRegistry>, id: String) -> Result<(), String> {
    let mut entries = registry.entries.lock().map_err(|_| "shortcut registry unavailable".to_owned())?;
    if let Some(accelerator) = entries.remove(&id) {
        let shortcut = Shortcut::from_str(&accelerator).map_err(|error| error.to_string())?;
        app.global_shortcut().unregister(shortcut).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_shortcut_list(registry: State<'_, ShortcutRegistry>) -> Vec<ShortcutBinding> {
    match registry.entries.lock() {
        Ok(entries) => entries.iter().map(|(id, accelerator)| ShortcutBinding { id: id.clone(), accelerator: accelerator.clone() }).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_restricted() {
        assert!(valid_id("push-to-talk"));
        assert!(valid_id("voice:ptt.1"));
        assert!(!valid_id(""));
        assert!(!valid_id("has space"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn accelerators_parse() {
        assert!(Shortcut::from_str("Ctrl+Shift+K").is_ok());
        assert!(Shortcut::from_str("F13").is_ok());
        assert!(Shortcut::from_str("Ctrl+Shift").is_err());
        assert!(Shortcut::from_str("").is_err());
    }
}
