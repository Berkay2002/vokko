//! Attachment storage: files live in `<data dir>/attachments/<attachment id>`.
use std::path::PathBuf;

use crate::state::AppState;

pub fn file_path(state: &AppState, attachment_id: i64) -> PathBuf {
    state.attachments_dir().join(attachment_id.to_string())
}

/// Best-effort removal of stored files (rows are removed by the caller).
pub async fn remove_files(state: &AppState, attachment_ids: &[i64]) {
    for id in attachment_ids {
        let _ = tokio::fs::remove_file(file_path(state, *id)).await;
    }
}
