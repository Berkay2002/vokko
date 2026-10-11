//! Shared command metadata and implementations.
use crate::{EngineError, Result, Session};
use serde::Deserialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use vokko_protocol::{ChannelKind, Message};

type Run = fn(&mut Session, &Value) -> Result<Value>;
type Enabled = fn(&Session) -> std::result::Result<(), String>;

/// Metadata and implementation for an action, shared by every shell.
pub struct CommandSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub params: &'static str,
    pub enabled: Enabled,
    pub run: Run,
}

fn always(_: &Session) -> std::result::Result<(), String> {
    Ok(())
}

pub fn command_specs() -> &'static [CommandSpec] {
    &[
        CommandSpec { id: "session.inspect", label: "Inspect session", params: "{}", enabled: always, run: inspect },
        CommandSpec { id: "channel.select", label: "Select channel", params: "{channel_id: string}", enabled: always, run: select_channel },
        CommandSpec { id: "message.send", label: "Send local message", params: "{channel_id: string, content: string}", enabled: always, run: send_message },
    ]
}

fn inspect(session: &mut Session, _: &Value) -> Result<Value> {
    Ok(serde_json::to_value(session.snapshot())?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectChannel {
    channel_id: String,
}

fn select_channel(session: &mut Session, params: &Value) -> Result<Value> {
    let params: SelectChannel = serde_json::from_value(params.clone()).map_err(|e| EngineError::BadParams(e.to_string()))?;
    if !session.snapshot.channels.iter().any(|channel| channel.id == params.channel_id) {
        return Err(EngineError::BadParams("channel does not exist".into()));
    }
    session.snapshot.selected_channel_id = params.channel_id;
    inspect(session, &Value::Null)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendMessage {
    channel_id: String,
    content: String,
}

fn send_message(session: &mut Session, params: &Value) -> Result<Value> {
    let params: SendMessage = serde_json::from_value(params.clone()).map_err(|e| EngineError::BadParams(e.to_string()))?;
    let channel = session
        .snapshot
        .channels
        .iter()
        .find(|channel| channel.id == params.channel_id)
        .ok_or_else(|| EngineError::BadParams("channel does not exist".into()))?;
    if !matches!(channel.kind, ChannelKind::Text) {
        return Err(EngineError::Disabled("voice channels do not accept messages yet".into()));
    }
    let content = params.content.trim();
    if content.is_empty() || content.chars().count() > 2000 {
        return Err(EngineError::BadParams("messages must contain between 1 and 2000 characters".into()));
    }
    // Bound the scaffold's memory use; durable history belongs in a later storage module.
    if session.snapshot.messages.len() >= 1000 {
        return Err(EngineError::Disabled("local message limit reached; restart to reset the demo".into()));
    }
    let next = session.next_message_id.checked_add(1).ok_or_else(|| EngineError::Disabled("local message identifiers exhausted".into()))?;
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    session.snapshot.messages.push(Message {
        id: format!("local-{}", session.next_message_id),
        channel_id: params.channel_id,
        author_id: session.snapshot.current_user_id.clone(),
        content: content.to_owned(),
        created_at_ms: u64::try_from(millis).unwrap_or(u64::MAX),
    });
    session.next_message_id = next;
    inspect(session, &Value::Null)
}
