//! Desktop-shell preferences. They live on the Rust side (a small JSON file in the config dir) because
//! close-to-tray and start-minimized are decided before the webview has loaded.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Command-line argument the autostart entry launches Vokko with.
pub const AUTOSTART_ARG: &str = "--autostart";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPrefs {
    /// Closing the window hides it to the tray instead of quitting (Discord's default).
    pub close_to_tray: bool,
    /// When launched by the autostart entry, stay in the tray instead of showing the window.
    pub start_minimized: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self { close_to_tray: true, start_minimized: false }
    }
}

/// A partial update; absent fields keep their current value.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsPatch {
    pub close_to_tray: Option<bool>,
    pub start_minimized: Option<bool>,
}

impl DesktopPrefs {
    fn patched(self, patch: PrefsPatch) -> Self {
        Self { close_to_tray: patch.close_to_tray.unwrap_or(self.close_to_tray), start_minimized: patch.start_minimized.unwrap_or(self.start_minimized) }
    }
}

pub struct PrefsStore {
    path: Option<PathBuf>,
    value: Mutex<DesktopPrefs>,
}

impl PrefsStore {
    /// Loads the file at `path`; a missing or unreadable file yields the defaults.
    pub fn load(path: Option<PathBuf>) -> Self {
        let value =
            path.as_ref().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<DesktopPrefs>(&bytes).ok()).unwrap_or_default();
        Self { path, value: Mutex::new(value) }
    }

    pub fn get(&self) -> DesktopPrefs {
        self.value.lock().map(|value| *value).unwrap_or_default()
    }

    /// Applies `patch`, persists the result and returns it. The in-memory value changes even if the write fails.
    pub fn update(&self, patch: PrefsPatch) -> Result<DesktopPrefs, String> {
        let next = {
            let mut value = self.value.lock().map_err(|_| "preferences unavailable".to_owned())?;
            *value = value.patched(patch);
            *value
        };
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
            }
            let json = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
            std::fs::write(path, json).map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_discord() {
        let prefs = DesktopPrefs::default();
        assert!(prefs.close_to_tray);
        assert!(!prefs.start_minimized);
    }

    #[test]
    fn patch_changes_only_given_fields() {
        let store = PrefsStore::load(None);
        let next = store.update(PrefsPatch { start_minimized: Some(true), ..PrefsPatch::default() }).unwrap();
        assert!(next.close_to_tray);
        assert!(next.start_minimized);
        assert_eq!(store.get(), next);
    }

    #[test]
    fn persists_and_reloads() {
        let dir = std::env::temp_dir().join(format!("vokko-prefs-{}", std::process::id()));
        let path = dir.join("desktop.json");
        let store = PrefsStore::load(Some(path.clone()));
        store.update(PrefsPatch { close_to_tray: Some(false), start_minimized: Some(true) }).unwrap();
        let reloaded = PrefsStore::load(Some(path));
        assert_eq!(reloaded.get(), DesktopPrefs { close_to_tray: false, start_minimized: true });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("vokko-prefs-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(PrefsStore::load(Some(path)).get(), DesktopPrefs::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}
