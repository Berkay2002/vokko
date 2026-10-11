//! Gateway session registry: per-session sequence counters with a bounded replay buffer that keeps filling after the socket closes.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use vokko_protocol::api::{GatewayEvent, GatewayOp, GatewayPayload};

/// What a connection task writes to its socket.
#[derive(Debug)]
pub enum Outgoing {
    Text(String),
    Close(u16),
}

struct SessionInner {
    seq: u64,
    buffer: VecDeque<(u64, String)>,
    tx: Option<UnboundedSender<Outgoing>>,
    detached_at: Option<Instant>,
    /// Bumped on every attach so a stale connection task knows it was replaced.
    generation: u64,
}

pub struct Session {
    pub id: String,
    pub user_id: i64,
    capacity: usize,
    inner: Mutex<SessionInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub enum ReplayOutcome {
    Replayed(usize),
    Gap,
}

impl Session {
    /// Assigns the next sequence number, buffers the payload and forwards it to the live connection if there is one.
    fn push(&self, name: &str, data: Value) {
        let mut inner = lock(&self.inner);
        inner.seq += 1;
        let seq = inner.seq;
        let payload = GatewayPayload { op: GatewayOp::Dispatch, d: data, s: Some(seq), t: Some(name.to_owned()) };
        let Ok(text) = serde_json::to_string(&payload) else { return };
        inner.buffer.push_back((seq, text.clone()));
        while inner.buffer.len() > self.capacity {
            inner.buffer.pop_front();
        }
        if let Some(tx) = &inner.tx
            && tx.send(Outgoing::Text(text)).is_err()
        {
            inner.tx = None;
        }
    }

    /// Connects a socket; any previous connection of this session is told to close. Returns the new generation.
    pub fn attach(&self, tx: UnboundedSender<Outgoing>) -> u64 {
        let mut inner = lock(&self.inner);
        if let Some(old) = inner.tx.replace(tx) {
            let _ = old.send(Outgoing::Close(4000));
        }
        inner.detached_at = None;
        inner.generation += 1;
        inner.generation
    }

    /// Detaches only if `generation` is still the current connection. Returns whether it was.
    pub fn detach(&self, generation: u64) -> bool {
        let mut inner = lock(&self.inner);
        if inner.generation != generation {
            return false;
        }
        inner.tx = None;
        inner.detached_at = Some(Instant::now());
        true
    }

    /// Re-sends buffered dispatches newer than `seq` to the attached connection.
    pub fn replay_after(&self, seq: u64) -> ReplayOutcome {
        let inner = lock(&self.inner);
        let oldest = inner.buffer.front().map(|(first, _)| *first).unwrap_or(inner.seq + 1);
        if seq > inner.seq || seq + 1 < oldest {
            return ReplayOutcome::Gap;
        }
        let mut count = 0;
        if let Some(tx) = &inner.tx {
            for (_, text) in inner.buffer.iter().filter(|(entry, _)| *entry > seq) {
                if tx.send(Outgoing::Text(text.clone())).is_err() {
                    break;
                }
                count += 1;
            }
        }
        ReplayOutcome::Replayed(count)
    }

    pub fn dispatch(&self, name: &str, data: Value) {
        self.push(name, data);
    }
}

pub struct Hub {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    connections: Mutex<HashMap<i64, usize>>,
    capacity: usize,
    ttl: Duration,
}

impl Hub {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self { sessions: Mutex::new(HashMap::new()), connections: Mutex::new(HashMap::new()), capacity, ttl }
    }

    pub fn create_session(&self, user_id: i64, id: String) -> Arc<Session> {
        let session = Arc::new(Session {
            id: id.clone(),
            user_id,
            capacity: self.capacity,
            inner: Mutex::new(SessionInner { seq: 0, buffer: VecDeque::new(), tx: None, detached_at: None, generation: 0 }),
        });
        let mut sessions = lock(&self.sessions);
        let ttl = self.ttl;
        sessions.retain(|_, existing| lock(&existing.inner).detached_at.is_none_or(|since| since.elapsed() < ttl));
        sessions.insert(id, session.clone());
        session
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
    }

    pub fn remove_session(&self, id: &str) {
        lock(&self.sessions).remove(id);
    }

    /// Returns true when this is the user's first live connection.
    pub fn connection_opened(&self, user_id: i64) -> bool {
        let mut connections = lock(&self.connections);
        let count = connections.entry(user_id).or_insert(0);
        *count += 1;
        *count == 1
    }

    /// Returns true when it was the user's last live connection.
    pub fn connection_closed(&self, user_id: i64) -> bool {
        let mut connections = lock(&self.connections);
        let Some(count) = connections.get_mut(&user_id) else { return false };
        *count = count.saturating_sub(1);
        if *count == 0 {
            connections.remove(&user_id);
            return true;
        }
        false
    }

    pub fn is_online(&self, user_id: i64) -> bool {
        lock(&self.connections).get(&user_id).is_some_and(|count| *count > 0)
    }

    /// Same payload for everyone in `users`.
    pub fn send(&self, users: &[i64], event: &GatewayEvent) {
        let data = event.data();
        self.send_with(users, event.name(), |_| data.clone());
    }

    /// Payload may depend on the receiving user (reaction `me`, DM recipients).
    pub fn send_with(&self, users: &[i64], name: &str, data: impl Fn(i64) -> Value) {
        let wanted: HashSet<i64> = users.iter().copied().collect();
        if wanted.is_empty() {
            return;
        }
        let sessions: Vec<Arc<Session>> = lock(&self.sessions).values().filter(|session| wanted.contains(&session.user_id)).cloned().collect();
        for session in sessions {
            session.dispatch(name, data(session.user_id));
        }
    }
}
