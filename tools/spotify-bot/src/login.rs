//! `spotify-bot login`: Spotify's desktop client id (the one librespot streams with), PKCE in the browser,
//! then one librespot connect with `store_credentials` so `credentials.json` appears in the config dir.

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;

use librespot_core::{Session, SessionConfig, authentication::Credentials, cache::Cache};
use librespot_oauth::OAuthClientBuilder;

const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
const REDIRECT_URI: &str = "http://127.0.0.1:8898/login";

pub fn config_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join(".config/vokko/spotify-bot"))
}

pub async fn run() -> Result<(), String> {
    let dir = config_dir()?;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    // The library prints "Browse to: <url>" and listens on the redirect port until the browser comes back.
    let client = OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, vec!["streaming"])
        .with_custom_message("Signed in. You can close this tab.")
        .build()
        .map_err(|e| e.to_string())?;
    let token = tokio::task::spawn_blocking(move || client.get_access_token()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;

    let cache = Cache::new(Some(&dir), None, None, None).map_err(|e| e.to_string())?;
    let session = Session::new(SessionConfig::default(), Some(cache));
    session.connect(Credentials::with_access_token(token.access_token), true).await.map_err(|e| e.to_string())?;
    session.shutdown();

    let file = dir.join("credentials.json");
    let mode = std::fs::metadata(&file).map_err(|e| format!("credentials were not written: {e}"))?.permissions().mode() & 0o777;
    if mode != 0o600 {
        return Err(format!("{} has mode {mode:o}, expected 600", file.display()));
    }
    println!("Credentials stored in {} (mode 600).", file.display());
    Ok(())
}
