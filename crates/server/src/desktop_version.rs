//! Tells connected clients about a new desktop release, so installed apps check for it within a minute instead of on their 4 h timer.
//! The source is the updater's `latest.json` in the downloads directory (`VOKKO_DESKTOP_LATEST_JSON`), read again every
//! `desktop_version_poll`; a new `version` is sent as DESKTOP_VERSION to every session and is part of READY from then on.
use vokko_protocol::api::{DesktopVersion, GatewayEvent};

use crate::state::AppState;

/// The version READY carries.
pub fn current(state: &AppState) -> Option<String> {
    state.desktop_version.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Reads `latest.json` once. A missing, half-written or invalid file keeps the last known version.
pub async fn refresh(state: &AppState) {
    let Some(path) = &state.config.desktop_latest_json else { return };
    let Ok(bytes) = tokio::fs::read(path).await else { return };
    let Some(version) = parse(&bytes) else { return };
    {
        let mut known = state.desktop_version.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if known.as_deref() == Some(version.as_str()) {
            return;
        }
        *known = Some(version.clone());
    }
    tracing::info!("desktop release {version} announced to connected clients");
    state.hub.send_all(&GatewayEvent::DesktopVersion(DesktopVersion { version }));
}

pub fn spawn(state: AppState) {
    if state.config.desktop_latest_json.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(state.config.desktop_version_poll);
        loop {
            interval.tick().await;
            refresh(&state).await;
        }
    });
}

/// `version` of a Tauri updater manifest, if it looks like a version (`0.1.9`, `v0.2.0-beta.1`).
fn parse(bytes: &[u8]) -> Option<String> {
    let manifest: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let version = manifest.get("version")?.as_str()?.trim();
    let valid = !version.is_empty() && version.len() <= 64 && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    valid.then(|| version.to_owned())
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_the_manifest_version() {
        assert_eq!(parse(br#"{"version":"0.1.9","notes":"x","platforms":{}}"#).as_deref(), Some("0.1.9"));
        assert_eq!(parse(br#"{"version":" v0.2.0-beta.1 "}"#).as_deref(), Some("v0.2.0-beta.1"));
        for bad in [&br#"{"version":""}"#[..], br#"{"version":"1.0 <b>"}"#, br#"{"version":1}"#, br#"{"versi"#, b""] {
            assert_eq!(parse(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }
}
