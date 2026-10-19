//! Auto-update: check, download in the background, then install on the user's "Restart" click.
//!
//! Inactive unless the build supplies the updater config (pubkey + endpoints, via the `TAURI_CONFIG`
//! environment variable at build time; see `docs/desktop-release.md`). The plugin is only registered in
//! that case, and every command answers `{ state: "disabled" }` otherwise. We drive `Update::download`
//! and `Update::install` ourselves (instead of `download_and_install`) because on Windows `install`
//! launches the installer and exits the app, which must only happen when the user asks for it.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATE_EVENT: &str = "desktop-update";
/// Name of the entry in `plugins` of the Tauri config that switches the updater on.
pub const CONFIG_KEY: &str = "updater";
/// Progress events are throttled to one per this many downloaded bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

/// `PackageManager` is a Linux .deb install: the manifest only carries the AppImage, so the package manager updates it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    Disabled,
    PackageManager,
    Idle,
    Checking,
    UpToDate,
    Available { version: String, notes: Option<String> },
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    Ready { version: String },
    Error { message: String },
}

struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}

pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<Pending>>,
}

/// Starting status: a build without updater config is disabled; on Linux only an AppImage (`$APPIMAGE` set) updates itself.
pub fn initial_status(configured: bool, linux_package: bool) -> UpdateStatus {
    match (configured, linux_package) {
        (false, _) => UpdateStatus::Disabled,
        (true, true) => UpdateStatus::PackageManager,
        (true, false) => UpdateStatus::Idle,
    }
}

impl UpdateState {
    pub fn new(status: UpdateStatus) -> Self {
        Self { status: Mutex::new(status), pending: Mutex::new(None) }
    }

    fn status(&self) -> UpdateStatus {
        self.status.lock().map(|status| status.clone()).unwrap_or(UpdateStatus::Disabled)
    }
}

fn set_status(app: &AppHandle, status: UpdateStatus) -> UpdateStatus {
    if let Ok(mut current) = app.state::<UpdateState>().status.lock() {
        *current = status.clone();
    }
    if let Err(error) = app.emit(UPDATE_EVENT, &status) {
        log::warn!("cannot emit update status: {error}");
    }
    status
}

fn fail(app: &AppHandle, error: impl std::fmt::Display) -> UpdateStatus {
    set_status(app, UpdateStatus::Error { message: error.to_string() })
}

#[tauri::command]
pub fn desktop_update_status(state: State<'_, UpdateState>) -> UpdateStatus {
    state.status()
}

/// Checks for an update and, when `download` is true (the default), downloads it in the same call.
#[tauri::command]
pub async fn desktop_update_check(app: AppHandle, state: State<'_, UpdateState>, download: Option<bool>) -> Result<UpdateStatus, String> {
    match state.status() {
        UpdateStatus::Disabled | UpdateStatus::PackageManager | UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Ready { .. } => {
            return Ok(state.status());
        }
        _ => {}
    }
    set_status(&app, UpdateStatus::Checking);
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return Ok(fail(&app, error)),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(set_status(&app, UpdateStatus::UpToDate)),
        Err(error) => return Ok(fail(&app, error)),
    };
    let version = update.version.clone();
    let available = UpdateStatus::Available { version: version.clone(), notes: update.body.clone() };
    if let Ok(mut pending) = state.pending.lock() {
        *pending = Some(Pending { update: update.clone(), bytes: None });
    }
    set_status(&app, available);
    if download.unwrap_or(true) {
        return Ok(download_update(&app, update, version).await);
    }
    Ok(state.status())
}

/// Downloads the update found by the last check (a no-op if there is none or it is already downloaded).
#[tauri::command]
pub async fn desktop_update_download(app: AppHandle, state: State<'_, UpdateState>) -> Result<UpdateStatus, String> {
    let update = match state.pending.lock() {
        Ok(pending) => pending.as_ref().filter(|pending| pending.bytes.is_none()).map(|pending| pending.update.clone()),
        Err(_) => None,
    };
    let Some(update) = update else {
        return Ok(state.status());
    };
    let version = update.version.clone();
    Ok(download_update(&app, update, version).await)
}

async fn download_update(app: &AppHandle, update: Update, version: String) -> UpdateStatus {
    set_status(app, UpdateStatus::Downloading { version: version.clone(), downloaded: 0, total: None });
    let (mut downloaded, mut emitted) = (0_u64, 0_u64);
    let result = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - emitted >= PROGRESS_STEP {
                    emitted = downloaded;
                    set_status(app, UpdateStatus::Downloading { version: version.clone(), downloaded, total });
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            if let Ok(mut pending) = app.state::<UpdateState>().pending.lock() {
                *pending = Some(Pending { update, bytes: Some(bytes) });
            }
            set_status(app, UpdateStatus::Ready { version })
        }
        Err(error) => fail(app, error),
    }
}

/// Installs the downloaded update and restarts. On Windows the installer takes over and the app exits.
#[tauri::command]
pub fn desktop_update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let (update, bytes) = {
        let mut pending = state.pending.lock().map_err(|_| "update state unavailable".to_owned())?;
        match pending.take() {
            Some(Pending { update, bytes: Some(bytes) }) => (update, bytes),
            other => {
                *pending = other;
                return Err("no downloaded update to install".to_owned());
            }
        }
    };
    if let Err(error) = update.install(bytes) {
        fail(&app, &error);
        return Err(error.to_string());
    }
    #[cfg(windows)]
    {
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deb_installs_leave_updates_to_the_package_manager() {
        assert_eq!(initial_status(false, true), UpdateStatus::Disabled);
        assert_eq!(initial_status(true, true), UpdateStatus::PackageManager);
        assert_eq!(initial_status(true, false), UpdateStatus::Idle);
        assert_eq!(serde_json::to_value(UpdateStatus::PackageManager).unwrap(), serde_json::json!({ "state": "packageManager" }));
    }
}
