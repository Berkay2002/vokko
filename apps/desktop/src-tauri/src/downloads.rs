//! Downloads from the webview (Save Image, a file card's Download): they go straight into the user's Downloads folder under a
//! cleaned-up name that never overwrites a file. Without this handler WKWebView and WebKitGTK save nowhere useful and WebView2 opens
//! its own save prompt. Only `blob:` URLs minted by the app's own origin are saved, so every Save is an app-made blob that a click
//! produced; a frame or a script that asks for an `http(s):`, `data:` or foreign `blob:` download is refused.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::webview::DownloadEvent;
use tauri::{Emitter, Manager, Runtime, Url, Webview};

pub const DOWNLOAD_EVENT: &str = "desktop-download";
const MAX_NAME_BYTES: usize = 200;
/// Files the OS would run, install, mount or open with macros on a double click. They are still saved, but under `<name>.download`,
/// so opening one takes a deliberate rename instead of a click on a name the sender chose.
const RUNNABLE: &[&str] = &[
    "app",
    "appimage",
    "applescript",
    "application",
    "appref-ms",
    "appx",
    "appxbundle",
    "bat",
    "bin",
    "chm",
    "cmd",
    "com",
    "command",
    "cpl",
    "deb",
    "desktop",
    "dll",
    "dmg",
    "docm",
    "exe",
    "fileloc",
    "gadget",
    "hta",
    "img",
    "inetloc",
    "inf",
    "iso",
    "jar",
    "jnlp",
    "js",
    "jse",
    "library-ms",
    "lnk",
    "mobileconfig",
    "mpkg",
    "msc",
    "msi",
    "msix",
    "msixbundle",
    "msp",
    "pif",
    "pkg",
    "pptm",
    "ps1",
    "ps1xml",
    "psm1",
    "reg",
    "rpm",
    "run",
    "scf",
    "scpt",
    "scr",
    "search-ms",
    "settingcontent-ms",
    "sh",
    "terminal",
    "url",
    "vbe",
    "vbs",
    "vhd",
    "vhdx",
    "webloc",
    "workflow",
    "ws",
    "wsf",
    "wsh",
    "xll",
    "xlsm",
];

/// Zero-width and bidirectional-control characters (Unicode category Cf): they reorder or hide parts of a name ("evil\u{202E}gpj.exe").
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{AD}' | '\u{61C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}')
}

#[derive(Clone, Serialize)]
struct Finished {
    success: bool,
}

/// Windows device names, with or without an extension: CON, PRN, AUX, NUL, CONIN$, CONOUT$ and COM1-9 / LPT1-9 (superscript digits too).
fn is_reserved(stem: &str) -> bool {
    let stem = stem.trim_end_matches(' ').to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let chars: Vec<char> = stem.chars().collect();
    chars.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(chars[3], '1'..='9' | '¹' | '²' | '³')
}

/// A file name that is safe to create in the Downloads folder: no directories, no characters Windows rejects, no reserved device
/// names, no trailing dot or space (Windows drops them, so "a.exe." would save as "a.exe"), never empty, and runnable types
/// renamed to `.download`.
fn clean_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last.chars().filter(|c| !c.is_control() && !is_invisible(*c) && !"<>:\"|?*".contains(*c)).collect();
    let mut end = name.len().min(MAX_NAME_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name.truncate(end);
    let mut name = name.trim_matches([' ', '.']).to_owned();
    if name.is_empty() {
        return "download".to_owned();
    }
    if is_reserved(name.split('.').next().unwrap_or_default()) {
        name.insert(0, '_');
    }
    if name.rsplit_once('.').is_some_and(|(_, ext)| RUNNABLE.contains(&ext.to_ascii_lowercase().as_str())) {
        name.push_str(".download");
    }
    name
}

/// `scheme://host[:port]`. `Url::origin()` would do, but it is opaque for `tauri://localhost`, so two such URLs never compare equal.
fn origin_string(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// A `blob:<origin>/<id>` URL whose origin is the page's own. Anything else (http, https, data, a blob from another site) is not
/// something the app made in response to a click.
fn is_own_blob(download: &Url, own: &Url) -> bool {
    if download.scheme() != "blob" {
        return false;
    }
    let Some(inner) = download.as_str().strip_prefix("blob:").and_then(|rest| Url::parse(rest).ok()) else { return false };
    matches!((origin_string(&inner), origin_string(own)), (Some(a), Some(b)) if a == b)
}

/// Takes `path` if nothing is there. On Windows the file is created empty so two downloads cannot pick the same name; on macOS an
/// existing file makes WKDownload fail, so the check only looks. A dangling symlink counts as taken.
#[cfg(windows)]
fn claim(path: &Path) -> bool {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path).is_ok()
}

#[cfg(not(windows))]
fn claim(path: &Path) -> bool {
    path.symlink_metadata().is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// The first of `name`, `name (1).ext`, `name (2).ext`, ... that `claim` takes, or None when a thousand are taken.
fn free_path(dir: &Path, name: &str, mut claim: impl FnMut(&Path) -> bool) -> Option<PathBuf> {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    std::iter::once(dir.join(name)).chain((1..1000).map(|n| dir.join(format!("{stem} ({n}){ext}")))).find(|candidate| claim(candidate))
}

pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Ok(own) = webview.url() else { return false };
            if !is_own_blob(&url, &own) {
                log::warn!("refused a download from {}", url.scheme());
                return false;
            }
            let Ok(dir) = webview.path().download_dir() else { return false };
            let suggested = destination.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            let Some(path) = free_path(&dir, &clean_name(&suggested), claim) else { return false };
            *destination = path;
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
        assert_eq!(clean_name("C:\\Windows\\evil.exe"), "evil.exe.download");
        assert_eq!(clean_name("a<b>:c\"|?*.txt"), "abc.txt");
        assert_eq!(clean_name(".."), "download");
        assert_eq!(clean_name(" . "), "download");
        assert_eq!(clean_name("com.txt"), "com.txt");
        assert_eq!(clean_name("exe"), "exe");
        assert_eq!(clean_name("evil\u{202E}gpj.exe"), "evilgpj.exe.download");
    }

    #[test]
    fn device_names_get_a_prefix() {
        assert_eq!(clean_name("con.txt"), "_con.txt");
        assert_eq!(clean_name("LPT1"), "_LPT1");
        assert_eq!(clean_name("COM\u{b9}.txt"), "_COM\u{b9}.txt");
        assert_eq!(clean_name("lpt\u{b3}"), "_lpt\u{b3}");
        assert_eq!(clean_name("CONIN$"), "_CONIN$");
        assert_eq!(clean_name("nul .txt"), "_nul .txt");
        assert_eq!(clean_name("COM10"), "COM10");
    }

    #[test]
    fn a_device_name_does_not_hide_a_runnable_type() {
        assert_eq!(clean_name("CON.exe"), "_CON.exe.download");
        assert_eq!(clean_name("nul.command"), "_nul.command.download");
        assert_eq!(clean_name("aux.pkg"), "_aux.pkg.download");
        assert_eq!(clean_name("con.sh"), "_con.sh.download");
    }

    #[test]
    fn runnable_types_are_saved_as_dot_download() {
        for ext in [
            "app",
            "appimage",
            "bat",
            "cmd",
            "com",
            "command",
            "cpl",
            "deb",
            "dll",
            "dmg",
            "exe",
            "hta",
            "jar",
            "js",
            "jse",
            "lnk",
            "msi",
            "pkg",
            "ps1",
            "reg",
            "rpm",
            "scr",
            "sh",
            "vbe",
            "vbs",
            "wsf",
            "url",
            "appref-ms",
            "msix",
            "msixbundle",
            "appx",
            "appxbundle",
            "terminal",
            "webloc",
            "fileloc",
            "inetloc",
            "desktop",
            "run",
            "pif",
            "scf",
            "msc",
            "msp",
            "wsh",
            "ws",
            "psm1",
            "ps1xml",
            "application",
            "settingcontent-ms",
            "library-ms",
            "search-ms",
            "chm",
            "xll",
            "iso",
            "img",
            "vhd",
            "vhdx",
            "mpkg",
            "workflow",
            "scpt",
            "applescript",
            "mobileconfig",
            "bin",
            "jnlp",
            "inf",
            "gadget",
            "docm",
            "xlsm",
            "pptm",
        ] {
            assert_eq!(clean_name(&format!("file.{ext}")), format!("file.{ext}.download"), "{ext}");
            assert_eq!(clean_name(&format!("file.{}", ext.to_uppercase())), format!("file.{}.download", ext.to_uppercase()), "{ext} upper");
        }
        for ext in ["png", "txt", "pdf", "docx", "zip"] {
            assert_eq!(clean_name(&format!("file.{ext}")), format!("file.{ext}"));
        }
    }

    #[test]
    fn a_long_name_is_cut_before_its_trailing_dots_are_trimmed() {
        // The cut lands right after "a.exe." and Windows would save that as "a.exe".
        let name = format!("{}a.exe.bbbb", "x".repeat(MAX_NAME_BYTES - 6));
        assert_eq!(clean_name(&name), format!("{}a.exe.download", "x".repeat(MAX_NAME_BYTES - 6)));
        assert_eq!(clean_name(&"x".repeat(500)).len(), MAX_NAME_BYTES);
    }

    #[test]
    fn the_byte_cap_never_splits_a_character() {
        let name = clean_name(&"é".repeat(300));
        assert_eq!(name.len(), MAX_NAME_BYTES);
        assert!(name.chars().all(|c| c == 'é'));
        let odd = clean_name(&format!("a{}", "é".repeat(300)));
        assert_eq!(odd.len(), 199); // 1 + 99 * 2: the 100th é would end at 201
    }

    #[test]
    fn an_existing_file_is_never_replaced() {
        let dir = Path::new("/d");
        let taken = [dir.join("cat.png"), dir.join("cat (1).png")];
        assert_eq!(free_path(dir, "cat.png", |p| !taken.contains(&p.to_path_buf())), Some(dir.join("cat (2).png")));
        assert_eq!(free_path(dir, "new.png", |_| true), Some(dir.join("new.png")));
        assert_eq!(free_path(dir, "noext", |p| p != dir.join("noext")), Some(dir.join("noext (1)")));
        assert_eq!(free_path(dir, "full.png", |_| false), None);
    }

    #[test]
    fn claim_only_takes_names_nothing_is_using() {
        let dir = std::env::temp_dir().join(format!("vokko-downloads-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("a.txt");
        assert!(claim(&file));
        std::fs::write(&file, b"x").expect("write");
        assert!(!claim(&file));
        #[cfg(unix)]
        {
            let link = dir.join("dangling.txt");
            std::os::unix::fs::symlink(dir.join("missing"), &link).expect("symlink");
            assert!(!claim(&link));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn blob_ok(download: &str, own: &str) -> bool {
        is_own_blob(&Url::parse(download).expect("download url"), &Url::parse(own).expect("own url"))
    }

    #[test]
    fn only_blobs_from_the_apps_own_origin_are_saved() {
        for (blob, own) in [
            ("blob:tauri://localhost/3f2a", "tauri://localhost/"),
            ("blob:tauri://localhost/3f2a", "tauri://localhost/index.html"),
            ("blob:http://tauri.localhost/3f2a", "http://tauri.localhost/"),
            ("blob:https://tauri.localhost/3f2a", "https://tauri.localhost/#/chat"),
            ("blob:http://localhost:1420/3f2a", "http://localhost:1420/"),
        ] {
            assert!(blob_ok(blob, own), "{blob}");
        }
        for (url, own) in [
            ("https://tauri.localhost/file.png", "https://tauri.localhost/"),
            ("http://tauri.localhost/file.png", "http://tauri.localhost/"),
            ("tauri://localhost/file.png", "tauri://localhost/"),
            ("data:text/plain;base64,aGk=", "tauri://localhost/"),
            ("file:///etc/passwd", "tauri://localhost/"),
            ("blob:https://www.youtube.com/3f2a", "https://tauri.localhost/"),
            ("blob:https://tauri.localhost/3f2a", "http://tauri.localhost/"),
            ("blob:http://tauri.localhost/3f2a", "tauri://localhost/"),
            ("blob:http://localhost:1421/3f2a", "http://localhost:1420/"),
            ("blob:null/3f2a", "tauri://localhost/"),
            ("blob:nonsense", "tauri://localhost/"),
            ("blob:", "tauri://localhost/"),
        ] {
            assert!(!blob_ok(url, own), "{url}");
        }
    }
}
