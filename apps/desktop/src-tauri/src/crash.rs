//! Rust panics for the crash reporter: a panic hook writes the panic to `crash-pending.json` in the config dir (the process may be
//! about to die, so nothing is sent from here), and the webview takes it on its next start with `desktop_take_crash` and posts it
//! to `/crash-reports` if the user allows crash reports (src/report/crashReporter.ts). Only the latest panic is kept.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

const FILE: &str = "crash-pending.json";
const MAX_MESSAGE: usize = 1000;
const MAX_BACKTRACE: usize = 12_000;

static PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCrash {
    pub message: String,
    pub location: String,
    pub backtrace: String,
    pub version: String,
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn payload_text(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    payload.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".to_owned())
}

/// Installs the hook (the previous one still runs, so the panic is logged and printed as before).
pub fn install(config_dir: Option<PathBuf>) {
    let Some(dir) = config_dir else { return };
    if PATH.set(dir.join(FILE)).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let crash = PendingCrash {
            message: cut(&payload_text(info), MAX_MESSAGE),
            location: info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default(),
            backtrace: cut(&std::backtrace::Backtrace::force_capture().to_string(), MAX_BACKTRACE),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        if let (Some(path), Ok(json)) = (PATH.get(), serde_json::to_vec(&crash)) {
            let _ = vokko_platform::write_atomic(path, &json);
        }
        previous(info);
    }));
}

/// The panic saved by an earlier run, removed from disk so it is sent once.
#[tauri::command]
pub fn desktop_take_crash() -> Option<PendingCrash> {
    let path = PATH.get()?;
    let bytes = std::fs::read(path).ok()?;
    let _ = std::fs::remove_file(path);
    serde_json::from_slice(&bytes).ok()
}
