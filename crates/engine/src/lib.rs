//! UI-independent local session. Desktop and CLI dispatch the same commands.
mod commands;

pub use commands::{CommandSpec, command_specs};
use serde_json::Value;
use vokko_protocol::{CommandInfo, CommandRequest, Snapshot};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("unknown command: {0}")]
    UnknownCommand(String),
    #[error("invalid parameters: {0}")]
    BadParams(String),
    #[error("{0}")]
    Disabled(String),
    #[error("could not serialize session: {0}")]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, EngineError>;

pub struct Session {
    pub(crate) snapshot: Snapshot,
    pub(crate) next_message_id: u64,
}

impl Session {
    pub fn demo() -> Result<Self> {
        let snapshot = serde_json::from_str(include_str!("../../../fixtures/demo.json"))?;
        Ok(Self { snapshot, next_message_id: 1 })
    }

    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    pub fn commands(&self) -> Vec<CommandInfo> {
        command_specs().iter().map(|spec| CommandInfo { id: spec.id, label: spec.label, params: spec.params }).collect()
    }

    pub fn dispatch(&mut self, request: CommandRequest) -> Result<Value> {
        let spec = command_specs().iter().find(|spec| spec.id == request.command).ok_or_else(|| EngineError::UnknownCommand(request.command.clone()))?;
        (spec.enabled)(self).map_err(EngineError::Disabled)?;
        (spec.run)(self, &request.params)
    }
}
