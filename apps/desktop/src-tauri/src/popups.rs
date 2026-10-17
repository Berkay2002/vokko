//! New-window requests from the webview (`window.open`, `target="_blank"`, a website game's popups): `http:` / `https:` URLs open
//! in the system browser, at most one a second and three in 30 seconds (a framed page must not spam browser tabs); the webview
//! itself never opens a window. Anything else is denied.

use std::collections::VecDeque;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Runtime;
use tauri::webview::NewWindowResponse;
use tauri::{Url, webview::NewWindowFeatures};

const MIN_GAP: Duration = Duration::from_secs(1);
const BURST: usize = 3;
const BURST_WINDOW: Duration = Duration::from_secs(30);

static RECENT: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

/// Whether `url` may go to the system browser now: http(s) only, not within a second of the last one, and at most [`BURST`] in
/// [`BURST_WINDOW`]. `recent` holds the times of the ones that went.
fn allowed(url: &Url, now: Instant, recent: &mut VecDeque<Instant>) -> bool {
    while recent.front().is_some_and(|&at| now.duration_since(at) >= BURST_WINDOW) {
        recent.pop_front();
    }
    if !matches!(url.scheme(), "http" | "https") || recent.len() >= BURST || recent.back().is_some_and(|&at| now.duration_since(at) < MIN_GAP) {
        return false;
    }
    recent.push_back(now);
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
    let go = RECENT.lock().map(|mut recent| allowed(&url, Instant::now(), &mut recent)).unwrap_or(false);
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
        let mut last = VecDeque::new();
        assert!(allowed(&url("https://shellshock.io/"), start, &mut last));
        assert!(!allowed(&url("https://krunker.io/"), start + Duration::from_millis(500), &mut last), "within a second");
        assert!(allowed(&url("http://example.com/"), start + Duration::from_millis(1000), &mut last));
        for bad in ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "vokko://invite/x", "ms-settings:", "data:text/html,x"] {
            assert!(!allowed(&url(bad), start + Duration::from_secs(10), &mut last), "{bad}");
        }
    }

    #[test]
    fn three_in_thirty_seconds() {
        let url = Url::parse("https://krunker.io/").expect("url");
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let mut recent = VecDeque::new();
        assert!(allowed(&url, at(0), &mut recent) && allowed(&url, at(2), &mut recent) && allowed(&url, at(4), &mut recent));
        assert!(!allowed(&url, at(6), &mut recent), "a fourth within 30 seconds");
        assert!(!allowed(&url, at(29), &mut recent), "still within 30 seconds of the first");
        assert!(allowed(&url, at(30), &mut recent), "the first has aged out");
    }
}
