//! Spotify bot. Phase 0 spike: `login` stores the house account's librespot credentials; `tone`, `play` and `meta` answer design questions.

mod login;
mod pump;
mod resample;
mod spike;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // librespot logs the account name at info, so everything but this crate stays at warn.
    let filter = tracing_subscriber::EnvFilter::try_from_env("SPOTIFY_BOT_LOG").unwrap_or_else(|_| "warn,spotify_bot=info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let mut args = std::env::args().skip(1);
    let result = match args.next().as_deref() {
        Some("login") => login::run().await,
        Some("tone") => spike::tone(args.next()).await,
        Some("play") => spike::play(args.next(), args.next(), args.next()).await,
        Some("meta") => spike::meta(args.next(), args.next()).await,
        _ => Err("usage: spotify-bot login | tone direct|resample | play <track id> direct|resample [seconds] | meta playlist|artist|track <id>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("spotify-bot: {message}");
            ExitCode::FAILURE
        }
    }
}
