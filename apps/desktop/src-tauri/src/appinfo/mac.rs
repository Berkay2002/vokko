//! macOS: the name and icon of the `.app` bundle an executable lives in. `plutil` and `sips` ship with macOS; calling them avoids
//! linking AppKit just to read a plist and convert an `.icns`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Default)]
pub struct Meta {
    pub display_name: Option<String>,
    pub name: Option<String>,
    pub icon_png: Option<Vec<u8>>,
}

/// The outermost `.app` directory containing `exe` (a helper app inside another bundle is not the app the user runs).
fn enclosing_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().filter(|dir| dir.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app"))).last().map(Path::to_path_buf)
}

pub fn read(exe: &Path) -> Meta {
    let Some(bundle) = enclosing_bundle(exe) else { return Meta::default() };
    let output = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "--"])
        .arg(bundle.join("Contents/Info.plist"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Some(info) = output.ok().filter(|output| output.status.success()).and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
    else {
        return Meta::default();
    };
    let text = |key: &str| info.get(key).and_then(|value| value.as_str()).map(str::to_owned);
    Meta { display_name: text("CFBundleDisplayName"), name: text("CFBundleName"), icon_png: text("CFBundleIconFile").and_then(|file| icon(&bundle, &file)) }
}

/// `CFBundleIconFile` may omit the `.icns` extension. Bundles that only have an asset catalog get no icon.
fn icon(bundle: &Path, file: &str) -> Option<Vec<u8>> {
    // only a file name: the plist is the app's own, but a path with separators would walk out of Resources
    if file.is_empty() || file.contains('/') || file.contains("..") {
        return None;
    }
    let name = if file.to_ascii_lowercase().ends_with(".icns") { file.to_owned() } else { format!("{file}.icns") };
    let icns = bundle.join("Contents/Resources").join(name);
    if !icns.is_file() {
        return None;
    }
    let out = std::env::temp_dir().join(format!(
        "vokko-appicon-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
    ));
    let converted = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-z", "64", "64"])
        .arg(&icns)
        .arg("--out")
        .arg(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    let png = if converted { std::fs::read(&out).ok() } else { None };
    let _ = std::fs::remove_file(&out);
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outermost_app_is_the_bundle() {
        let exe = Path::new(
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
        );
        assert_eq!(enclosing_bundle(exe), Some(PathBuf::from("/Applications/Google Chrome.app")));
        assert_eq!(enclosing_bundle(Path::new("/usr/local/bin/tool")), None);
    }

    /// Runs against whatever is installed; passes trivially on a machine without Claude.app.
    #[test]
    fn reads_the_real_claude_app_when_installed() {
        let exe = Path::new("/Applications/Claude.app/Contents/MacOS/Claude");
        if !exe.exists() {
            return;
        }
        let meta = read(exe);
        assert_eq!(meta.display_name.as_deref(), Some("Claude"));
        let png = meta.icon_png.expect("an icon");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn icon_file_names_cannot_leave_resources() {
        assert!(icon(Path::new("/Applications/Claude.app"), "../../../etc/passwd").is_none());
        assert!(icon(Path::new("/Applications/Claude.app"), "").is_none());
    }
}
