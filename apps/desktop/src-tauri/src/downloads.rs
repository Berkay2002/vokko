//! Downloads from the webview (`<a download>`, Save Image, a blob link): they go straight into the user's Downloads folder under a
//! cleaned-up name that never overwrites a file. Without this handler WKWebView and WebKitGTK save nowhere useful and WebView2 opens
//! its own save prompt. Only `http(s):`, `blob:` and `data:` sources are saved; `file:` and everything else is refused.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::webview::DownloadEvent;
use tauri::{Emitter, Manager, Runtime, Webview};

pub const DOWNLOAD_EVENT: &str = "desktop-download";
const MAX_NAME_LEN: usize = 120;

#[derive(Clone, Serialize)]
struct Finished {
    success: bool,
}

/// A file name that is safe to create in the Downloads folder: no directories, no characters Windows rejects, no reserved device
/// names, never empty.
fn clean_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last.chars().filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c)).collect();
    name = name.trim_matches([' ', '.']).chars().take(MAX_NAME_LEN).collect();
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if name.is_empty() {
        "download".to_owned()
    } else if reserved {
        format!("_{name}")
    } else {
        name
    }
}

/// `name`, or `name (1).ext`, `name (2).ext`, ... for the first one `exists` does not report.
fn free_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|candidate| !exists(candidate)).unwrap_or(first)
}

pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            if !matches!(url.scheme(), "http" | "https" | "blob" | "data") {
                return false;
            }
            let Ok(dir) = webview.path().download_dir() else { return true };
            let suggested = destination.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            *destination = free_path(&dir, &clean_name(&suggested), Path::exists);
            true
        }
        DownloadEvent::Finished { success, .. } => {
            if let Err(error) = webview.emit(DOWNLOAD_EVENT, Finished { success }) {
                log::warn!("could not report a finished download: {error}");
            }
            true
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_the_downloads_folder() {
        assert_eq!(clean_name("cat.png"), "cat.png");
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(clean_name("a<b>:c\"|?*.txt"), "abc.txt");
        assert_eq!(clean_name(".."), "download");
        assert_eq!(clean_name(" . "), "download");
        assert_eq!(clean_name("con.txt"), "_con.txt");
        assert_eq!(clean_name("LPT1"), "_LPT1");
        assert_eq!(clean_name("com.txt"), "com.txt");
        assert_eq!(clean_name(&"x".repeat(500)).len(), MAX_NAME_LEN);
    }

    #[test]
    fn an_existing_file_is_never_replaced() {
        let dir = Path::new("/d");
        let taken = [dir.join("cat.png"), dir.join("cat (1).png")];
        assert_eq!(free_path(dir, "cat.png", |p| taken.contains(&p.to_path_buf())), dir.join("cat (2).png"));
        assert_eq!(free_path(dir, "new.png", |_| false), dir.join("new.png"));
        assert_eq!(free_path(dir, "noext", |p| p == dir.join("noext")), dir.join("noext (1)"));
    }
}
