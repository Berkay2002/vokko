//! stremio-bot: publishes an ffmpeg-decoded movie into a LiveKit room for vokko-server (docs/design/stremio-bot.md §3.3 and §5).
//! Stateless: everything it knows arrives in `PUT /sessions/{channel_id}` and is dropped when the lease runs out.

mod api;
mod config;
mod media;
mod plan;
mod report;
mod session;

use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,libwebrtc=warn,livekit=warn")))
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = match config::Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(message) => {
            tracing::error!(%message, "bad configuration");
            std::process::exit(2);
        }
    };
    let manager = session::Manager::new(cfg.clone(), report::Reporter::new(&cfg.server_url, &cfg.secret));
    let listener = match tokio::net::TcpListener::bind(cfg.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(listen = %cfg.listen, error = %e, "cannot listen");
            std::process::exit(1);
        }
    };
    tracing::info!(listen = %cfg.listen, max_sessions = cfg.max_sessions, codec = ?cfg.codec, "stremio-bot ready");

    let sweeper = manager.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            sweeper.sweep_expired();
        }
    });

    let shutdown = async {
        #[cfg(unix)]
        if let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            return;
        }
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(e) = axum::serve(listener, api::router(manager.clone(), &cfg.secret)).with_graceful_shutdown(shutdown).await {
        tracing::error!(error = %e, "server stopped");
    }
    manager.delete_all();
    // Give the session tasks a moment to leave their rooms.
    tokio::time::sleep(Duration::from_secs(2)).await;
}
