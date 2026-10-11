//! `vokko://` deep links. A link can arrive before the webview has loaded (cold start, or a second
//! instance forwarding its argv), and an event emitted then is lost, so links queue here until the
//! frontend calls `desktop_take_pending_links` once; after that they are emitted live.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const LINK_EVENT: &str = "desktop-deep-link";
const MAX_CODE_LEN: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeepLink {
    /// `vokko://invite/<code>`
    Invite { code: String },
}

/// Parses a `vokko://` URL. Unknown hosts, empty or odd invite codes return `None`.
pub fn parse(url: &str) -> Option<DeepLink> {
    let (scheme, rest) = url.trim().split_once("://")?;
    if !scheme.eq_ignore_ascii_case("vokko") {
        return None;
    }
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let host = parts.next()?;
    match host.to_ascii_lowercase().as_str() {
        "invite" => {
            let code = parts.next()?;
            let valid = code.len() <= MAX_CODE_LEN && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            valid.then(|| DeepLink::Invite { code: code.to_owned() })
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
    if let Some(link) = app.state::<LinkState>().deliver(link)
        && let Err(error) = app.emit(LINK_EVENT, link)
    {
        log::warn!("cannot emit deep link: {error}");
    }
}

#[tauri::command]
pub fn desktop_take_pending_links(state: tauri::State<'_, LinkState>) -> Vec<DeepLink> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_invite_links() {
        assert_eq!(parse("vokko://invite/abc123"), Some(DeepLink::Invite { code: "abc123".into() }));
        assert_eq!(parse("VOKKO://Invite/ab-c_9/"), Some(DeepLink::Invite { code: "ab-c_9".into() }));
        assert_eq!(parse("vokko://invite/abc?src=web#x"), Some(DeepLink::Invite { code: "abc".into() }));
    }

    #[test]
    fn rejects_everything_else() {
        assert_eq!(parse("vokko://invite"), None);
        assert_eq!(parse("vokko://invite/"), None);
        assert_eq!(parse("vokko://invite/a%20b"), None);
        assert_eq!(parse("vokko://invite/a.b"), None);
        assert_eq!(parse("vokko://channels/1/2"), None);
        assert_eq!(parse("https://invite/abc"), None);
        assert_eq!(parse("discord://invite/abc"), None);
        assert_eq!(parse(&format!("vokko://invite/{}", "a".repeat(65))), None);
    }

    #[test]
    fn queues_until_the_frontend_is_ready() {
        let state = LinkState::default();
        let link = DeepLink::Invite { code: "x".into() };
        assert_eq!(state.deliver(link.clone()), None);
        assert_eq!(state.take(), vec![link.clone()]);
        assert_eq!(state.deliver(link.clone()), Some(link));
        assert!(state.take().is_empty());
    }
}
