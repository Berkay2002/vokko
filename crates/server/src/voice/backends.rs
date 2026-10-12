//! Multiple LiveKit backends with failover (docs/design/voice.md). Backend `i` is `Config::livekit[i]` and the `i`-th
//! RoomService; the order is the failover order. A room (one per channel) stays on the backend it started on while anyone is
//! in it, so only new rooms are placed here: on the first backend that is not out of rotation.
//!
//! A backend goes out of rotation for `Config::voice_backend_cooldown` when one of its API calls fails with a quota, limit or
//! auth error or cannot be reached (`RoomError::is_unavailable`). The cooldown is passive: it expires by itself, and the first
//! call after that (reconciliation lists every backend each pass) either puts the backend back or starts another cooldown.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::livekit::{NoRoomService, Participant, Permission, RoomError, RoomFuture, RoomService};
use crate::config::Config;

pub struct Backend {
    label: String,
    rooms: Arc<dyn RoomService>,
    cooldown: Duration,
    down_until: Mutex<Option<Instant>>,
    /// A restore from this backend's rooms succeeded since start; until then reconciliation removes none of its participants
    /// (it would take everyone still in a call for an orphan).
    restored: AtomicBool,
}

impl Backend {
    pub fn label(&self) -> &str {
        &self.label
    }

    /// In rotation at `now`: no failure within the cooldown.
    pub fn is_up_at(&self, now: Instant) -> bool {
        self.down_until.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_none_or(|until| now >= until)
    }

    /// Takes the backend out of rotation when `error` says it cannot serve us.
    pub fn note_at(&self, now: Instant, error: &RoomError) {
        if !error.is_unavailable() {
            return;
        }
        let mut down_until = self.down_until.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if down_until.is_none_or(|until| now >= until) {
            tracing::warn!("voice: LiveKit backend {} is out of rotation for new rooms for {:?}: {error}", self.label, self.cooldown);
        }
        *down_until = Some(now + self.cooldown);
    }

    fn tracked<'a, T: Send + 'a>(&'a self, call: RoomFuture<'a, T>) -> RoomFuture<'a, T> {
        Box::pin(async move {
            let result = call.await;
            if let Err(error) = &result {
                self.note_at(Instant::now(), error);
            }
            result
        })
    }

    pub fn is_restored(&self) -> bool {
        self.restored.load(Ordering::SeqCst)
    }

    pub fn set_restored(&self) {
        self.restored.store(true, Ordering::SeqCst);
    }
}

/// Every call both goes to the backend and keeps its health up to date.
impl RoomService for Backend {
    fn list_rooms(&self) -> RoomFuture<'_, Vec<String>> {
        self.tracked(self.rooms.list_rooms())
    }

    fn list_participants<'a>(&'a self, room: &'a str) -> RoomFuture<'a, Vec<Participant>> {
        self.tracked(self.rooms.list_participants(room))
    }

    fn remove_participant<'a>(&'a self, room: &'a str, identity: &'a str) -> RoomFuture<'a, ()> {
        self.tracked(self.rooms.remove_participant(room, identity))
    }

    fn update_participant<'a>(&'a self, room: &'a str, identity: &'a str, permission: &'a Permission) -> RoomFuture<'a, ()> {
        self.tracked(self.rooms.update_participant(room, identity, permission))
    }

    fn mute_published_track<'a>(&'a self, room: &'a str, identity: &'a str, track_sid: &'a str) -> RoomFuture<'a, ()> {
        self.tracked(self.rooms.mute_published_track(room, identity, track_sid))
    }
}

pub struct Backends {
    list: Vec<Backend>,
}

static NONE: NoRoomService = NoRoomService;

impl Backends {
    /// One RoomService per configured backend, in config order.
    pub fn new(rooms: Vec<Arc<dyn RoomService>>, config: &Config) -> Self {
        let list = rooms
            .into_iter()
            .enumerate()
            .map(|(index, rooms)| Backend {
                label: config.livekit.get(index).map_or_else(|| format!("livekit-{}", index + 1), |livekit| livekit.label.clone()),
                rooms,
                cooldown: config.voice_backend_cooldown,
                down_until: Mutex::new(None),
                restored: AtomicBool::new(false),
            })
            .collect();
        Self { list }
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn get(&self, index: usize) -> Option<&Backend> {
        self.list.get(index)
    }

    pub fn iter(&self) -> impl Iterator<Item = (usize, &Backend)> {
        self.list.iter().enumerate()
    }

    /// The RoomService of backend `index` (a no-op one for an index that does not exist: voice is off).
    pub fn room(&self, index: usize) -> &dyn RoomService {
        self.list.get(index).map_or(&NONE as &dyn RoomService, |backend| backend as &dyn RoomService)
    }

    /// Where a new room goes at `now`: the first backend in rotation, or backend 0 when all of them are out (the same
    /// behaviour as a single backend that is failing).
    pub fn pick_at(&self, now: Instant) -> usize {
        self.list.iter().position(|backend| backend.is_up_at(now)).unwrap_or(0)
    }

    pub fn pick(&self) -> usize {
        self.pick_at(Instant::now())
    }

    /// Every backend has been restored from.
    pub fn all_restored(&self) -> bool {
        self.list.iter().all(Backend::is_restored)
    }

    pub fn any_restored(&self) -> bool {
        self.list.iter().any(Backend::is_restored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::livekit::FakeRoomService;

    fn backends(count: usize, cooldown: Duration) -> (Backends, Vec<Arc<FakeRoomService>>) {
        let fakes: Vec<_> = (0..count).map(|_| FakeRoomService::new()).collect();
        let mut config = Config::new(String::new(), String::new(), "/tmp".into(), String::new());
        config.voice_backend_cooldown = cooldown;
        let rooms = fakes.iter().map(|fake| fake.clone() as Arc<dyn RoomService>).collect();
        (Backends::new(rooms, &config), fakes)
    }

    fn quota() -> RoomError {
        RoomError::http("ListRooms", 429, r#"{"code":"resource_exhausted"}"#)
    }

    #[test]
    fn new_rooms_go_to_the_first_backend_in_rotation() {
        let (backends, _) = backends(3, Duration::from_secs(300));
        let now = Instant::now();
        assert_eq!(backends.pick_at(now), 0);
        backends.get(0).expect("backend").note_at(now, &quota());
        assert_eq!(backends.pick_at(now), 1);
        backends.get(1).expect("backend").note_at(now, &RoomError::unreachable("connection refused"));
        assert_eq!(backends.pick_at(now), 2);
        backends.get(2).expect("backend").note_at(now, &RoomError::http("ListRooms", 401, ""));
        assert_eq!(backends.pick_at(now), 0, "all out: backend 0, like a single failing backend");
    }

    #[test]
    fn other_errors_leave_the_backend_in_rotation() {
        let (backends, _) = backends(2, Duration::from_secs(300));
        let now = Instant::now();
        for error in
            [RoomError::http("RemoveParticipant", 404, r#"{"code":"not_found"}"#), RoomError::http("ListRooms", 500, "oops"), RoomError::new("bad JSON")]
        {
            backends.get(0).expect("backend").note_at(now, &error);
        }
        assert_eq!(backends.pick_at(now), 0);
    }

    #[test]
    fn a_backend_is_tried_again_after_the_cooldown() {
        let (backends, _) = backends(2, Duration::from_secs(300));
        let (first, later) = (Instant::now(), Instant::now() + Duration::from_secs(301));
        let primary = backends.get(0).expect("backend");
        primary.note_at(first, &quota());
        assert_eq!(backends.pick_at(first + Duration::from_secs(299)), 1);
        assert_eq!(backends.pick_at(later), 0, "cooldown over: the primary is probed again");
        primary.note_at(later, &quota());
        assert_eq!(backends.pick_at(later + Duration::from_secs(1)), 1, "the probe failed: another cooldown");
    }

    #[tokio::test]
    async fn calls_through_a_backend_update_its_health() {
        let (backends, fakes) = backends(2, Duration::from_secs(300));
        fakes[0].fail_api(429, r#"{"code":"resource_exhausted"}"#);
        assert!(backends.room(0).list_rooms().await.is_err());
        assert_eq!(backends.pick(), 1);
        assert!(backends.room(1).list_rooms().await.is_ok());
        assert_eq!(backends.room(9).list_rooms().await, Ok(Vec::new()), "no such backend: voice off");
    }
}
