//! The house account's librespot sessions: one for playback while a call plays, and a short-lived one for catalog reads when
//! nothing plays (design §5). Sessions come from the stored credentials only; nothing here logs a name or a token.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use librespot_core::{Error, Session, SessionConfig, cache::Cache, error::ErrorKind};

use crate::login::config_dir;

/// An idle catalog session closes this long after its last read.
const CATALOG_IDLE: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
pub enum Fail {
    /// No usable credentials, or Spotify rejected them: the owner has to run `spotify-bot login` again.
    Auth,
    Io,
}

/// A credentials file anyone but the owner can read is refused (design §2.4).
pub fn check_mode(mode: u32) -> Result<(), String> {
    if mode & 0o077 == 0 { Ok(()) } else { Err(format!("credentials.json has mode {:o}; chmod 600 it", mode & 0o777)) }
}

pub fn fail_of(error: &Error) -> Fail {
    match error.kind {
        ErrorKind::PermissionDenied | ErrorKind::Unauthenticated => Fail::Auth,
        _ => Fail::Io,
    }
}

pub struct Account {
    dir: PathBuf,
    /// The playback session, shared with catalog reads while it lives.
    playing: Mutex<Option<Session>>,
    catalog: tokio::sync::Mutex<Option<(Session, Instant)>>,
}

impl Account {
    pub fn new() -> Result<Self, String> {
        Ok(Self { dir: config_dir()?, playing: Mutex::default(), catalog: tokio::sync::Mutex::default() })
    }

    /// A fresh session from the stored credentials.
    pub async fn connect(&self) -> Result<Session, Fail> {
        let file = self.dir.join("credentials.json");
        let Ok(meta) = std::fs::metadata(&file) else {
            tracing::error!("no credentials: run spotify-bot login");
            return Err(Fail::Auth);
        };
        if let Err(message) = check_mode(meta.permissions().mode()) {
            tracing::error!(%message, "refusing the credentials file");
            return Err(Fail::Auth);
        }
        let cache = Cache::new(Some(&self.dir), None, None, None).map_err(|_| Fail::Io)?;
        let Some(credentials) = cache.credentials() else {
            tracing::error!("credentials.json is unreadable: run spotify-bot login");
            return Err(Fail::Auth);
        };
        let session = Session::new(SessionConfig::default(), Some(cache));
        match tokio::time::timeout(CONNECT_TIMEOUT, session.connect(credentials, false)).await {
            Ok(Ok(())) => Ok(session),
            Ok(Err(e)) => {
                let fail = fail_of(&e);
                tracing::warn!(kind = ?e.kind, "spotify connect failed");
                Err(fail)
            }
            Err(_) => {
                tracing::warn!("spotify connect timed out");
                Err(Fail::Io)
            }
        }
    }

    pub fn set_playing(&self, session: Option<Session>) {
        *self.playing.lock().unwrap_or_else(|e| e.into_inner()) = session;
    }

    /// The playing session if there is one, else the catalog session (opened on demand).
    pub async fn for_catalog(&self) -> Result<Session, Fail> {
        if let Some(session) = self.playing.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|s| !s.is_invalid()) {
            return Ok(session);
        }
        let mut slot = self.catalog.lock().await;
        if let Some((session, used)) = slot.as_mut().filter(|(s, _)| !s.is_invalid()) {
            *used = Instant::now();
            return Ok(session.clone());
        }
        let session = self.connect().await?;
        *slot = Some((session.clone(), Instant::now()));
        Ok(session)
    }

    /// Closes the catalog session once it has been idle for 30 s.
    pub async fn sweep(&self) {
        let mut slot = self.catalog.lock().await;
        if slot.as_ref().is_some_and(|(s, used)| s.is_invalid() || used.elapsed() > CATALOG_IDLE)
            && let Some((session, _)) = slot.take()
        {
            session.shutdown();
        }
    }

    pub async fn close_all(&self) {
        if let Some((session, _)) = self.catalog.lock().await.take() {
            session.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owner_only_modes_pass() {
        assert!(check_mode(0o100600).is_ok());
        assert!(check_mode(0o400).is_ok());
        assert!(check_mode(0o644).is_err());
        assert!(check_mode(0o660).is_err());
        assert!(check_mode(0o604).is_err());
    }

    #[test]
    fn rejected_logins_mean_auth() {
        assert_eq!(fail_of(&Error::permission_denied("bad credentials")), Fail::Auth);
        assert_eq!(fail_of(&Error::unavailable("socket")), Fail::Io);
    }
}
