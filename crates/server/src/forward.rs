//! Forwarding: the snapshot copy of a message and the file copies behind it.
use vokko_protocol::api::permissions::{ATTACH_FILES, READ_MESSAGE_HISTORY, USE_EXTERNAL_STICKERS};
use vokko_protocol::api::{Attachment, MessageSnapshot, MessageSnapshotContent, MessageType, StickerFormat};

use crate::access::channel_access;
use crate::error::{ApiErr, ApiResult};
use crate::media;
use crate::state::AppState;
use crate::stickers::StickerRef;
use crate::store::{self, ChannelRow, MESSAGE_SELECT, MessageRow};

/// A file copied for a snapshot; the row is inserted together with the forwarded message.
pub struct AttachmentCopy {
    pub id: i64,
    pub key: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub description: Option<String>,
}

pub struct ForwardDraft {
    pub source_channel: i64,
    pub source_guild: Option<i64>,
    pub source_message: i64,
    pub snapshot: MessageSnapshot,
    pub copies: Vec<AttachmentCopy>,
    /// The snapshot's stickers, kept as references so their files outlive the source (`message_stickers.snapshot`).
    pub stickers: Vec<StickerRef>,
}

impl ForwardDraft {
    pub fn copy_ids(&self) -> Vec<i64> {
        self.copies.iter().map(|copy| copy.id).collect()
    }
}

/// Every reason the caller cannot read the source looks the same as the message not existing.
fn unreadable() -> ApiErr {
    ApiErr::unknown_message()
}

/// Hard link where the filesystem allows (files are write-once, so sharing the data is safe), a full copy otherwise.
async fn link_or_copy(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if tokio::fs::hard_link(from, to).await.is_ok() {
        return Ok(());
    }
    tokio::fs::copy(from, to).await.map(|_| ())
}

/// Checks that `user_id` may read the source message and may post this content in the target channel (`target_permissions`),
/// then builds the snapshot, copying the attachment files. Nothing is copied when a check fails, and a failure while copying
/// removes what was copied so far.
pub async fn prepare(
    state: &AppState,
    user_id: i64,
    source_channel: i64,
    source_message: i64,
    target: &ChannelRow,
    target_permissions: u64,
) -> ApiResult<ForwardDraft> {
    let access = channel_access(state, user_id, source_channel).await.map_err(|_| unreadable())?;
    if access.permissions & READ_MESSAGE_HISTORY == 0 {
        return Err(unreadable());
    }
    let row: MessageRow = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = $1 AND m.channel_id = $2"))
        .bind(source_message)
        .bind(source_channel)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(unreadable)?;
    if !matches!(MessageType::from_u8(row.kind as u8), Some(MessageType::Default | MessageType::Reply)) {
        return Err(ApiErr::invalid("message_reference", "Only regular messages can be forwarded."));
    }
    let view = store::message_view(state, source_message, None).await?.ok_or_else(unreadable)?;
    let message = view.message;
    // Forwarding a forward copies what it showed.
    let mut content = match message.message_snapshots.into_iter().next() {
        Some(snapshot) => snapshot.message,
        None => MessageSnapshotContent {
            kind: MessageType::Default,
            content: message.content,
            timestamp: message.timestamp,
            edited_timestamp: message.edited_timestamp,
            mentions: message.mentions,
            attachments: message.attachments,
            embeds: message.embeds,
            sticker_items: message.sticker_items,
        },
    };
    // The source's sticker rows are exactly the stickers its snapshot (or own list) shows.
    let sticker_rows: Vec<(i64, String, i16, i64, String)> =
        sqlx::query_as("SELECT sticker_id, name, format, attachment_id, asset_path FROM message_stickers WHERE message_id = $1 ORDER BY position")
            .bind(source_message)
            .fetch_all(&state.db)
            .await?;
    let stickers: Vec<StickerRef> = sticker_rows
        .into_iter()
        .map(|(sticker_id, name, format, attachment_id, asset_path)| StickerRef {
            sticker_id,
            name,
            format: StickerFormat::from_u8(format as u8).unwrap_or(StickerFormat::Png),
            attachment_id,
            asset_path,
        })
        .collect();

    // A forward posts the same content a normal message would, so the target channel's rules apply (Discord answers 403 too).
    if !content.attachments.is_empty() && target_permissions & ATTACH_FILES == 0 {
        return Err(ApiErr::missing_permissions());
    }
    if !stickers.is_empty() && !target.is_dm() && target_permissions & USE_EXTERNAL_STICKERS == 0 {
        let ids: Vec<i64> = stickers.iter().map(|sticker| sticker.sticker_id).collect();
        let own: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM stickers WHERE id = ANY($1) AND guild_id = $2").bind(&ids).bind(target.guild_id).fetch_all(&state.db).await?;
        // A sticker of the target's own guild is fine; one from elsewhere (or one that no longer exists) counts as external.
        if own.len() != ids.len() {
            return Err(ApiErr::missing_permissions());
        }
    }

    let originals = std::mem::take(&mut content.attachments);
    let mut copies: Vec<AttachmentCopy> = Vec::new();
    let mut attachments: Vec<Attachment> = Vec::new();
    let copied = async {
        tokio::fs::create_dir_all(state.attachments_dir()).await?;
        for original in originals {
            let new_id = state.ids.next();
            if link_or_copy(&media::file_path(state, original.id.db()), &media::file_path(state, new_id)).await.is_err() {
                continue; // the file is gone: drop it from the copy rather than point at a dead link
            }
            let key = media::new_key();
            let mut copy = store::attachment_api(
                state,
                new_id,
                &key,
                original.filename.clone(),
                original.content_type.clone(),
                original.size as i64,
                original.width.map(|value| value as i32),
                original.height.map(|value| value as i32),
            );
            copy.description = original.description.clone();
            attachments.push(copy);
            copies.push(AttachmentCopy {
                id: new_id,
                key,
                filename: original.filename,
                content_type: original.content_type,
                size: original.size,
                width: original.width,
                height: original.height,
                description: original.description,
            });
        }
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(error) = copied {
        media::remove_files(state, &copies.iter().map(|copy| copy.id).collect::<Vec<_>>()).await;
        return Err(error.into());
    }
    let snapshot = MessageSnapshot { message: MessageSnapshotContent { attachments, ..content } };
    Ok(ForwardDraft { source_channel, source_guild: access.channel.guild_id, source_message, snapshot, copies, stickers })
}
