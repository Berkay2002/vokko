use vokko_server::{AppState, Config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "vokko_server=info,warn".into())).init();
    if let Err(message) = run().await {
        eprintln!("vokko-server: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "serve".to_owned());
    let config = Config::from_env()?;
    let pool = vokko_server::connect(&config.database_url, config.db_max_connections).await.map_err(|error| format!("database connection failed: {error}"))?;
    vokko_server::migrate(&pool).await.map_err(|error| format!("migration failed: {error}"))?;
    let state = AppState::new(pool, config);
    match command.as_str() {
        "serve" => serve(state).await,
        "seed" => {
            let summary = vokko_server::seed::run(&state).await?;
            println!("vokko-server: {summary}");
            Ok(())
        }
        other => Err(format!("unknown command {other}; use `serve` or `seed`")),
    }
}

async fn serve(state: AppState) -> Result<(), String> {
    sqlx::query("UPDATE presences SET status = 'offline' WHERE NOT pinned AND status <> 'offline'")
        .execute(&state.db)
        .await
        .map_err(|error| error.to_string())?;
    if matches!(state.config.storage, vokko_server::storage::StorageConfig::Local) {
        tokio::fs::create_dir_all(state.attachments_dir()).await.map_err(|error| format!("cannot create the data directory: {error}"))?;
    }
    vokko_server::media::spawn_cleanup(state.clone());
    vokko_server::reminders::spawn(state.clone());
    vokko_server::voice::spawn_tasks(state.clone());
    vokko_server::threads::spawn_sweeper(state.clone());
    vokko_server::apps::spawn_sweeper(state.clone());
    vokko_server::polls::spawn_sweeper(state.clone());
    let bind = state.config.bind.clone();
    let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|error| format!("cannot bind {bind}: {error}"))?;
    tracing::info!("vokko-server listening on http://{bind}");
    // Connection info feeds the per-client-address limits (auth routes, gateway sockets).
    axum::serve(listener, vokko_server::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())
}
