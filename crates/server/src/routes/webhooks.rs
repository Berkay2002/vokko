//! Incoming webhooks: management (user auth + MANAGE_WEBHOOKS) and the token URLs, which also serve interaction followups
//! (`/webhooks/{application_id}/{interaction token}`, Discord's convention).
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use vokko_protocol::api::permissions::MANAGE_WEBHOOKS;
use vokko_protocol::api::{ChannelType, CreateWebhookRequest, EditWebhookRequest, Message, MessageType, Webhook, WebhookMessageRequest};

use crate::access::{self, channel_access};
use crate::apps::{
    self, MessageIdentity, WEBHOOK_COLS, WebhookRow, announce_webhooks, resolve_app_mentions, tokens_match, validate_body, webhook_api, webhook_name,
    webhook_row,
};
use crate::auth::{AuthUser, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::interactions::{self, InteractionRow};
use crate::routes::messages::{Draft, Extras, insert_message_with};
use crate::routes::users::{ImageKind, owned_image_path};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

/// Webhooks per channel (Discord's limit).
const MAX_WEBHOOKS_PER_CHANNEL: i64 = 15;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/webhooks", get(list_channel).post(create))
        .route("/guilds/{id}/webhooks", get(list_guild))
        .route("/webhooks/{id}", get(get_one).patch(edit).delete(remove))
        .route("/webhooks/{id}/{token}", get(token_get).patch(token_edit).delete(token_delete).post(execute))
        .route("/webhooks/{id}/{token}/messages/{mid}", get(message_get).patch(message_edit).delete(message_delete))
}

fn webhook_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_webhook)
}

fn accepts_webhooks(channel: &ChannelRow) -> ApiResult<()> {
    match channel.channel_type() {
        ChannelType::GuildText | ChannelType::GuildAnnouncement => Ok(()),
        _ => Err(ApiErr::wrong_channel_type()),
    }
}

async fn api_list(state: &AppState, rows: Vec<WebhookRow>) -> ApiResult<Vec<Webhook>> {
    let creators: Vec<i64> = rows.iter().filter_map(|row| row.creator_id).collect();
    let users = store::users(state, &creators).await?;
    Ok(rows.iter().map(|row| webhook_api(state, row, row.creator_id.and_then(|id| users.get(&id).cloned()), true)).collect())
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateWebhookRequest>,
) -> ApiResult<Json<Webhook>> {
    let channel = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, channel).await?;
    access.require(MANAGE_WEBHOOKS)?;
    accepts_webhooks(&access.channel)?;
    let name = webhook_name(&body.name, "name")?;
    let avatar = match body.avatar_attachment_id {
        Some(attachment) => Some(owned_image_path(&state, attachment.db(), user_id, ImageKind::Avatar, "avatar_attachment_id").await?),
        None => None,
    };
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM webhooks WHERE channel_id = $1").bind(channel).fetch_one(&state.db).await?;
    if count >= MAX_WEBHOOKS_PER_CHANNEL {
        return Err(ApiErr::conflict(30007, "Maximum number of webhooks reached (15)"));
    }
    let id = state.ids.next();
    let mut tx = state.db.begin().await?;
    // The hidden author of the webhook's messages: no password, a username registration can never produce.
    sqlx::query("INSERT INTO users (id, username, email, bot, password_hash) VALUES ($1, $2, $3, TRUE, NULL)")
        .bind(id)
        .bind(format!("webhook-{id}"))
        .bind(format!("{id}@webhooks.invalid"))
        .execute(&mut *tx)
        .await?;
    let row: WebhookRow = sqlx::query_as(&format!(
        "INSERT INTO webhooks (id, kind, guild_id, channel_id, name, avatar_path, token, creator_id) VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING {WEBHOOK_COLS}"
    ))
    .bind(id)
    .bind(access.channel.guild_id)
    .bind(channel)
    .bind(&name)
    .bind(&avatar)
    .bind(random_hex(34))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    announce_webhooks(&state, &access.channel).await?;
    Ok(Json(webhook_api(&state, &row, store::user(&state, user_id).await?, true)))
}

async fn list_channel(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Webhook>>> {
    let channel = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    channel_access(&state, user_id, channel).await?.require(MANAGE_WEBHOOKS)?;
    let rows: Vec<WebhookRow> =
        sqlx::query_as(&format!("SELECT {WEBHOOK_COLS} FROM webhooks WHERE channel_id = $1 ORDER BY id")).bind(channel).fetch_all(&state.db).await?;
    Ok(Json(api_list(&state, rows).await?))
}

/// Every webhook of the guild in channels where the caller has MANAGE_WEBHOOKS.
async fn list_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Webhook>>> {
    let guild = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    let channels = access::guild_channels_with_permissions(&state, user_id, guild).await?;
    let managed: Vec<i64> = channels.iter().filter(|(_, permissions)| permissions & MANAGE_WEBHOOKS != 0).map(|(row, _)| row.id).collect();
    if managed.is_empty() {
        return Err(ApiErr::missing_permissions());
    }
    let rows: Vec<WebhookRow> = sqlx::query_as(&format!("SELECT {WEBHOOK_COLS} FROM webhooks WHERE guild_id = $1 AND channel_id = ANY($2) ORDER BY id"))
        .bind(guild)
        .bind(&managed)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(api_list(&state, rows).await?))
}

/// The webhook, when the caller manages webhooks in its channel.
async fn managed(state: &AppState, user_id: i64, raw: &str) -> ApiResult<(WebhookRow, ChannelRow)> {
    let row = webhook_row(state, webhook_id(raw)?).await?.ok_or_else(ApiErr::unknown_webhook)?;
    let access = channel_access(state, user_id, row.channel_id).await.map_err(|_| ApiErr::unknown_webhook())?;
    access.require(MANAGE_WEBHOOKS)?;
    Ok((row, access.channel))
}

async fn get_one(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Webhook>> {
    let (row, _) = managed(&state, user_id, &id).await?;
    Ok(Json(api_list(&state, vec![row]).await?.remove(0)))
}

async fn apply_edit(state: &AppState, row: &WebhookRow, uploader: Option<i64>, body: &EditWebhookRequest, channel: Option<i64>) -> ApiResult<WebhookRow> {
    let name = body.name.as_deref().map(|name| webhook_name(name, "name")).transpose()?;
    let avatar = match (body.avatar_attachment_id, uploader) {
        (None, _) => None,
        (Some(None), _) => Some(None),
        (Some(Some(attachment)), Some(uploader)) => {
            Some(Some(owned_image_path(state, attachment.db(), uploader, ImageKind::Avatar, "avatar_attachment_id").await?))
        }
        // A token can only clear the avatar: uploads belong to users.
        (Some(Some(_)), None) => return Err(ApiErr::invalid("avatar_attachment_id", "Needs user authorization.")),
    };
    let updated: WebhookRow = sqlx::query_as(&format!(
        "UPDATE webhooks SET name = COALESCE($2, name), avatar_path = CASE WHEN $3 THEN $4 ELSE avatar_path END, channel_id = COALESCE($5, channel_id) \
         WHERE id = $1 RETURNING {WEBHOOK_COLS}"
    ))
    .bind(row.id)
    .bind(&name)
    .bind(avatar.is_some())
    .bind(avatar.flatten())
    .bind(channel)
    .fetch_one(&state.db)
    .await?;
    Ok(updated)
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditWebhookRequest>,
) -> ApiResult<Json<Webhook>> {
    let (row, channel) = managed(&state, user_id, &id).await?;
    let target = match body.channel_id {
        Some(target) if target.db() != row.channel_id => {
            let access = channel_access(&state, user_id, target.db()).await?;
            access.require(MANAGE_WEBHOOKS)?;
            accepts_webhooks(&access.channel)?;
            if access.channel.guild_id != row.guild_id {
                return Err(ApiErr::invalid("channel_id", "Must be a channel of the same server."));
            }
            let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM webhooks WHERE channel_id = $1").bind(access.channel.id).fetch_one(&state.db).await?;
            if count >= MAX_WEBHOOKS_PER_CHANNEL {
                return Err(ApiErr::conflict(30007, "Maximum number of webhooks reached (15)"));
            }
            Some(access.channel)
        }
        _ => None,
    };
    let updated = apply_edit(&state, &row, Some(user_id), &body, target.as_ref().map(|channel| channel.id)).await?;
    announce_webhooks(&state, &channel).await?;
    if let Some(target) = &target {
        announce_webhooks(&state, target).await?;
    }
    Ok(Json(api_list(&state, vec![updated]).await?.remove(0)))
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (row, channel) = managed(&state, user_id, &id).await?;
    sqlx::query("DELETE FROM webhooks WHERE id = $1").bind(row.id).execute(&state.db).await?;
    announce_webhooks(&state, &channel).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- token URLs ----

/// What a `/webhooks/{id}/{token}` URL names.
enum Target {
    Webhook(WebhookRow),
    Interaction(Box<InteractionRow>),
}

async fn target(state: &AppState, id: &str, token: &str) -> ApiResult<Target> {
    let id = webhook_id(id)?;
    if let Some(row) = webhook_row(state, id).await? {
        return if tokens_match(&row.token, token) { Ok(Target::Webhook(row)) } else { Err(ApiErr::invalid_webhook_token()) };
    }
    match interactions::interaction_for_app_token(state, id, token).await? {
        Some(row) => Ok(Target::Interaction(Box::new(row))),
        None => Err(ApiErr::unknown_webhook()),
    }
}

async fn webhook_target(state: &AppState, id: &str, token: &str) -> ApiResult<WebhookRow> {
    match target(state, id, token).await? {
        Target::Webhook(row) => Ok(row),
        Target::Interaction(_) => Err(ApiErr::unknown_webhook()),
    }
}

async fn token_get(State(state): State<AppState>, Path((id, token)): Path<(String, String)>) -> ApiResult<Json<Webhook>> {
    let row = webhook_target(&state, &id, &token).await?;
    Ok(Json(webhook_api(&state, &row, None, false)))
}

async fn token_edit(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditWebhookRequest>,
) -> ApiResult<Json<Webhook>> {
    let row = webhook_target(&state, &id, &token).await?;
    if body.channel_id.is_some() {
        return Err(ApiErr::invalid("channel_id", "Needs user authorization."));
    }
    let updated = apply_edit(&state, &row, None, &body, None).await?;
    if let Some(channel) = store::channel_row(&state, row.channel_id).await? {
        announce_webhooks(&state, &channel).await?;
    }
    Ok(Json(webhook_api(&state, &updated, None, false)))
}

async fn token_delete(State(state): State<AppState>, Path((id, token)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let row = webhook_target(&state, &id, &token).await?;
    sqlx::query("DELETE FROM webhooks WHERE id = $1").bind(row.id).execute(&state.db).await?;
    if let Some(channel) = store::channel_row(&state, row.channel_id).await? {
        announce_webhooks(&state, &channel).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ExecuteQuery {
    wait: Option<bool>,
}

/// Execute (webhook) or followup (interaction).
async fn execute(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
    ApiQuery(query): ApiQuery<ExecuteQuery>,
    ApiJson(body): ApiJson<WebhookMessageRequest>,
) -> ApiResult<Response> {
    let row = match target(&state, &id, &token).await? {
        Target::Interaction(interaction) => {
            if let Err(retry_after) = state.limiter.check_key("followup", interaction.id, 5.0, 1.0) {
                return Err(ApiErr::rate_limited(retry_after));
            }
            return Ok(Json(interactions::followup(&state, &interaction, &body).await?).into_response());
        }
        Target::Webhook(row) => row,
    };
    if let Err(retry_after) = state.limiter.check_key("webhook", row.id, 5.0, 2.5) {
        return Err(ApiErr::rate_limited(retry_after));
    }
    if let Err(retry_after) = state.limiter.check_key("webhook-channel", row.channel_id, 30.0, 0.5) {
        return Err(ApiErr::rate_limited(retry_after));
    }
    let channel = store::channel_row(&state, row.channel_id).await?.ok_or_else(ApiErr::unknown_webhook)?;
    let (content, embeds) = validate_body(body.content.as_deref(), body.embeds.as_ref(), false)?;
    let name = match body.username.as_deref() {
        Some(username) => webhook_name(username, "username")?,
        None => row.name.clone(),
    };
    let avatar = match body.avatar_url.as_deref() {
        Some(url) => Some(apps::avatar_url(url)?),
        None => row.avatar_path.as_ref().map(|path| state.asset_url(path)),
    };
    let mentions = resolve_app_mentions(&state, &channel, &content, body.allowed_mentions.as_ref(), None).await?;
    let identity = MessageIdentity { webhook_id: Some(row.id), application_id: row.application_id, name: Some(name), avatar, interaction_metadata: None };
    let extras = Extras {
        embeds: (!embeds.is_empty()).then(|| serde_json::to_string(&embeds)).transpose().map_err(|_| ApiErr::internal())?,
        identity: Some(identity),
        ..Extras::default()
    };
    let draft = Draft {
        content,
        kind: MessageType::Default,
        reference: None,
        attachments: Vec::new(),
        nonce: None,
        mentions,
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    let view = insert_message_with(&state, &channel, row.id, draft, extras).await?;
    if query.wait == Some(true) { Ok(Json(view.message).into_response()) } else { Ok(StatusCode::NO_CONTENT.into_response()) }
}

/// A message posted by this webhook (its token reaches nothing else).
async fn own_message(state: &AppState, row: &WebhookRow, mid: &str) -> ApiResult<(i64, ChannelRow)> {
    let mid = parse_id(mid).ok_or_else(ApiErr::unknown_message)?;
    let found: Option<(i64,)> = sqlx::query_as("SELECT channel_id FROM messages WHERE id = $1 AND webhook_id = $2 AND author_id = $2")
        .bind(mid)
        .bind(row.id)
        .fetch_optional(&state.db)
        .await?;
    let (channel,) = found.ok_or_else(ApiErr::unknown_message)?;
    Ok((mid, store::channel_row(state, channel).await?.ok_or_else(ApiErr::unknown_message)?))
}

async fn message_get(State(state): State<AppState>, Path((id, token, mid)): Path<(String, String, String)>) -> ApiResult<Json<Message>> {
    match target(&state, &id, &token).await? {
        Target::Interaction(interaction) => Ok(Json(interactions::get_message(&state, &interaction, &mid).await?)),
        Target::Webhook(row) => {
            let (mid, _) = own_message(&state, &row, &mid).await?;
            store::message_view(&state, mid, None).await?.map(|view| Json(view.message)).ok_or_else(ApiErr::unknown_message)
        }
    }
}

async fn message_edit(
    State(state): State<AppState>,
    Path((id, token, mid)): Path<(String, String, String)>,
    ApiJson(body): ApiJson<WebhookMessageRequest>,
) -> ApiResult<Json<Message>> {
    match target(&state, &id, &token).await? {
        Target::Interaction(interaction) => Ok(Json(interactions::edit_message(&state, &interaction, &mid, &body).await?)),
        Target::Webhook(row) => {
            let (mid, channel) = own_message(&state, &row, &mid).await?;
            Ok(Json(interactions::edit_stored(&state, &channel, mid, &body, None).await?))
        }
    }
}

async fn message_delete(State(state): State<AppState>, Path((id, token, mid)): Path<(String, String, String)>) -> ApiResult<StatusCode> {
    match target(&state, &id, &token).await? {
        Target::Interaction(interaction) => interactions::delete_message(&state, &interaction, &mid).await?,
        Target::Webhook(row) => {
            let (mid, channel) = own_message(&state, &row, &mid).await?;
            interactions::delete_channel_message(&state, &channel, mid).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
