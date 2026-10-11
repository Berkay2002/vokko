//! `vokko://` deep links. A link can arrive before the webview has loaded (cold start, or a second
//! instance forwarding its argv), and an event emitted then is lost, so links queue here until the
//! frontend calls `desktop_take_pending_links` once; after that they are emitted live.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const LINK_EVENT: &str = "desktop-deep-link";
const MAX_CODE_LEN: usize = 64;
const MAX_URL_LEN: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeepLink {
    /// `vokko://invite/<code>`
    Invite { code: String, url: String },
    /// `vokko://auth/callback?code=…&state=…`: the OAuth redirect back from the system browser. The web side
    /// parses the query itself, so the full URL is passed through untouched.
    Auth { url: String },
}

/// Parses a `vokko://` URL. Unknown hosts, empty or odd invite codes, oversized or control-character URLs return `None`.
pub fn parse(url: &str) -> Option<DeepLink> {
    let url = url.trim();
    if url.len() > MAX_URL_LEN || url.chars().any(char::is_control) {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("vokko") {
        return None;
    }
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let host = parts.next()?;
    match host.to_ascii_lowercase().as_str() {
        "invite" => {
            let code = parts.next()?;
            let valid = code.len() <= MAX_CODE_LEN && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            valid.then(|| DeepLink::Invite { code: code.to_owned(), url: url.to_owned() })
        }
        "auth" => {
            let is_callback = parts.next().is_some_and(|segment| segment.eq_ignore_ascii_case("callback")) && parts.next().is_none();
            is_callback.then(|| DeepLink::Auth { url: url.to_owned() })
        }
        _ => None,
    }
}

#[derive(Default)]
struct Inner {
    ready: bool,
    pending: Vec<DeepLink>,
}

#[derive(Default)]
pub struct LinkState {
    inner: Mutex<Inner>,
}

impl LinkState {
    /// Returns the link back when it should be emitted now, or `None` when it was queued.
    fn deliver(&self, link: DeepLink) -> Option<DeepLink> {
        let mut inner = self.inner.lock().ok()?;
        if inner.ready {
            Some(link)
        } else {
            inner.pending.push(link);
            None
        }
    }

    fn take(&self) -> Vec<DeepLink> {
        match self.inner.lock() {
            Ok(mut inner) => {
                inner.ready = true;
                std::mem::take(&mut inner.pending)
            }
            Err(_) => Vec::new(),
        }
    }
}

/// Routes one incoming URL: bring the window forward, then queue or emit the parsed link.
pub fn handle_url<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let Some(link) = parse(url) else {
        log::debug!("ignoring unrecognised deep link");
        return;
    };
    crate::window::show_main(app);
    match app.state::<LinkState>().deliver(link) {
        Some(link) => {
            log::info!("deep link: emitting to the frontend");
            if let Err(error) = app.emit(LINK_EVENT, link) {
                log::warn!("cannot emit deep link: {error}");
            }
        }
        None => log::info!("deep link: queued until the frontend is ready"),
    }
}

#[tauri::command]
pub fn desktop_take_pending_links(state: tauri::State<'_, LinkState>) -> Vec<DeepLink> {
    let links = state.take();
    if !links.is_empty() {
        log::info!("deep link: handing {} queued link(s) to the frontend", links.len());
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invite(code: &str, url: &str) -> Option<DeepLink> {
        Some(DeepLink::Invite { code: code.into(), url: url.into() })
    }

    #[test]
    fn parses_invite_links() {
        assert_eq!(parse("vokko://invite/abc123"), invite("abc123", "vokko://invite/abc123"));
        assert_eq!(parse("VOKKO://Invite/ab-c_9/"), invite("ab-c_9", "VOKKO://Invite/ab-c_9/"));
        assert_eq!(parse("vokko://invite/abc?src=web#x"), invite("abc", "vokko://invite/abc?src=web#x"));
    }

    #[test]
    fn parses_the_auth_callback_with_its_full_url() {
        let url = "vokko://auth/callback?code=a1%2Fb&state=xyz";
        assert_eq!(parse(url), Some(DeepLink::Auth { url: url.into() }));
        assert_eq!(parse("vokko://auth/callback"), Some(DeepLink::Auth { url: "vokko://auth/callback".into() }));
    }

    #[test]
    fn rejects_everything_else() {
        assert_eq!(parse("vokko://invite"), None);
        assert_eq!(parse("vokko://invite/"), None);
        assert_eq!(parse("vokko://invite/a%20b"), None);
        assert_eq!(parse("vokko://invite/a.b"), None);
        assert_eq!(parse("vokko://channels/1/2"), None);
        assert_eq!(parse("vokko://auth"), None);
        assert_eq!(parse("vokko://auth/other?code=1"), None);
        assert_eq!(parse("vokko://auth/callback/extra"), None);
        assert_eq!(parse("https://invite/abc"), None);
        assert_eq!(parse("discord://invite/abc"), None);
        assert_eq!(parse(&format!("vokko://invite/{}", "a".repeat(65))), None);
        assert_eq!(parse(&format!("vokko://auth/callback?state={}", "a".repeat(5000))), None);
        assert_eq!(
            parse(
                "vokko://auth/callback?code=1
2"
            ),
            None
        );
    }

    #[test]
    fn queues_until_the_frontend_is_ready() {
        let state = LinkState::default();
        let link = DeepLink::Auth { url: "vokko://auth/callback?code=1".into() };
        assert_eq!(state.deliver(link.clone()), None);
        assert_eq!(state.take(), vec![link.clone()]);
        assert_eq!(state.deliver(link.clone()), Some(link));
        assert!(state.take().is_empty());
    }
}
