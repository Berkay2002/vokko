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
use crate::soundboard::Plays;
use crate::storage::{self, Storage};
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
    /// Soundboard plays, for the per-channel play limit.
    pub soundboard: Plays,
    /// Entrance sound plays, for their own per-user and channel limit.
    pub entrances: Plays,
    /// Attachment bytes (`storage::StorageConfig`).
    pub storage: Arc<dyn Storage>,
    /// In-flight uploads per user (`media::MAX_CONCURRENT_UPLOADS`).
    pub uploads: crate::media::UploadSlots,
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
        let rooms = voice::room_services(&config);
        Self::with_room_services(db, config, rooms)
    }

    /// Like `new`, with an explicit LiveKit RoomService as the only backend (tests pass a fake).
    pub fn with_room_service(db: PgPool, config: Config, rooms: Arc<dyn RoomService>) -> Self {
        Self::with_room_services(db, config, vec![rooms])
    }

    /// Like `new`, with one explicit RoomService per LiveKit backend, in the order of `config.livekit`.
    pub fn with_room_services(db: PgPool, config: Config, rooms: Vec<Arc<dyn RoomService>>) -> Self {
        let storage = storage::build(&config.storage, &config.data_dir);
        Self::assemble(db, config, rooms, storage)
    }

    /// Like `new`, with an attachment backend of the caller's choosing (tests pass one that fails or stalls on demand).
    pub fn with_storage(db: PgPool, config: Config, storage: Arc<dyn Storage>) -> Self {
        let rooms = voice::room_services(&config);
        Self::assemble(db, config, rooms, storage)
    }

    fn assemble(db: PgPool, config: Config, rooms: Vec<Arc<dyn RoomService>>, storage: Arc<dyn Storage>) -> Self {
        let hub = Hub::new(config.replay_capacity, config.session_ttl, config.outgoing_queue);
        let unfurler = Unfurler::new(config.unfurl);
        let accounts = Accounts::new(&config.accounts);
        let gifs = GifProxy::new(config.gif.clone(), config.unfurl.allow_private);
        let voice = Voice::new(rooms, &config);
        Self(Arc::new(Inner {
            db,
            config,
            ids: SnowflakeGenerator::new(1),
            hub,
            limiter: RateLimiter::default(),
            unfurler,
            accounts,
            gifs,
            voice,
            storage,
            soundboard: Plays::default(),
            entrances: Plays::default(),
            uploads: Default::default(),
        }))
    }

    /// Absolute URL of a stored asset path (`<attachment id>/<filename>`).
    pub fn asset_url(&self, path: &str) -> String {
        format!("{}/api/v1/attachments/{path}", self.config.public_url)
    }

    /// Where the local backend keeps files (unused by the other backends).
    pub fn attachments_dir(&self) -> PathBuf {
        self.config.data_dir.join("attachments")
    }

    /// Where uploads are staged while they stream in, before they move to `storage` (every backend).
    pub fn incoming_dir(&self) -> PathBuf {
        self.config.data_dir.join("incoming")
    }
}
