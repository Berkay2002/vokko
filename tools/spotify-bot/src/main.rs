//! spotify-bot: plays Spotify (librespot, the house account) into a LiveKit room for vokko-server (docs/design/spotify-bot.md §5).
//! `spotify-bot login` stores the account's credentials once; with no arguments it serves the internal API. Stateless: everything
//! it knows arrives in `PUT /session` and is dropped when the lease runs out.

mod account;
mod api;
mod catalog;
mod config;
mod login;
mod plan;
mod pump;
mod report;
mod resample;
mod session;

use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // librespot logs the account name at info, so it stays at warn whatever RUST_LOG says.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,libwebrtc=warn,livekit=warn"));
    // A directive's target is a prefix, so this covers every librespot_* crate.
    let filter = match "librespot=warn".parse() {
        Ok(directive) => filter.add_directive(directive),
        Err(_) => filter,
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();

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
