//! Spotify bot. Phase 0 spike: `login` stores the house account's librespot credentials.

mod login;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // librespot logs the account name at info, so everything but this crate stays at warn.
    let filter = tracing_subscriber::EnvFilter::try_from_env("SPOTIFY_BOT_LOG").unwrap_or_else(|_| "warn,spotify_bot=info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let result = match std::env::args().nth(1).as_deref() {
        Some("login") => login::run().await,
        _ => Err("usage: spotify-bot login".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("spotify-bot: {message}");
            ExitCode::FAILURE
        }
    }
}
