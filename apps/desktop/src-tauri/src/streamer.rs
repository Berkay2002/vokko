//! Streamer mode helpers: detecting running streaming software (auto-enable) and keeping the window out of screen captures.
//! The process list is read without extra dependencies: /proc on Linux, `tasklist` on Windows, `ps` on macOS.

use tauri::{AppHandle, Manager};

use crate::window::MAIN_WINDOW;

/// Lower-case process names (or name prefixes) of common streaming and recording software.
const STREAMING_SOFTWARE: &[&str] =
    &["obs", "obs64", "obs32", "obs-studio", "streamlabs obs", "streamlabs", "xsplit.core", "xsplitbroadcaster", "twitchstudio", "prismlivestudio", "vmix64"];

/// True when `name` (a process image name) belongs to streaming software.
pub fn is_streaming_process(name: &str) -> bool {
    let name = name.trim().trim_matches('"').to_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    STREAMING_SOFTWARE.iter().any(|known| stem == *known || (known.len() > 3 && stem.starts_with(known)))
}

#[cfg(target_os = "linux")]
fn process_names() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()))
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("comm")).ok())
        .map(|name| name.trim().to_owned())
        .collect()
}

#[cfg(windows)]
fn process_names() -> Vec<String> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(output) = std::process::Command::new("tasklist").args(["/FO", "CSV", "/NH"]).creation_flags(CREATE_NO_WINDOW).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| line.split(',').next()).map(|name| name.trim_matches('"').to_owned()).collect()
}

#[cfg(target_os = "macos")]
fn process_names() -> Vec<String> {
    let Ok(output) = std::process::Command::new("ps").args(["-axco", "command"]).output() else { return Vec::new() };
    String::from_utf8_lossy(&output.stdout).lines().skip(1).map(|line| line.trim().to_owned()).collect()
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn process_names() -> Vec<String> {
    Vec::new()
}

/// Whether OBS or other streaming software is running right now.
#[tauri::command]
pub async fn desktop_streaming_software_running() -> bool {
    tauri::async_runtime::spawn_blocking(|| process_names().iter().any(|name| is_streaming_process(name))).await.unwrap_or(false)
}

/// Keeps the main window out of screen captures and recordings (content protection) while `hidden`.
#[tauri::command]
pub fn desktop_set_capture_hidden(app: AppHandle, hidden: bool) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or_else(|| "main window not found".to_owned())?;
    window.set_content_protected(hidden).map_err(|error| error.to_string())
}

/// Restarts Vokko (Settings > Advanced > hardware acceleration takes effect on the next start).
#[tauri::command]
pub fn desktop_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_streaming_software() {
        for name in ["obs64.exe", "obs", "\"obs64.exe\"", "Streamlabs OBS.exe", "XSplit.Core.exe", "TwitchStudio.exe"] {
            assert!(is_streaming_process(name), "{name}");
        }
        for name in ["obsidian-helper", "bash", "firefox", "observer.exe", "explorer.exe"] {
            assert!(!is_streaming_process(name), "{name}");
        }
    }
}
