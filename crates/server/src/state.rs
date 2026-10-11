use std::ops::Deref;
use std::path::PathBuf;
use std::sync::Arc;

use sqlx::PgPool;

use crate::account::Accounts;
use crate::config::Config;
use crate::gifs::GifProxy;
use crate::hub::Hub;
use crate::ids::SnowflakeGenerator;
use crate::ratelimit::RateLimiter;
use crate::unfurl::Unfurler;
use crate::voice::{self, Voice, livekit::RoomService};

pub struct Inner {
    pub db: PgPool,
    pub config: Config,
    pub ids: SnowflakeGenerator,
    pub hub: Hub,
    pub limiter: RateLimiter,
    pub unfurler: Unfurler,
    pub accounts: Accounts,
    pub gifs: GifProxy,
    pub voice: Voice,
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
        let rooms = voice::room_service(&config);
        Self::with_room_service(db, config, rooms)
    }

    /// Like `new`, with an explicit LiveKit RoomService (tests pass a fake).
    pub fn with_room_service(db: PgPool, config: Config, rooms: Arc<dyn RoomService>) -> Self {
        let hub = Hub::new(config.replay_capacity, config.session_ttl, config.outgoing_queue);
        let unfurler = Unfurler::new(config.unfurl);
        let accounts = Accounts::new(&config.accounts);
        let gifs = GifProxy::new(config.gif.clone());
        let voice = Voice::new(rooms);
        Self(Arc::new(Inner { db, config, ids: SnowflakeGenerator::new(1), hub, limiter: RateLimiter::default(), unfurler, accounts, gifs, voice }))
    }

    /// Absolute URL of a stored asset path (`<attachment id>/<filename>`).
    pub fn asset_url(&self, path: &str) -> String {
        format!("{}/api/v1/attachments/{path}", self.config.public_url)
    }

    pub fn attachments_dir(&self) -> PathBuf {
        self.config.data_dir.join("attachments")
    }
}
