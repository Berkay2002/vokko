//! New-window requests from the webview (`window.open`, `target="_blank"`, a website game's popups): `http:` / `https:` URLs open
//! in the system browser, at most one a second; the webview itself never opens a window. Anything else is denied.

use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Runtime;
use tauri::webview::NewWindowResponse;
use tauri::{Url, webview::NewWindowFeatures};

const MIN_GAP: Duration = Duration::from_secs(1);

static LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether `url` may go to the system browser now: http(s) only, and not within a second of the last one.
fn allowed(url: &Url, now: Instant, last: &mut Option<Instant>) -> bool {
    if !matches!(url.scheme(), "http" | "https") || last.is_some_and(|last| now.duration_since(last) < MIN_GAP) {
        return false;
    }
    *last = Some(now);
    true
}

fn open_in_browser(url: &str) -> std::io::Result<()> {
    // No shell: the URL is one argument to the platform's opener.
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map(drop)
}

pub fn on_new_window<R: Runtime>(url: Url, _features: NewWindowFeatures) -> NewWindowResponse<R> {
    let go = LAST.lock().map(|mut last| allowed(&url, Instant::now(), &mut last)).unwrap_or(false);
    if go && let Err(error) = open_in_browser(url.as_str()) {
        log::warn!("could not open a link in the browser: {error}");
    }
    NewWindowResponse::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls_and_one_a_second() {
        let url = |raw: &str| Url::parse(raw).expect("url");
        let start = Instant::now();
        let mut last = None;
        assert!(allowed(&url("https://shellshock.io/"), start, &mut last));
        assert!(!allowed(&url("https://krunker.io/"), start + Duration::from_millis(500), &mut last), "within a second");
        assert!(allowed(&url("http://example.com/"), start + Duration::from_millis(1000), &mut last));
        for bad in ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "vokko://invite/x", "ms-settings:", "data:text/html,x"] {
            assert!(!allowed(&url(bad), start + Duration::from_secs(10), &mut last), "{bad}");
        }
    }
}
