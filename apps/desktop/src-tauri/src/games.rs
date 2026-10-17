//! Running-process listing for game detection and rich presence. Matching against the detectable-games list happens in the
//! webview (`src/desktop/games.ts`), so the list stays a plain JSON file anyone can edit. Only names and start times leave
//! this module: no command lines, paths or window titles.

use serde::Serialize;
use std::collections::BTreeMap;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// A running executable. Several processes with the same name are folded into one (the oldest start wins).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProcess {
    /// Executable file name as the OS reports it, e.g. `eldenring.exe`.
    pub name: String,
    /// Unix time in milliseconds when the process started; 0 if the OS did not say.
    pub started_at: u64,
    /// Lives in an operating-system directory, so it is never a game (hidden from the "Add it!" list).
    pub system: bool,
    /// The OS let us read where the executable lives. Programs of other users and services are not readable, so the "Add it!" list
    /// hides them; matching still works (anti-cheat protected games are unreadable too).
    pub path_known: bool,
}

const SYSTEM_PREFIXES: &[&str] =
    &["/system/", "/usr/", "/bin/", "/sbin/", "/library/", "/lib/", "/opt/homebrew/", "c:/windows/", "c:/program files/windowsapps/"];

/// Whether `path` is inside an OS directory. Separators and case do not matter.
fn is_system_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    SYSTEM_PREFIXES.iter().any(|prefix| normalized.starts_with(prefix))
}

fn collect() -> Vec<RunningProcess> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    let mut found: BTreeMap<String, RunningProcess> = BTreeMap::new();
    let own_pid = std::process::id();
    for process in system.processes().values() {
        let name = process.name().to_string_lossy().trim().to_owned();
        if name.is_empty() {
            continue;
        }
        let started_at = process.start_time().saturating_mul(1000);
        let exe = process.exe().and_then(|exe| exe.to_str());
        // Vokko itself is never a game.
        let system_dir = process.pid().as_u32() == own_pid || exe.is_some_and(is_system_path);
        let path_known = exe.is_some();
        found
            .entry(name.to_lowercase())
            .and_modify(|existing| {
                if started_at != 0 && (existing.started_at == 0 || started_at < existing.started_at) {
                    existing.started_at = started_at;
                }
                existing.system &= system_dir;
                existing.path_known |= path_known;
            })
            .or_insert(RunningProcess { name, started_at, system: system_dir, path_known });
    }
    found.into_values().collect()
}

/// Where the running executable called `name` lives (case-insensitive). The path stays in Rust: `appinfo` reads the display name and
/// icon from it and hands only those to the webview.
pub fn running_exe_path(name: &str) -> Option<std::path::PathBuf> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    system
        .processes()
        .values()
        .find(|process| process.name().to_string_lossy().eq_ignore_ascii_case(name.trim()))
        .and_then(|process| process.exe().map(std::path::Path::to_path_buf))
}

/// Lists the running executables (de-duplicated by name). The refresh walks every process, so it runs off the main thread.
#[tauri::command]
pub async fn desktop_list_processes() -> Result<Vec<RunningProcess>, String> {
    tauri::async_runtime::spawn_blocking(collect).await.map_err(|error| format!("cannot list processes: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client (`RunningProcess` in src/desktop/games.ts) reads these exact keys; renaming one silently breaks detection.
    #[test]
    fn running_process_json_keys_are_the_ones_the_client_reads() {
        let process = RunningProcess { name: "eldenring.exe".into(), started_at: 1_700_000_000_000, system: false, path_known: true };
        let json = serde_json::to_value(&process).unwrap();
        assert_eq!(json, serde_json::json!({ "name": "eldenring.exe", "startedAt": 1_700_000_000_000u64, "system": false, "pathKnown": true }));
        let keys: std::collections::BTreeSet<_> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["name", "pathKnown", "startedAt", "system"].into_iter().collect());
    }

    #[test]
    fn system_directories_are_recognised() {
        assert!(is_system_path(r"C:\Windows\System32\svchost.exe"));
        assert!(is_system_path("c:/WINDOWS/explorer.exe"));
        assert!(is_system_path("/usr/bin/zsh"));
        assert!(!is_system_path(r"C:\Program Files (x86)\Steam\steamapps\common\Game\game.exe"));
        assert!(!is_system_path(r"E:\Games\Windows\game.exe"));
    }

    #[test]
    fn lists_this_process() {
        let me = std::env::current_exe().ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_lowercase()));
        let found = collect();
        assert!(!found.is_empty());
        if let Some(me) = me {
            let mine = found.iter().find(|process| process.name.to_lowercase() == me);
            assert!(mine.is_some_and(|process| process.started_at > 0), "own process with a start time: {mine:?}");
        }
    }
}
