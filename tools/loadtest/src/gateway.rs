//! One simulated gateway client: Hello → Identify/Resume → READY, heartbeats on the server's interval, delivery timing
//! of the messages and presence updates the scenarios stamp with a send time, and drop-and-resume on command.
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::api::User;
use crate::stats::Shared;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const OP_DISPATCH: u8 = 0;
const OP_HEARTBEAT: u8 = 1;
const OP_IDENTIFY: u8 = 2;
const OP_PRESENCE: u8 = 3;
const OP_RESUME: u8 = 6;
const OP_RECONNECT: u8 = 7;
const OP_INVALID_SESSION: u8 = 9;
const OP_HELLO: u8 = 10;

const STEP_TIMEOUT: Duration = Duration::from_secs(30);

pub enum Cmd {
    /// Cut the TCP connection without a close frame, stay away for `offline`, then reconnect with Resume (Identify if the
    /// session is gone).
    Storm {
        offline: Duration,
    },
    /// Gateway op 3.
    Presence {
        status: &'static str,
        custom_status: Option<String>,
    },
    Stop,
}

pub struct Conn {
    pub tx: mpsc::UnboundedSender<Cmd>,
    pub task: JoinHandle<()>,
}

#[derive(Deserialize)]
struct Frame<'a> {
    op: u8,
    #[serde(default)]
    s: Option<u64>,
    #[serde(default)]
    t: Option<&'a str>,
    #[serde(default, borrow)]
    d: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Ready {
    session_id: String,
}

#[derive(Deserialize)]
struct MessageCreate {
    content: String,
}

#[derive(Deserialize)]
struct PresenceUpdate {
    custom_status: Option<String>,
}

#[derive(PartialEq)]
enum Outcome {
    Ready,
    Resumed,
    InvalidSession,
    Reconnect,
    Other,
}

struct State {
    ws_url: String,
    user: User,
    shared: Arc<Shared>,
    ws: Option<Ws>,
    interval: Duration,
    session_id: String,
    seq: Option<u64>,
}

/// Connects, identifies and waits for READY; the returned handle keeps the connection alive in a background task.
pub async fn connect(base: &str, user: User, shared: Arc<Shared>) -> Result<Conn, String> {
    let ws_url = format!("{}/gateway", base.replacen("http", "ws", 1).trim_end_matches('/'));
    let mut state = State { ws_url, user, shared, ws: None, interval: Duration::from_secs(41), session_id: String::new(), seq: None };
    state.dial().await?;
    let started = Instant::now();
    match state.handshake(false).await? {
        Outcome::Ready => state.shared.m().time("identify_ready", started.elapsed()),
        _ => return Err("no READY".to_owned()),
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(state.run(rx));
    Ok(Conn { tx, task })
}

impl State {
    fn fail_close(&self, code: u16) {
        let metrics = self.shared.m();
        metrics.error(&format!("ws_close {code}"));
        if code == 4008 {
            metrics.add("limit_hits:ws_4008", 1);
        }
    }

    /// Opens the socket and reads Hello.
    async fn dial(&mut self) -> Result<(), String> {
        let mut request = self.ws_url.as_str().into_client_request().map_err(|error| error.to_string())?;
        if let Some(addr) = &self.user.addr
            && let Ok(value) = HeaderValue::from_str(addr)
        {
            request.headers_mut().insert("x-forwarded-for", value);
        }
        let started = Instant::now();
        let connected = tokio::time::timeout(STEP_TIMEOUT, connect_async(request)).await;
        let (mut ws, response) = match connected {
            Ok(Ok(pair)) => pair,
            Ok(Err(error)) => {
                let reason = error.to_string();
                self.shared.m().error(&format!("ws_connect {}", reason.chars().take(60).collect::<String>()));
                if reason.contains("429") {
                    self.shared.m().add("limit_hits:ws_429", 1);
                }
                return Err(reason);
            }
            Err(_) => {
                self.shared.m().error("ws_connect timeout");
                return Err("connect timeout".to_owned());
            }
        };
        let _ = response;
        self.shared.m().time("ws_connect", started.elapsed());
        let hello = tokio::time::timeout(STEP_TIMEOUT, async {
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(text) = message
                    && let Ok(frame) = serde_json::from_str::<Frame>(text.as_str())
                    && frame.op == OP_HELLO
                {
                    return frame.d.and_then(|d| serde_json::from_str::<Value>(d.get()).ok()).and_then(|d| d.get("heartbeat_interval").and_then(Value::as_u64));
                }
            }
            None
        })
        .await;
        match hello {
            Ok(Some(ms)) => {
                self.interval = Duration::from_millis(ms.max(50));
                self.ws = Some(ws);
                Ok(())
            }
            _ => {
                self.shared.m().error("no_hello");
                Err("no Hello".to_owned())
            }
        }
    }

    async fn send(&mut self, value: Value) -> bool {
        match self.ws.as_mut() {
            Some(ws) => ws.send(Message::text(value.to_string())).await.is_ok(),
            None => false,
        }
    }

    /// Sends Identify (or Resume) and reads until the server answers.
    async fn handshake(&mut self, resume: bool) -> Result<Outcome, String> {
        let hello = if resume {
            json!({"op": OP_RESUME, "d": {"token": self.user.token, "session_id": self.session_id, "seq": self.seq.unwrap_or(0)}})
        } else {
            self.seq = None;
            json!({"op": OP_IDENTIFY, "d": {"token": self.user.token}})
        };
        if !self.send(hello).await {
            return Err("send failed".to_owned());
        }
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        loop {
            let Some(ws) = self.ws.as_mut() else { return Err("no socket".to_owned()) };
            let next = match tokio::time::timeout_at(deadline, ws.next()).await {
                Ok(next) => next,
                Err(_) => {
                    self.shared.m().error(if resume { "resume timeout" } else { "identify timeout" });
                    return Err("handshake timeout".to_owned());
                }
            };
            match next {
                Some(Ok(Message::Text(text))) => match self.on_text(text.as_str()) {
                    Outcome::Other => {}
                    outcome => return Ok(outcome),
                },
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.map(|frame| u16::from(frame.code)).unwrap_or(0);
                    self.fail_close(code);
                    return Err(format!("closed with {code}"));
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    self.shared.m().error("ws_error");
                    return Err("socket error".to_owned());
                }
            }
        }
    }

    /// Handles one text frame; the outcome tells the handshake loops what arrived.
    fn on_text(&mut self, text: &str) -> Outcome {
        let Ok(frame) = serde_json::from_str::<Frame>(text) else { return Outcome::Other };
        match frame.op {
            OP_INVALID_SESSION => return Outcome::InvalidSession,
            OP_RECONNECT => return Outcome::Reconnect,
            OP_DISPATCH => {}
            _ => return Outcome::Other,
        }
        let metrics = self.shared.m();
        if let Some(s) = frame.s {
            match self.seq {
                // a dispatch that was already seen, or arrives after a newer one: replay racing a live event
                Some(previous) if s <= previous => metrics.add("seq_out_of_order", 1),
                // a dispatch that never arrived: the contract's "resume replays what was missed" is broken
                Some(previous) if s > previous + 1 => metrics.add("seq_skips", 1),
                _ => {}
            }
            self.seq = self.seq.map_or(s, |previous| previous.max(s)).into();
        }
        let data = frame.d.map(RawValue::get).unwrap_or("null");
        match frame.t.unwrap_or("") {
            "READY" => {
                if let Ok(ready) = serde_json::from_str::<Ready>(data) {
                    self.session_id = ready.session_id;
                }
                metrics.hist("size:ready_bytes").record(text.len() as u64);
                return Outcome::Ready;
            }
            "RESUMED" => return Outcome::Resumed,
            "MESSAGE_CREATE" => {
                if let Ok(message) = serde_json::from_str::<MessageCreate>(data)
                    && let Some(sent_us) = stamped(&message.content, "lt")
                {
                    metrics.time("delivery:message", Duration::from_micros(self.shared.now_us().saturating_sub(sent_us)));
                    metrics.add("recv:message", 1);
                }
            }
            "TYPING_START" => metrics.add("recv:typing", 1),
            "PRESENCE_UPDATE" => match serde_json::from_str::<PresenceUpdate>(data).ok().and_then(|update| update.custom_status) {
                Some(status) if stamped(&status, "lt").is_some() => {
                    let sent_us = stamped(&status, "lt").unwrap_or(0);
                    metrics.time("delivery:presence", Duration::from_micros(self.shared.now_us().saturating_sub(sent_us)));
                    metrics.add("recv:presence_stamped", 1);
                }
                _ => metrics.add("recv:presence_other", 1),
            },
            _ => metrics.add("recv:other_events", 1),
        }
        Outcome::Other
    }

    fn heartbeat_timer(&self) -> tokio::time::Interval {
        // Like the real client: the first beat after random() * interval, then every interval.
        let first = self.interval.mul_f64(rand::random::<f64>());
        let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + first, self.interval);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        timer
    }

    /// Abrupt disconnect, then resume. False when the connection could not be restored.
    async fn storm(&mut self, offline: Duration) -> bool {
        self.ws = None;
        tokio::time::sleep(offline).await;
        let started = Instant::now();
        for attempt in 0..4_u32 {
            if self.dial().await.is_err() {
                tokio::time::sleep(Duration::from_millis(250 << attempt)).await;
                continue;
            }
            match self.handshake(true).await {
                Ok(Outcome::Resumed) => {
                    let metrics = self.shared.m();
                    metrics.time("resume", started.elapsed());
                    metrics.add("resumed", 1);
                    return true;
                }
                Ok(Outcome::InvalidSession) => {
                    self.shared.m().add("resume_invalid_session", 1);
                    let identified = matches!(self.handshake(false).await, Ok(Outcome::Ready));
                    if identified {
                        self.shared.m().time("reidentify", started.elapsed());
                    }
                    return identified;
                }
                _ => {}
            }
        }
        false
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Cmd>) {
        let mut beats = self.heartbeat_timer();
        while let Some(ws) = self.ws.as_mut() {
            tokio::select! {
                incoming = ws.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if self.on_text(text.as_str()) == Outcome::Reconnect {
                            if !self.storm(Duration::ZERO).await {
                                break;
                            }
                            beats = self.heartbeat_timer();
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        self.fail_close(frame.map(|frame| u16::from(frame.code)).unwrap_or(0));
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => {
                        self.shared.m().error("ws_error");
                        break;
                    }
                },
                _ = beats.tick() => {
                    let d = self.seq.map(Value::from).unwrap_or(Value::Null);
                    if !self.send(json!({"op": OP_HEARTBEAT, "d": d})).await {
                        break;
                    }
                }
                command = commands.recv() => match command {
                    Some(Cmd::Storm { offline }) => {
                        if !self.storm(offline).await {
                            break;
                        }
                        beats = self.heartbeat_timer();
                    }
                    Some(Cmd::Presence { status, custom_status }) => {
                        if !self.send(json!({"op": OP_PRESENCE, "d": {"status": status, "custom_status": custom_status}})).await {
                            break;
                        }
                    }
                    Some(Cmd::Stop) | None => {
                        if let Some(ws) = self.ws.as_mut() {
                            let _ = ws.close(None).await;
                        }
                        break;
                    }
                },
            }
        }
    }
}

/// `"<tag> <microseconds> ..."` or `"<tag>:<microseconds>"` → the send time stamped by the sender.
pub fn stamped(text: &str, tag: &str) -> Option<u64> {
    let rest = text.strip_prefix(tag)?;
    let rest = rest.strip_prefix(' ').or_else(|| rest.strip_prefix(':'))?;
    rest.split(' ').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_round_trip() {
        assert_eq!(stamped("lt 123456", "lt"), Some(123_456));
        assert_eq!(stamped("lt 123456 7", "lt"), Some(123_456), "only the first field is the stamp");
        assert_eq!(stamped("lt:99", "lt"), Some(99));
        assert_eq!(stamped("hello", "lt"), None);
        assert_eq!(stamped("lt abc", "lt"), None);
    }

    #[test]
    fn dispatches_update_sequence_and_flag_gaps() {
        let shared = Arc::new(Shared::new());
        let user = User { index: 0, token: "t".into(), addr: None };
        let mut state =
            State { ws_url: String::new(), user, shared: shared.clone(), ws: None, interval: Duration::from_secs(1), session_id: String::new(), seq: None };
        let send_us = shared.now_us();
        let frame = |s: u64, name: &str, d: Value| json!({"op": 0, "s": s, "t": name, "d": d}).to_string();
        assert!(state.on_text(&frame(1, "READY", json!({"session_id": "abc"}))) == Outcome::Ready);
        assert_eq!(state.session_id, "abc");
        state.on_text(&frame(2, "MESSAGE_CREATE", json!({"content": format!("lt {send_us} 7")})));
        state.on_text(&frame(4, "TYPING_START", json!({})));
        let metrics = shared.m();
        assert_eq!(metrics.counter("recv:message"), 1);
        assert_eq!(metrics.counter("recv:typing"), 1);
        assert_eq!(metrics.counter("seq_skips"), 1, "3 was skipped");
        state.on_text(&frame(3, "TYPING_START", json!({})));
        assert_eq!(metrics.counter("seq_out_of_order"), 1);
        assert_eq!(state.seq, Some(4));
        assert!(state.on_text(&json!({"op": 9, "d": false}).to_string()) == Outcome::InvalidSession);
    }
}
