//! Desktop infrastructure, kept out of the engine.
pub mod app_dirs;
pub mod logging;

use std::io::Write;
use std::path::Path;

/// Replaces `path` with `bytes` so a crash or power loss mid-write leaves either the old file or the new one, never a
/// truncated mix: the bytes go to a sibling `.tmp` file, are synced, then renamed over the target (std's rename replaces an
/// existing file on Windows too). A leftover `.tmp` from an interrupted write is harmless; the next write replaces it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let result =
        std::fs::File::create(&tmp).and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all())).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("vokko-write-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        write_atomic(&path, b"first, and longer").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert!(!dir.join("state.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
