//! Serializable domain data shared by the engine and its clients. No UI dependencies.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod account;
pub mod api;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Community {
    pub id: String,
    pub name: String,
    pub initials: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Text,
    Voice,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Channel {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub kind: ChannelKind,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub initials: String,
    pub color: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    pub created_at_ms: u64,
}

/// A small local scaffold, not a network protocol or an authenticated server session yet.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Snapshot {
    pub communities: Vec<Community>,
    pub channels: Vec<Channel>,
    pub members: Vec<Member>,
    pub messages: Vec<Message>,
    pub selected_channel_id: String,
    pub current_user_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CommandRequest {
    pub command: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct CommandInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub params: &'static str,
}
