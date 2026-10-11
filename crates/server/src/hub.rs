//! Gateway session registry: per-session sequence counters with a bounded replay buffer that keeps filling after the socket closes.
//!
//! Every connection reads from a bounded queue. A reader that falls behind overflows it; the session is then detached and the
//! connection told to close (1013), the events stay in the replay buffer for a resume. Closes (replaced connection, logout,
//! overflow) travel on a separate signal so they never wait behind queued frames.
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{Notify, mpsc};
use vokko_protocol::api::{GatewayEvent, GatewayOp, GatewayPayload};

/// Close code for a connection that was replaced by a newer one of the same session.
pub const CLOSE_REPLACED: u16 = 4000;
/// Close code for a connection whose outgoing queue overflowed ("try again later": resume with the last sequence).
pub const CLOSE_SLOW_CONSUMER: u16 = 1013;

const IDENTIFY_WINDOW: Duration = Duration::from_secs(60);

/// One-shot "close with this code now" signal from the hub to a connection task.
#[derive(Default)]
pub struct CloseSignal {
    code: AtomicU16,
    notify: Notify,
}

impl CloseSignal {
    /// The first code wins.
    fn fire(&self, code: u16) {
        let _ = self.code.compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
        self.notify.notify_one();
    }

    /// The code, if a close was requested (it is stored before the hub drops its end of the queue).
    pub fn fired(&self) -> Option<u16> {
        Some(self.code.load(Ordering::Acquire)).filter(|code| *code != 0)
    }

    pub async fn wait(&self) -> u16 {
        self.notify.notified().await;
        self.code.load(Ordering::Acquire)
    }
}

/// The hub's side of a connection.
#[derive(Clone)]
pub struct Link {
    queue: mpsc::Sender<String>,
    signal: Arc<CloseSignal>,
}

/// The connection task's side.
pub struct LinkReceiver {
    pub queue: mpsc::Receiver<String>,
    pub signal: Arc<CloseSignal>,
}

pub fn link(capacity: usize) -> (Link, LinkReceiver) {
    let (tx, rx) = mpsc::channel(capacity.max(1));
    let signal = Arc::new(CloseSignal::default());
    (Link { queue: tx, signal: signal.clone() }, LinkReceiver { queue: rx, signal })
}

impl Link {
    /// Queues a frame; a full queue closes the connection. Returns false when the frame was not queued.
    fn offer(&self, text: String) -> bool {
        match self.queue.try_send(text) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.signal.fire(CLOSE_SLOW_CONSUMER);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    fn close(&self, code: u16) {
        self.signal.fire(code);
    }
}

struct SessionInner {
    seq: u64,
    buffer: VecDeque<(u64, String)>,
    link: Option<Link>,
    detached_at: Option<Instant>,
    /// Bumped on every attach so a stale connection task knows it was replaced.
    generation: u64,
}

pub struct Session {
    pub id: String,
    pub user_id: i64,
    /// SHA-256 of the token the session was identified with; logout of that token ends the session.
    token_hash: Vec<u8>,
    capacity: usize,
    inner: Mutex<SessionInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub enum ResumeOutcome {
    /// Attached as `generation`; `replayed` buffered frames were queued ahead of the `resumed` frame.
    Resumed { generation: u64, replayed: usize },
    /// `seq` is ahead of the session or older than the replay buffer.
    Gap,
}

impl Session {
    /// Assigns the next sequence number, buffers the payload and forwards it to the live connection if there is one.
    fn push(&self, name: &str, data: Value) {
        let mut inner = lock(&self.inner);
        self.push_locked(&mut inner, name, data);
    }

    fn push_locked(&self, inner: &mut SessionInner, name: &str, data: Value) {
        inner.seq += 1;
        let seq = inner.seq;
        let payload = GatewayPayload { op: GatewayOp::Dispatch, d: data, s: Some(seq), t: Some(name.to_owned()) };
        let Ok(text) = serde_json::to_string(&payload) else { return };
        inner.buffer.push_back((seq, text.clone()));
        while inner.buffer.len() > self.capacity {
            inner.buffer.pop_front();
        }
        if inner.link.as_ref().is_some_and(|link| !link.offer(text)) {
            inner.link = None;
            inner.detached_at.get_or_insert_with(Instant::now);
        }
    }

    /// Connects a socket; any previous connection of this session is told to close. Returns the new generation.
    pub fn attach(&self, link: Link) -> u64 {
        let mut inner = lock(&self.inner);
        if let Some(old) = inner.link.replace(link) {
            old.close(CLOSE_REPLACED);
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
        inner.link = None;
        inner.detached_at = Some(Instant::now());
        true
    }

    /// Ends the live connection (if any) with `code`; the session can no longer be resumed once the hub forgets it.
    fn terminate(&self, code: u16) {
        let mut inner = lock(&self.inner);
        if let Some(link) = inner.link.take() {
            link.close(code);
        }
        inner.detached_at.get_or_insert_with(Instant::now);
    }

    /// Resume: checks that the buffer still reaches back to `seq`, attaches `link`, re-sends the buffered dispatches newer than
    /// `seq` and queues the `resumed` frame, all under one lock. A dispatch can therefore never slip between the attach and the
    /// replay (it would be delivered twice, or ahead of older buffered ones). On a gap nothing is attached: the connection the
    /// session still had is closed like a replaced one and the caller forgets the session.
    pub fn resume(&self, link: Link, seq: u64, resumed: (&str, Value)) -> ResumeOutcome {
        let mut inner = lock(&self.inner);
        let oldest = inner.buffer.front().map(|(first, _)| *first).unwrap_or(inner.seq + 1);
        if seq > inner.seq || seq + 1 < oldest {
            if let Some(old) = inner.link.take() {
                old.close(CLOSE_REPLACED);
            }
            inner.detached_at.get_or_insert_with(Instant::now);
            return ResumeOutcome::Gap;
        }
        if let Some(old) = inner.link.replace(link) {
            old.close(CLOSE_REPLACED);
        }
        inner.detached_at = None;
        inner.generation += 1;
        let generation = inner.generation;
        let mut replayed = 0;
        let mut overflowed = false;
        if let Some(link) = &inner.link {
            for (_, text) in inner.buffer.iter().filter(|(entry, _)| *entry > seq) {
                if !link.offer(text.clone()) {
                    overflowed = true;
                    break;
                }
                replayed += 1;
            }
        }
        if overflowed {
            inner.link = None;
            inner.detached_at.get_or_insert_with(Instant::now);
        }
        self.push_locked(&mut inner, resumed.0, resumed.1);
        ResumeOutcome::Resumed { generation, replayed }
    }

    pub fn dispatch(&self, name: &str, data: Value) {
        self.push(name, data);
    }
}

pub struct Hub {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    connections: Mutex<HashMap<i64, usize>>,
    identifies: Mutex<HashMap<i64, (Instant, u32)>>,
    preauth: Mutex<HashMap<IpAddr, usize>>,
    capacity: usize,
    ttl: Duration,
    queue_capacity: usize,
}

impl Hub {
    pub fn new(capacity: usize, ttl: Duration, queue_capacity: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            identifies: Mutex::new(HashMap::new()),
            preauth: Mutex::new(HashMap::new()),
            capacity,
            ttl,
            queue_capacity,
        }
    }

    /// A fresh bounded queue for one connection. It always has room for a full replay buffer plus some live events.
    pub fn new_link(&self) -> (Link, LinkReceiver) {
        link(self.queue_capacity.max(self.capacity + 64))
    }

    fn new_session(&self, user_id: i64, id: String, token_hash: Vec<u8>, link: Option<Link>) -> Arc<Session> {
        let generation = u64::from(link.is_some());
        Arc::new(Session {
            id,
            user_id,
            token_hash,
            capacity: self.capacity,
            inner: Mutex::new(SessionInner { seq: 0, buffer: VecDeque::new(), link, detached_at: None, generation }),
        })
    }

    fn register(&self, session: &Arc<Session>) {
        let mut sessions = lock(&self.sessions);
        let ttl = self.ttl;
        sessions.retain(|_, existing| lock(&existing.inner).detached_at.is_none_or(|since| since.elapsed() < ttl));
        sessions.insert(session.id.clone(), session.clone());
    }

    /// A registered session without a connection (the caller attaches one).
    pub fn create_session(&self, user_id: i64, id: String, token_hash: Vec<u8>) -> Arc<Session> {
        let session = self.new_session(user_id, id, token_hash, None);
        self.register(&session);
        session
    }

    /// Identify: a session that is attached to `link` and already holds `READY` as sequence 1 when it becomes visible to dispatchers,
    /// so no event can be numbered ahead of READY or buffered without a connection. Returns it with the connection's generation.
    pub fn open_session(&self, user_id: i64, id: String, token_hash: Vec<u8>, link: Link, ready: Value) -> (Arc<Session>, u64) {
        let session = self.new_session(user_id, id, token_hash, Some(link));
        session.push("READY", ready);
        self.register(&session);
        let generation = lock(&session.inner).generation;
        (session, generation)
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
    }

    pub fn remove_session(&self, id: &str) {
        lock(&self.sessions).remove(id);
    }

    /// Logout: closes every live connection identified with this token (`code`) and forgets those sessions.
    pub fn close_token_sessions(&self, token_hash: &[u8], code: u16) {
        let victims: Vec<Arc<Session>> = {
            let mut sessions = lock(&self.sessions);
            let ids: Vec<String> = sessions.iter().filter(|(_, session)| session.token_hash == token_hash).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        for session in victims {
            session.terminate(code);
        }
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

    /// Counts an Identify for `user_id` in a fixed one-minute window; false once `limit` is used up.
    pub fn allow_identify(&self, user_id: i64, limit: u32) -> bool {
        let now = Instant::now();
        let mut identifies = lock(&self.identifies);
        if identifies.len() > 1024 {
            identifies.retain(|_, (started, _)| now.saturating_duration_since(*started) < IDENTIFY_WINDOW);
        }
        let entry = identifies.entry(user_id).or_insert((now, 0));
        if now.saturating_duration_since(entry.0) >= IDENTIFY_WINDOW {
            *entry = (now, 0);
        }
        if entry.1 >= limit {
            return false;
        }
        entry.1 += 1;
        true
    }

    /// Reserves one of the `limit` pre-auth sockets of `ip`; `None` when it has them all.
    pub fn preauth_acquire(&self, ip: IpAddr, limit: usize) -> Option<()> {
        let mut preauth = lock(&self.preauth);
        let count = preauth.entry(ip).or_insert(0);
        if *count >= limit {
            return None;
        }
        *count += 1;
        Some(())
    }

    pub fn preauth_release(&self, ip: IpAddr) {
        let mut preauth = lock(&self.preauth);
        if let Some(count) = preauth.get_mut(&ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                preauth.remove(&ip);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(queue: usize) -> Hub {
        Hub::new(100, Duration::from_secs(60), queue)
    }

    #[tokio::test]
    async fn a_full_queue_detaches_the_session_and_signals_the_close() {
        let hub = hub(3);
        let session = hub.create_session(1, "s".to_owned(), vec![1]);
        let (tight, mut receiver) = super::link(3);
        let generation = session.attach(tight);
        for n in 0..3 {
            session.dispatch("X", Value::from(n));
        }
        assert!(!session.detach(generation + 1), "a stale generation never detaches");
        session.dispatch("X", Value::from(3));
        assert_eq!(receiver.signal.wait().await, CLOSE_SLOW_CONSUMER);
        // later events only reach the replay buffer, which a resume can read
        session.dispatch("X", Value::from(4));
        let (roomy, mut again) = super::link(16);
        let outcome = session.resume(roomy, 0, ("RESUMED", Value::Null));
        assert!(matches!(outcome, ResumeOutcome::Resumed { replayed: 5, .. }), "the overflowed events are in the replay buffer");
        assert_eq!(again.queue.recv().await.map(|text| text.contains("\"s\":1")), Some(true));
        assert!(receiver.queue.recv().await.is_some(), "frames queued before the overflow stay readable");
    }

    #[tokio::test]
    async fn logout_closes_only_that_token_and_forgets_the_session() {
        let hub = hub(8);
        let kept = hub.create_session(1, "kept".to_owned(), vec![9]);
        let ended = hub.create_session(1, "ended".to_owned(), vec![7]);
        let (kept_link, kept_receiver) = hub.new_link();
        let (ended_link, ended_receiver) = hub.new_link();
        kept.attach(kept_link);
        ended.attach(ended_link);
        hub.close_token_sessions(&[7], 4004);
        assert_eq!(ended_receiver.signal.wait().await, 4004);
        assert!(hub.session("ended").is_none() && hub.session("kept").is_some());
        assert!(tokio::time::timeout(Duration::from_millis(50), kept_receiver.signal.wait()).await.is_err());
    }

    #[test]
    fn a_connection_queue_always_fits_a_full_replay() {
        let hub = Hub::new(100, Duration::from_secs(60), 3);
        let session = hub.create_session(1, "s".to_owned(), vec![1]);
        for n in 0..100 {
            session.dispatch("X", Value::from(n));
        }
        let (link, _receiver) = hub.new_link();
        assert!(matches!(session.resume(link, 0, ("RESUMED", Value::Null)), ResumeOutcome::Resumed { replayed: 100, .. }));
    }

    #[test]
    fn a_gap_attaches_nothing_and_closes_the_old_connection() {
        let hub = Hub::new(5, Duration::from_secs(60), 8);
        let session = hub.create_session(1, "s".to_owned(), vec![1]);
        let (old, mut old_receiver) = hub.new_link();
        session.attach(old);
        for n in 0..10 {
            session.dispatch("X", Value::from(n));
        }
        let (fresh, mut fresh_receiver) = hub.new_link();
        // the buffer holds seq 6..=10 only; 2 is too old, 11 has not happened yet
        for seq in [2, 11] {
            assert!(matches!(session.resume(fresh.clone(), seq, ("RESUMED", Value::Null)), ResumeOutcome::Gap), "seq {seq}");
        }
        assert_eq!(old_receiver.signal.fired(), Some(CLOSE_REPLACED));
        assert!(fresh_receiver.queue.try_recv().is_err(), "nothing was sent to the resuming connection");
        assert!(old_receiver.queue.try_recv().is_ok(), "frames queued earlier stay readable");
    }

    /// Sequence numbers of every frame the connection received so far.
    fn received(receiver: &mut LinkReceiver) -> Vec<u64> {
        let mut seqs = Vec::new();
        while let Ok(text) = receiver.queue.try_recv() {
            let payload: GatewayPayload = serde_json::from_str(&text).expect("frame");
            seqs.push(payload.s.expect("dispatch carries a sequence"));
        }
        seqs
    }

    /// Events dispatched while a resume is in flight must neither be sent twice nor jump ahead of the replayed ones.
    #[test]
    fn resume_is_atomic_with_concurrent_dispatch() {
        for round in 0..1500 {
            let hub = Hub::new(1000, Duration::from_secs(60), 2048);
            let session = hub.create_session(1, "s".to_owned(), vec![1]);
            for n in 0..600 {
                session.dispatch("OLD", Value::from(n));
            }
            let (link, mut receiver) = hub.new_link();
            let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let producer = {
                let (session, started) = (session.clone(), started.clone());
                std::thread::spawn(move || {
                    started.store(true, Ordering::Release);
                    for n in 0..300 {
                        session.dispatch("LIVE", Value::from(n));
                    }
                })
            };
            while !started.load(Ordering::Acquire) {
                std::hint::spin_loop();
            }
            let outcome = session.resume(link, 0, ("RESUMED", Value::Null));
            assert!(matches!(outcome, ResumeOutcome::Resumed { replayed: 600.., .. }));
            producer.join().expect("producer");
            let seqs = received(&mut receiver);
            let expected: Vec<u64> = (1..=901).collect();
            let first_bad = seqs.iter().zip(&expected).position(|(got, want)| got != want);
            assert!(
                seqs == expected,
                "round {round}: {} frames, first out of place at {first_bad:?}: {:?}",
                seqs.len(),
                first_bad.map(|at| &seqs[at.saturating_sub(1)..=at])
            );
        }
    }

    #[test]
    fn identifies_and_preauth_sockets_are_capped() {
        let hub = hub(8);
        for _ in 0..3 {
            assert!(hub.allow_identify(5, 3));
        }
        assert!(!hub.allow_identify(5, 3));
        assert!(hub.allow_identify(6, 3), "other users have their own window");

        let ip: IpAddr = "10.0.0.1".parse().expect("ip");
        assert!(hub.preauth_acquire(ip, 2).is_some() && hub.preauth_acquire(ip, 2).is_some());
        assert!(hub.preauth_acquire(ip, 2).is_none());
        hub.preauth_release(ip);
        assert!(hub.preauth_acquire(ip, 2).is_some());
    }
}
