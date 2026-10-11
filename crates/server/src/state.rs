use std::ops::Deref;
use std::path::PathBuf;
use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::hub::Hub;
use crate::ids::SnowflakeGenerator;
use crate::ratelimit::RateLimiter;
use crate::unfurl::Unfurler;

pub struct Inner {
    pub db: PgPool,
    pub config: Config,
    pub ids: SnowflakeGenerator,
    pub hub: Hub,
    pub limiter: RateLimiter,
    pub unfurler: Unfurler,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        let hub = Hub::new(config.replay_capacity, config.session_ttl);
        let unfurler = Unfurler::new(config.unfurl);
        Self(Arc::new(Inner { db, config, ids: SnowflakeGenerator::new(1), hub, limiter: RateLimiter::default(), unfurler }))
    }

    /// Absolute URL of a stored asset path (`<attachment id>/<filename>`).
    pub fn asset_url(&self, path: &str) -> String {
        format!("{}/api/v1/attachments/{path}", self.config.public_url)
    }

    pub fn attachments_dir(&self) -> PathBuf {
        self.config.data_dir.join("attachments")
    }
}
