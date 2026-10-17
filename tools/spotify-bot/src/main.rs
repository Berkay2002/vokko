//! spotify-bot: plays Spotify (librespot, the house account) into a LiveKit room for vokko-server (docs/design/spotify-bot.md §5).
//! `spotify-bot login` stores the account's credentials once; with no arguments it serves the internal API. Stateless: everything
//! it knows arrives in `PUT /session` and is dropped when the lease runs out.

#[cfg(unix)]
mod account;
#[cfg(unix)]
mod api;
#[cfg(unix)]
mod catalog;
#[cfg(unix)]
mod config;
#[cfg(unix)]
mod login;
#[cfg(unix)]
mod plan;
#[cfg(unix)]
mod pump;
#[cfg(unix)]
mod report;
#[cfg(unix)]
mod resample;
#[cfg(unix)]
mod session;

#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use tracing_subscriber::Layer;
#[cfg(unix)]
use tracing_subscriber::filter::{EnvFilter, FilterExt, filter_fn};
#[cfg(unix)]
use tracing_subscriber::layer::SubscriberExt;
#[cfg(unix)]
use tracing_subscriber::util::SubscriberInitExt;

// The credentials file is guarded by unix modes and shutdown waits for SIGTERM, so the bot is unix only; elsewhere it only
// builds (keeps `cargo clippy --workspace` working on the Windows PC).
#[cfg(not(unix))]
fn main() {
    eprintln!("spotify-bot runs on unix only");
    std::process::exit(1);
}

#[cfg(unix)]
#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // librespot logs the account name at info, so every librespot* target stays at warn whatever RUST_LOG says: a more specific
    // directive such as `librespot_core=info` beats a general one, so this is a second filter on top of RUST_LOG, not a directive.
    let env = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,libwebrtc=warn,livekit=warn"));
    let quiet_librespot = filter_fn(|meta| !meta.target().starts_with("librespot") || *meta.level() <= tracing::Level::WARN);
    tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_filter(env.and(quiet_librespot))).init();

    match std::env::args().nth(1).as_deref() {
        Some("login") => match login::run().await {
            Ok(()) => {}
            Err(message) => {
                eprintln!("spotify-bot: {message}");
                std::process::exit(1);
            }
        },
        None => serve().await,
        Some(_) => {
            eprintln!("usage: spotify-bot [login]");
            std::process::exit(2);
        }
    }
}

#[cfg(unix)]
async fn serve() {
    let cfg = match config::Config::from_env() {
        Ok(cfg) => cfg,
        Err(message) => {
            tracing::error!(%message, "bad configuration");
            std::process::exit(2);
        }
    };
    let account = match account::Account::new() {
        Ok(account) => Arc::new(account),
        Err(message) => {
            tracing::error!(%message, "bad configuration");
            std::process::exit(2);
        }
    };
    let manager = session::Manager::new(report::Reporter::new(&cfg.server_url, &cfg.secret), account.clone());
    let listener = match tokio::net::TcpListener::bind(cfg.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(listen = %cfg.listen, error = %e, "cannot listen");
            std::process::exit(1);
        }
    };
    tracing::info!(listen = %cfg.listen, "spotify-bot ready");

    let sweeper = manager.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            sweeper.sweep_expired();
            sweeper.account.sweep().await;
        }
    });

    let shutdown = async {
        if let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            return;
        }
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(e) = axum::serve(listener, api::router(manager.clone(), &cfg.secret, &cfg.market)).with_graceful_shutdown(shutdown).await {
        tracing::error!(error = %e, "server stopped");
    }
    manager.delete();
    account.close_all().await;
    // Give the session task a moment to leave its room and close the Spotify session.
    tokio::time::sleep(Duration::from_secs(2)).await;
}
