//! Applications (bots), application commands, interactions, webhooks and ephemeral messages: what the routes in
//! `routes/applications.rs`, `routes/interactions.rs` and `routes/webhooks.rs` share. See docs/api.md "Apps".
use std::collections::HashSet;
use std::time::Duration;

use serde_json::Value;
use sqlx::{FromRow, Postgres, Transaction};
use vokko_protocol::api::permissions::{ALL, USE_APPLICATION_COMMANDS};
use vokko_protocol::api::{
    AllowedMentions, Application, ApplicationCommand, ApplicationCommandOption, ApplicationCommandOptionType, ApplicationCommandRequest,
    ApplicationCommandType, ChannelType, CommandIndexApplication, Component, ComponentType, Embed, GatewayEvent, InstallParams, Message, MessageDelete,
    Snowflake, User,
};

use crate::access::{ChannelAccess, DM_PERMISSIONS};
use crate::auth::{hash_token, new_token};
use crate::error::{ApiErr, ApiResult};
use crate::routes::messages::{MAX_CONTENT_CHARS, Resolved};
use crate::routes::moderation::{Removed, announce_removal, delete_member};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

/// The bot must answer an interaction this fast; afterwards the user is told it did not respond.
pub const CALLBACK_WINDOW: Duration = Duration::from_secs(3);
/// Followups and edits of the response work this long after the interaction.
pub const TOKEN_LIFETIME_SECS: i64 = 15 * 60;
/// Ephemeral messages are dropped after this long.
const EPHEMERAL_LIFETIME_SECS: i64 = 24 * 60 * 60;
pub const MAX_APPLICATIONS_PER_USER: i64 = 25;
pub const MAX_EMBEDS: usize = 10;

fn flake(id: i64) -> Snowflake {
    Snowflake::from(id)
}

// ---- message identity (webhooks, interaction responses) ----

/// Stored with a webhook or interaction message: who it is shown as and which command produced it.
#[derive(Clone, Debug, Default)]
pub struct MessageIdentity {
    pub webhook_id: Option<i64>,
    pub application_id: Option<i64>,
    /// Shown instead of the author's username (webhooks); `None` keeps the author's profile (bots).
    pub name: Option<String>,
    pub avatar: Option<String>,
    /// JSON `MessageInteractionMetadata`.
    pub interaction_metadata: Option<String>,
}

/// Mentions in webhook and interaction content: like a user message in that channel, except that `@everyone` only pings when
/// `allowed_mentions.parse` lists it explicitly, and for an interaction message (`bot` = its application) only when the bot
/// itself has MENTION_EVERYONE there.
pub async fn resolve_app_mentions(
    state: &AppState,
    channel: &ChannelRow,
    content: &str,
    allowed: Option<&AllowedMentions>,
    bot: Option<i64>,
) -> ApiResult<Resolved> {
    use crate::routes::messages::{apply_allowed, parse_mentions, resolve_mentions};
    use vokko_protocol::api::permissions::MENTION_EVERYONE;
    let mut everyone_allowed = allowed.and_then(|allowed| allowed.parse.as_ref()).is_some_and(|parse| parse.iter().any(|kind| kind == "everyone"));
    if everyone_allowed && let Some(bot) = bot {
        let permissions = crate::access::channel_access(state, bot, channel.id).await.map(|access| access.permissions).unwrap_or(0);
        everyone_allowed = permissions & MENTION_EVERYONE != 0;
    }
    let access = ChannelAccess { channel: channel.clone(), permissions: if everyone_allowed { MENTION_EVERYONE } else { 0 }, parent: None };
    Ok(apply_allowed(resolve_mentions(state, &access, parse_mentions(content)).await?, allowed))
}

/// Content and embeds of a webhook/interaction message: content up to 2000 characters (trimmed), at most 10 embeds,
/// at least one of them unless `allow_empty`.
pub fn validate_body(content: Option<&str>, embeds: Option<&Vec<Embed>>, allow_empty: bool) -> ApiResult<(String, Vec<Embed>)> {
    let content = content.unwrap_or("").trim().to_owned();
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(ApiErr::invalid("content", "Must be 2000 or fewer in length."));
    }
    let mut embeds = embeds.cloned().unwrap_or_default();
    if embeds.len() > MAX_EMBEDS {
        return Err(ApiErr::invalid("embeds", "Must be 10 or fewer in length."));
    }
    let mut total = 0;
    for (index, embed) in embeds.iter_mut().enumerate() {
        total += clean_embed(embed, index)?;
    }
    if total > MAX_EMBED_TOTAL {
        return Err(ApiErr::invalid("embeds", "Embeds must be 6000 or fewer characters in total."));
    }
    if content.is_empty() && embeds.is_empty() && !allow_empty {
        return Err(ApiErr::empty_message());
    }
    Ok((content, embeds))
}

const MAX_ROWS: usize = 5;
const MAX_BUTTONS_PER_ROW: usize = 5;
const MAX_SELECT_OPTIONS: usize = 25;
const MAX_CUSTOM_ID: usize = 100;
const MAX_BUTTON_LABEL: usize = 80;
const MAX_OPTION_TEXT: usize = 100;
const MAX_PLACEHOLDER: usize = 150;

/// Buttons and selects of a bot message in Discord's limits: up to 5 action rows of up to 5 buttons, or one string select alone in
/// its row; `custom_id` 1-100 characters and unique in the message; style 5 (link) needs an https `url` and no `custom_id`, the
/// others a `custom_id` and no `url`; a select picks exactly one option (min and max are 1).
pub fn validate_components(components: &[Component]) -> ApiResult<Vec<Component>> {
    let bad = |path: &str, message: &str| ApiErr::invalid(&format!("components.{path}"), message);
    let length = |path: &str, text: &str, min: usize, max: usize| {
        let count = text.chars().count();
        if count < min || count > max { Err(bad(path, &format!("Must be between {min} and {max} in length."))) } else { Ok(()) }
    };
    if components.len() > MAX_ROWS {
        return Err(bad("", "Must be 5 or fewer in length."));
    }
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for (row_index, row) in components.iter().enumerate() {
        let row_path = row_index.to_string();
        let Some(children) = row.components.as_ref().filter(|_| row.kind == ComponentType::ActionRow) else {
            return Err(bad(&row_path, "Top-level components must be action rows."));
        };
        if children.is_empty() || children.len() > MAX_BUTTONS_PER_ROW {
            return Err(bad(&row_path, "An action row holds 1 to 5 components."));
        }
        let mut cleaned_children = Vec::new();
        for (index, child) in children.iter().enumerate() {
            let path = format!("{row_index}.components.{index}");
            let mut child = child.clone();
            child.components = None;
            let id = child.custom_id.clone();
            match child.kind {
                ComponentType::ActionRow => return Err(bad(&path, "Action rows cannot be nested.")),
                ComponentType::Button => {
                    let style = child.style.filter(|style| (1..=5).contains(style)).ok_or_else(|| bad(&path, "style must be 1 to 5."))?;
                    if child.label.as_deref().is_none_or(|label| label.trim().is_empty()) && child.emoji.is_none() {
                        return Err(bad(&path, "A button needs a label or an emoji."));
                    }
                    length(&path, child.label.as_deref().unwrap_or(""), 0, MAX_BUTTON_LABEL)?;
                    if style == 5 {
                        let https = child.url.as_deref().is_some_and(|url| url.len() <= 2048 && url.trim().to_ascii_lowercase().starts_with("https://"));
                        if !https || id.is_some() {
                            return Err(bad(&path, "A link button needs an https url and no custom_id."));
                        }
                    } else if child.url.is_some() || id.is_none() {
                        return Err(bad(&path, "A button needs a custom_id and no url."));
                    }
                    child.options = None;
                    child.placeholder = None;
                    child.min_values = None;
                    child.max_values = None;
                }
                ComponentType::StringSelect => {
                    if children.len() != 1 {
                        return Err(bad(&path, "A select menu fills its row alone."));
                    }
                    let Some(options) = child.options.as_ref().filter(|options| (1..=MAX_SELECT_OPTIONS).contains(&options.len())) else {
                        return Err(bad(&path, "A select menu has 1 to 25 options."));
                    };
                    let mut values = HashSet::new();
                    for option in options {
                        length(&path, &option.label, 1, MAX_OPTION_TEXT)?;
                        length(&path, &option.value, 1, MAX_OPTION_TEXT)?;
                        length(&path, option.description.as_deref().unwrap_or(""), 0, MAX_OPTION_TEXT)?;
                        if !values.insert(option.value.as_str()) {
                            return Err(bad(&path, "Option values must be unique."));
                        }
                    }
                    length(&path, child.placeholder.as_deref().unwrap_or(""), 0, MAX_PLACEHOLDER)?;
                    if id.is_none() || child.url.is_some() || child.min_values.is_some_and(|min| min != 1) || child.max_values.is_some_and(|max| max != 1) {
                        return Err(bad(&path, "A select menu needs a custom_id and picks exactly one option (min_values and max_values 1)."));
                    }
                    child.style = None;
                    child.label = None;
                    child.min_values = Some(1);
                    child.max_values = Some(1);
                }
            }
            if let Some(id) = id {
                length(&path, &id, 1, MAX_CUSTOM_ID)?;
                if !seen.insert(id) {
                    return Err(bad(&path, "custom_id must be unique in the message."));
                }
            }
            cleaned_children.push(child);
        }
        cleaned.push(Component { components: Some(cleaned_children), ..row.clone() });
    }
    Ok(cleaned)
}

/// `validate_components` for a bot's own message: members cannot send components.
pub async fn bot_components(state: &AppState, user_id: i64, components: &[Component]) -> ApiResult<Vec<Component>> {
    let bot: Option<(bool,)> = sqlx::query_as("SELECT bot FROM users WHERE id = $1").bind(user_id).fetch_optional(&state.db).await?;
    if !bot.is_some_and(|(bot,)| bot) {
        return Err(ApiErr::invalid("components", "Only applications can send components."));
    }
    validate_components(components)
}

/// The button or select with this `custom_id` in a message's rows.
pub fn find_component<'a>(components: &'a [Component], custom_id: &str) -> Option<&'a Component> {
    components.iter().flat_map(|row| row.components.iter().flatten()).find(|component| component.custom_id.as_deref() == Some(custom_id))
}

const MAX_EMBED_TITLE: usize = 256;
const MAX_EMBED_DESCRIPTION: usize = 4096;
const MAX_EMBED_FIELDS: usize = 25;
const MAX_FIELD_NAME: usize = 256;
const MAX_FIELD_VALUE: usize = 1024;
const MAX_FOOTER_TEXT: usize = 2048;
const MAX_AUTHOR_NAME: usize = 256;
const MAX_EMBED_TOTAL: usize = 6000;
const MAX_EMBED_URL: usize = 2048;

/// An http(s) URL a client may link or load; anything else (javascript:, data:, relative, oversized) is dropped.
fn web_url(url: Option<String>) -> Option<String> {
    url.filter(|url| {
        let lower = url.trim().to_ascii_lowercase();
        url.len() <= MAX_EMBED_URL && (lower.starts_with("https://") || lower.starts_with("http://"))
    })
}

/// Discord's limits for an embed a bot or webhook sends: always `rich`, text within the per-part limits, only http(s) URLs.
/// Returns the characters it counts toward the 6000 total.
fn clean_embed(embed: &mut Embed, index: usize) -> ApiResult<usize> {
    let field = |name: &str| format!("embeds.{index}.{name}");
    let check = |text: &str, max: usize, name: &str| -> ApiResult<usize> {
        let count = text.chars().count();
        if count > max { Err(ApiErr::invalid(&field(name), &format!("Must be {max} or fewer in length."))) } else { Ok(count) }
    };
    let mut total = 0;
    embed.kind = vokko_protocol::api::EmbedType::Rich;
    total += check(embed.title.as_deref().unwrap_or(""), MAX_EMBED_TITLE, "title")?;
    total += check(embed.description.as_deref().unwrap_or(""), MAX_EMBED_DESCRIPTION, "description")?;
    if let Some(footer) = &mut embed.footer {
        total += check(&footer.text, MAX_FOOTER_TEXT, "footer.text")?;
        footer.icon_url = web_url(footer.icon_url.take());
    }
    if let Some(author) = &mut embed.author {
        total += check(&author.name, MAX_AUTHOR_NAME, "author.name")?;
        author.url = web_url(author.url.take());
        author.icon_url = web_url(author.icon_url.take());
    }
    if let Some(fields) = &embed.fields {
        if fields.len() > MAX_EMBED_FIELDS {
            return Err(ApiErr::invalid(&field("fields"), "Must be 25 or fewer in length."));
        }
        for (n, item) in fields.iter().enumerate() {
            total += check(&item.name, MAX_FIELD_NAME, &format!("fields.{n}.name"))?;
            total += check(&item.value, MAX_FIELD_VALUE, &format!("fields.{n}.value"))?;
        }
    }
    if let Some(provider) = &mut embed.provider {
        provider.url = web_url(provider.url.take());
    }
    embed.url = web_url(embed.url.take());
    for media in [&mut embed.image, &mut embed.thumbnail, &mut embed.video] {
        if media.as_ref().is_some_and(|item| web_url(Some(item.url.clone())).is_none()) {
            *media = None;
        }
        if let Some(item) = media {
            item.proxy_url = None;
        }
    }
    Ok(total)
}

// ---- ephemeral messages ----

/// The cursor of a `GET /channels/{id}/messages` page.
pub struct PageBounds {
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub around: Option<i64>,
}

/// Adds the caller's ephemeral messages that belong in this page, keeping it newest first and at most `limit` long.
pub async fn merge_ephemerals(state: &AppState, channel_id: i64, user_id: i64, page: PageBounds, limit: i64, messages: &mut Vec<Message>) -> ApiResult<()> {
    // A page that came back short reaches the end of the history in that direction, so its range is open there.
    let full = messages.len() as i64 >= limit;
    let oldest = messages.last().map(|message| message.id.db());
    let newest = messages.first().map(|message| message.id.db());
    let (low, high) = if page.around.is_some() {
        (if full { oldest } else { None }, if full { newest } else { None })
    } else if let Some(after) = page.after {
        (Some(after + 1), if full { newest } else { None })
    } else {
        (if full { oldest } else { None }, page.before.map(|before| before - 1))
    };
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT payload::text FROM ephemeral_messages WHERE channel_id = $1 AND recipient_id = $2 AND id >= $3 AND id <= $4 ORDER BY id DESC LIMIT $5",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(low.unwrap_or(0))
    .bind(high.unwrap_or(i64::MAX))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    messages.extend(rows.into_iter().filter_map(|(raw,)| serde_json::from_str::<Message>(&raw).ok()));
    messages.sort_by_key(|message| std::cmp::Reverse(message.id));
    if page.after.is_some() {
        // the page is the oldest `limit` messages after the cursor
        let skip = messages.len().saturating_sub(limit as usize);
        messages.drain(..skip);
    } else {
        messages.truncate(limit as usize);
    }
    Ok(())
}

/// Stores an ephemeral message for `recipient` and sends MESSAGE_CREATE to their sessions only.
pub async fn insert_ephemeral(state: &AppState, message: &Message, recipient: i64, interaction_id: Option<i64>) -> ApiResult<()> {
    let payload = serde_json::to_string(message).map_err(|_| ApiErr::internal())?;
    sqlx::query(
        "INSERT INTO ephemeral_messages (id, channel_id, recipient_id, interaction_id, application_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    )
    .bind(message.id.db())
    .bind(message.channel_id.db())
    .bind(recipient)
    .bind(interaction_id)
    .bind(message.application_id.map(Snowflake::db))
    .bind(payload)
    .execute(&state.db)
    .await?;
    state.hub.send(&[recipient], &GatewayEvent::MessageCreate(Box::new(message.clone())));
    Ok(())
}

/// The ephemeral message `id` and its recipient.
pub async fn ephemeral(state: &AppState, id: i64) -> ApiResult<Option<(Message, i64)>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT payload::text, recipient_id FROM ephemeral_messages WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    Ok(row.and_then(|(raw, recipient)| serde_json::from_str::<Message>(&raw).ok().map(|message| (message, recipient))))
}

pub async fn update_ephemeral(state: &AppState, message: &Message, recipient: i64) -> ApiResult<()> {
    let payload = serde_json::to_string(message).map_err(|_| ApiErr::internal())?;
    sqlx::query("UPDATE ephemeral_messages SET payload = $2::jsonb WHERE id = $1").bind(message.id.db()).bind(payload).execute(&state.db).await?;
    state.hub.send(&[recipient], &GatewayEvent::MessageUpdate(Box::new(message.clone())));
    Ok(())
}

/// Removes an ephemeral message (dismissed, or deleted by its bot) and tells its recipient.
pub async fn delete_ephemeral(state: &AppState, id: i64) -> ApiResult<bool> {
    let row: Option<(i64, i64, Option<String>)> =
        sqlx::query_as("DELETE FROM ephemeral_messages WHERE id = $1 RETURNING channel_id, recipient_id, payload->>'guild_id'")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((channel_id, recipient, guild_id)) =
        row.map(|(channel, recipient, guild)| (channel, recipient, guild.and_then(|guild| guild.parse::<i64>().ok())))
    else {
        return Ok(false);
    };
    let event = GatewayEvent::MessageDelete(MessageDelete { id: flake(id), channel_id: flake(channel_id), guild_id: guild_id.map(flake) });
    state.hub.send(&[recipient], &event);
    Ok(true)
}

/// `DELETE /channels/{id}/messages/{mid}` on an ephemeral message: only its recipient sees it, so only they can dismiss it. False
/// when `mid` is not an ephemeral message of `user_id` in that channel (the regular delete then answers).
pub async fn dismiss_ephemeral(state: &AppState, channel_id: i64, id: i64, user_id: i64) -> ApiResult<bool> {
    let mine: Option<(i64,)> = sqlx::query_as("SELECT id FROM ephemeral_messages WHERE id = $1 AND channel_id = $2 AND recipient_id = $3")
        .bind(id)
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    if mine.is_none() {
        return Ok(false);
    }
    delete_ephemeral(state, id).await
}

// ---- applications ----

#[derive(FromRow, Clone)]
pub struct AppRow {
    pub id: i64,
    pub owner_id: i64,
    pub name: String,
    pub description: String,
    pub icon_path: Option<String>,
    pub bot_public: bool,
    pub install_permissions: i64,
}

pub const APP_COLS: &str = "id, owner_id, name, description, icon_path, bot_public, install_permissions";

pub async fn app_row(state: &AppState, id: i64) -> ApiResult<Option<AppRow>> {
    Ok(sqlx::query_as(&format!("SELECT {APP_COLS} FROM applications WHERE id = $1")).bind(id).fetch_optional(&state.db).await?)
}

pub async fn app_api(state: &AppState, row: &AppRow) -> ApiResult<Application> {
    let bot = store::user(state, row.id).await?.ok_or_else(ApiErr::unknown_application)?;
    Ok(Application {
        id: flake(row.id),
        name: row.name.clone(),
        description: row.description.clone(),
        icon: row.icon_path.as_ref().map(|path| state.asset_url(path)),
        owner_id: flake(row.owner_id),
        bot,
        bot_public: row.bot_public,
        install_params: InstallParams { permissions: (row.install_permissions as u64).to_string() },
    })
}

/// A bot username derived from the application name: lowercase `[a-z0-9_.]`, 2-32 characters, made unique with a suffix.
pub async fn bot_username(state: &AppState, name: &str) -> ApiResult<String> {
    let mut base: String = name.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' { c } else { '_' }).collect();
    base = base.trim_matches('_').chars().take(26).collect();
    if base.chars().count() < 2 {
        base = format!("bot{base}");
    }
    for attempt in 0..8 {
        let candidate = if attempt == 0 { base.clone() } else { format!("{base}_{}", crate::auth::random_hex(2)) };
        let taken: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = $1").bind(&candidate).fetch_optional(&state.db).await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    Ok(format!("bot_{}", crate::auth::random_hex(6)))
}

/// Issues a fresh bot token for `bot_id`, revoking any previous one and closing its gateway sessions.
pub async fn issue_bot_token(state: &AppState, bot_id: i64) -> ApiResult<String> {
    let token = new_token();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(bot_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)").bind(hash_token(&token)).bind(bot_id).execute(&mut *tx).await?;
    tx.commit().await?;
    state.hub.close_user_sessions(bot_id, crate::gateway::CLOSE_AUTH_FAILED);
    Ok(token)
}

/// The guilds a deleted application's bot left, for [`announce_deleted_app`] once the transaction commits.
pub struct DeletedApp {
    pub id: i64,
    left: Vec<(i64, Removed)>,
}

/// Deletes an application inside `tx`: its bot leaves every guild (with its role and guild commands), its token is revoked,
/// its webhooks and the application row go. The bot's user row stays so its messages keep their author.
pub async fn delete_app(tx: &mut Transaction<'_, Postgres>, id: i64) -> ApiResult<DeletedApp> {
    sqlx::query("SELECT id FROM applications WHERE id = $1 FOR UPDATE").bind(id).execute(&mut **tx).await?;
    let guilds: Vec<(i64,)> = sqlx::query_as("SELECT guild_id FROM guild_members WHERE user_id = $1").bind(id).fetch_all(&mut **tx).await?;
    let mut left = Vec::with_capacity(guilds.len());
    for (guild,) in guilds {
        if let Some(removed) = delete_member(tx, guild, id, false).await? {
            left.push((guild, removed));
        }
    }
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(id).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM webhooks WHERE application_id = $1").bind(id).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM applications WHERE id = $1").bind(id).execute(&mut **tx).await?;
    Ok(DeletedApp { id, left })
}

/// After [`delete_app`] committed: GUILD_MEMBER_REMOVE / GUILD_ROLE_DELETE for every guild the bot left, and its gateway sessions closed.
pub async fn announce_deleted_app(state: &AppState, app: DeletedApp) -> ApiResult<()> {
    state.hub.close_user_sessions(app.id, crate::gateway::CLOSE_AUTH_FAILED);
    for (guild, removed) in app.left {
        announce_removal(state, guild, app.id, removed).await?;
    }
    Ok(())
}

/// Decimal permission bitfield; only known bits.
pub fn parse_permissions(raw: &str, field: &str) -> ApiResult<u64> {
    raw.trim().parse::<u64>().map(|bits| bits & ALL).map_err(|_| ApiErr::invalid(field, "Must be a decimal permission bitfield."))
}

// ---- commands ----

#[derive(FromRow, Clone)]
pub struct CommandRow {
    pub id: i64,
    pub application_id: i64,
    pub guild_id: Option<i64>,
    pub kind: i16,
    pub name: String,
    pub description: String,
    pub options: String,
    pub default_member_permissions: Option<i64>,
    pub dm_permission: bool,
    pub version: i64,
}

pub const COMMAND_COLS: &str =
    "id, application_id, guild_id, kind, name, description, options::text AS options, default_member_permissions, dm_permission, version";

impl CommandRow {
    pub fn kind(&self) -> ApplicationCommandType {
        ApplicationCommandType::from_u8(self.kind as u8).unwrap_or(ApplicationCommandType::ChatInput)
    }

    pub fn options(&self) -> Vec<ApplicationCommandOption> {
        serde_json::from_str(&self.options).unwrap_or_default()
    }

    pub fn api(&self) -> ApplicationCommand {
        let kind = self.kind();
        let options = self.options();
        ApplicationCommand {
            id: flake(self.id),
            kind,
            application_id: flake(self.application_id),
            guild_id: self.guild_id.map(flake),
            name: self.name.clone(),
            description: self.description.clone(),
            options: (kind == ApplicationCommandType::ChatInput).then_some(options),
            default_member_permissions: self.default_member_permissions.map(|bits| (bits as u64).to_string()),
            dm_permission: self.guild_id.is_none().then_some(self.dm_permission),
            version: flake(self.version),
        }
    }
}

/// A validated command body, ready to store.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandSpec {
    pub kind: ApplicationCommandType,
    pub name: String,
    pub description: String,
    pub options: Vec<ApplicationCommandOption>,
    pub default_member_permissions: Option<u64>,
    pub dm_permission: bool,
}

impl CommandSpec {
    pub fn from_row(row: &CommandRow) -> Self {
        Self {
            kind: row.kind(),
            name: row.name.clone(),
            description: row.description.clone(),
            options: row.options(),
            default_member_permissions: row.default_member_permissions.map(|bits| bits as u64),
            dm_permission: row.dm_permission,
        }
    }
}

/// CHAT_INPUT command and option names: 1-32 lowercase letters, digits, `-` and `_`.
pub fn valid_command_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=32).contains(&count) && name.chars().all(|c| c == '-' || c == '_' || c.is_numeric() || (c.is_alphabetic() && !c.is_uppercase()))
}

fn text_len(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count())
}

fn validate_option(option: &ApplicationCommandOption, index: usize) -> ApiResult<()> {
    use ApplicationCommandOptionType as Kind;
    let field = |name: &str| format!("options.{index}.{name}");
    if !valid_command_name(&option.name) {
        return Err(ApiErr::invalid(&field("name"), "Must be 1-32 lowercase letters, numbers, '-' or '_'."));
    }
    if !text_len(option.description.trim(), 1, 100) {
        return Err(ApiErr::invalid(&field("description"), "Must be between 1 and 100 in length."));
    }
    let numeric = matches!(option.kind, Kind::Integer | Kind::Number);
    if let Some(choices) = &option.choices {
        if !(numeric || option.kind == Kind::String) {
            return Err(ApiErr::invalid(&field("choices"), "Only string, integer and number options can have choices."));
        }
        if option.autocomplete == Some(true) {
            return Err(ApiErr::invalid(&field("choices"), "Choices cannot be combined with autocomplete."));
        }
        if choices.len() > 25 {
            return Err(ApiErr::invalid(&field("choices"), "Must be 25 or fewer in length."));
        }
        for choice in choices {
            if !text_len(&choice.name, 1, 100) {
                return Err(ApiErr::invalid(&field("choices"), "Choice names must be between 1 and 100 in length."));
            }
            let fits = match option.kind {
                Kind::String => choice.value.as_str().is_some_and(|value| text_len(value, 1, 100)),
                Kind::Integer => choice.value.as_i64().is_some(),
                _ => choice.value.as_f64().is_some_and(f64::is_finite),
            };
            if !fits {
                return Err(ApiErr::invalid(&field("choices"), "Choice values must match the option type."));
            }
        }
    }
    if option.autocomplete == Some(true) && !(numeric || option.kind == Kind::String) {
        return Err(ApiErr::invalid(&field("autocomplete"), "Only string, integer and number options can autocomplete."));
    }
    if (option.min_value.is_some() || option.max_value.is_some()) && !numeric {
        return Err(ApiErr::invalid(&field("min_value"), "Only integer and number options have a range."));
    }
    if let (Some(min), Some(max)) = (option.min_value, option.max_value)
        && min > max
    {
        return Err(ApiErr::invalid(&field("min_value"), "Must be at most max_value."));
    }
    if option.min_length.is_some() || option.max_length.is_some() {
        if option.kind != Kind::String {
            return Err(ApiErr::invalid(&field("min_length"), "Only string options have a length range."));
        }
        let (min, max) = (option.min_length.unwrap_or(0), option.max_length.unwrap_or(6000));
        if min > 6000 || !(1..=6000).contains(&max) || min > max {
            return Err(ApiErr::invalid(&field("min_length"), "Lengths must be within 0-6000 and min_length at most max_length."));
        }
    }
    if option.channel_types.is_some() && option.kind != Kind::Channel {
        return Err(ApiErr::invalid(&field("channel_types"), "Only channel options have channel types."));
    }
    Ok(())
}

/// Validates a POST/PUT body (`base` = None) or a PATCH on top of `base`. Global commands keep `dm_permission`.
pub fn validate_command(request: &ApplicationCommandRequest, base: Option<&CommandSpec>) -> ApiResult<CommandSpec> {
    let kind = match (request.kind, base) {
        (Some(kind), Some(base)) if kind != base.kind => return Err(ApiErr::invalid("type", "The type of a command cannot change.")),
        (Some(kind), _) => kind,
        (None, Some(base)) => base.kind,
        (None, None) => ApplicationCommandType::ChatInput,
    };
    let name = match (&request.name, base) {
        (Some(name), _) => name.trim().to_owned(),
        (None, Some(base)) => base.name.clone(),
        (None, None) => return Err(ApiErr::invalid("name", "This field is required.")),
    };
    let chat = kind == ApplicationCommandType::ChatInput;
    if chat && !valid_command_name(&name) {
        return Err(ApiErr::invalid("name", "Must be 1-32 lowercase letters, numbers, '-' or '_'."));
    }
    if !chat && !text_len(&name, 1, 32) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 32 in length."));
    }
    let description = match (&request.description, base) {
        (Some(description), _) => description.trim().to_owned(),
        (None, Some(base)) => base.description.clone(),
        (None, None) => String::new(),
    };
    if chat && !text_len(&description, 1, 100) {
        return Err(ApiErr::invalid("description", "Must be between 1 and 100 in length."));
    }
    if !chat && !description.is_empty() {
        return Err(ApiErr::invalid("description", "User and message commands have no description."));
    }
    let options = match (&request.options, base) {
        (Some(options), _) => options.clone(),
        (None, Some(base)) => base.options.clone(),
        (None, None) => Vec::new(),
    };
    if !chat && !options.is_empty() {
        return Err(ApiErr::invalid("options", "User and message commands have no options."));
    }
    if options.len() > 25 {
        return Err(ApiErr::invalid("options", "Must be 25 or fewer in length."));
    }
    let mut names = HashSet::new();
    let mut seen_optional = false;
    for (index, option) in options.iter().enumerate() {
        validate_option(option, index)?;
        if !names.insert(option.name.as_str()) {
            return Err(ApiErr::invalid(&format!("options.{index}.name"), "Option names must be unique."));
        }
        let required = option.required == Some(true);
        if required && seen_optional {
            return Err(ApiErr::invalid(&format!("options.{index}.required"), "Required options must come before optional ones."));
        }
        seen_optional |= !required;
    }
    let default_member_permissions = match (&request.default_member_permissions, base) {
        (Some(Some(raw)), _) => Some(parse_permissions(raw, "default_member_permissions")?),
        (Some(None), _) => None,
        (None, Some(base)) => base.default_member_permissions,
        (None, None) => None,
    };
    let dm_permission = request.dm_permission.or(base.map(|base| base.dm_permission)).unwrap_or(true);
    Ok(CommandSpec { kind, name, description, options, default_member_permissions, dm_permission })
}

/// Commands an application may have per scope and type (Discord's limits).
pub fn command_limit(kind: ApplicationCommandType) -> usize {
    match kind {
        ApplicationCommandType::ChatInput => 100,
        _ => 5,
    }
}

/// Whether `user_id` may use `command` in a channel where they have `permissions`.
pub fn command_allowed(command: &CommandRow, permissions: u64) -> bool {
    command.default_member_permissions.is_none_or(|bits| permissions & (bits as u64) == bits as u64)
}

/// What a user may run in a channel: the applications and their commands. Guild channels: apps whose bot is a member,
/// global + that guild's commands, filtered by USE_APPLICATION_COMMANDS and `default_member_permissions`. A 1:1 DM with a bot:
/// its global commands that allow DMs. Everything else: nothing.
pub async fn usable_commands(state: &AppState, user_id: i64, access: &ChannelAccess) -> ApiResult<(Vec<AppRow>, Vec<CommandRow>)> {
    let channel = &access.channel;
    if channel.channel_type() == ChannelType::Dm {
        let apps: Vec<AppRow> = sqlx::query_as(&format!(
            "SELECT {} FROM applications a JOIN channel_recipients r ON r.user_id = a.id WHERE r.channel_id = $1 AND r.user_id <> $2",
            prefixed("a", APP_COLS)
        ))
        .bind(channel.id)
        .bind(user_id)
        .fetch_all(&state.db)
        .await?;
        let ids: Vec<i64> = apps.iter().map(|app| app.id).collect();
        let commands: Vec<CommandRow> = sqlx::query_as(&format!(
            "SELECT {COMMAND_COLS} FROM application_commands WHERE application_id = ANY($1) AND guild_id IS NULL AND dm_permission ORDER BY name, id"
        ))
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
        let commands = commands.into_iter().filter(|command| command_allowed(command, DM_PERMISSIONS)).collect();
        return Ok((apps, commands));
    }
    let Some(guild_id) = channel.guild_id else { return Ok((Vec::new(), Vec::new())) };
    if access.permissions & USE_APPLICATION_COMMANDS == 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let apps: Vec<AppRow> = sqlx::query_as(&format!(
        "SELECT {} FROM applications a JOIN guild_members m ON m.user_id = a.id AND m.guild_id = $1 ORDER BY a.name, a.id",
        prefixed("a", APP_COLS)
    ))
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<i64> = apps.iter().map(|app| app.id).collect();
    let commands: Vec<CommandRow> = sqlx::query_as(&format!(
        "SELECT {COMMAND_COLS} FROM application_commands WHERE application_id = ANY($1) AND (guild_id IS NULL OR guild_id = $2) ORDER BY name, id"
    ))
    .bind(&ids)
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    let commands = commands.into_iter().filter(|command| command_allowed(command, access.permissions)).collect();
    Ok((apps, commands))
}

pub fn prefixed(alias: &str, cols: &str) -> String {
    cols.split(", ").map(|col| format!("{alias}.{col}")).collect::<Vec<_>>().join(", ")
}

pub fn index_application(state: &AppState, app: &AppRow) -> CommandIndexApplication {
    CommandIndexApplication { id: flake(app.id), name: app.name.clone(), icon: app.icon_path.as_ref().map(|path| state.asset_url(path)), bot_id: flake(app.id) }
}

// ---- webhooks ----

#[derive(FromRow, Clone)]
pub struct WebhookRow {
    pub id: i64,
    pub kind: i16,
    pub guild_id: Option<i64>,
    pub channel_id: i64,
    pub name: String,
    pub avatar_path: Option<String>,
    pub token: String,
    pub creator_id: Option<i64>,
    pub application_id: Option<i64>,
}

pub const WEBHOOK_COLS: &str = "id, kind, guild_id, channel_id, name, avatar_path, token, creator_id, application_id";

pub async fn webhook_row(state: &AppState, id: i64) -> ApiResult<Option<WebhookRow>> {
    Ok(sqlx::query_as(&format!("SELECT {WEBHOOK_COLS} FROM webhooks WHERE id = $1")).bind(id).fetch_optional(&state.db).await?)
}

/// Constant-time comparison of a webhook token.
pub fn tokens_match(stored: &str, given: &str) -> bool {
    stored.len() == given.len() && stored.bytes().zip(given.bytes()).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// 1-80 characters, not containing "clyde" or "discord" (Discord's rule, kept so webhook names cannot pose as the system).
pub fn webhook_name(raw: &str, field: &str) -> ApiResult<String> {
    let name = raw.trim().to_owned();
    if !text_len(&name, 1, 80) {
        return Err(ApiErr::invalid(field, "Must be between 1 and 80 in length."));
    }
    let lower = name.to_lowercase();
    if lower.contains("clyde") || lower.contains("discord") {
        return Err(ApiErr::invalid(field, "Username cannot contain \"clyde\" or \"discord\"."));
    }
    Ok(name)
}

/// The wire webhook; `with_secrets` (MANAGE_WEBHOOKS views) adds the creator, token and execute URL.
pub fn webhook_api(state: &AppState, row: &WebhookRow, creator: Option<User>, with_secrets: bool) -> vokko_protocol::api::Webhook {
    vokko_protocol::api::Webhook {
        id: flake(row.id),
        kind: vokko_protocol::api::WebhookType::from_u8(row.kind as u8).unwrap_or(vokko_protocol::api::WebhookType::Incoming),
        guild_id: row.guild_id.map(flake),
        channel_id: flake(row.channel_id),
        name: row.name.clone(),
        avatar: row.avatar_path.as_ref().map(|path| state.asset_url(path)),
        application_id: row.application_id.map(flake),
        user: if with_secrets { creator } else { None },
        token: with_secrets.then(|| row.token.clone()),
        url: with_secrets.then(|| format!("{}/api/v1/webhooks/{}/{}", state.config.public_url, row.id, row.token)),
    }
}

/// WEBHOOKS_UPDATE to the members who manage the channel's webhooks.
pub async fn announce_webhooks(state: &AppState, channel: &ChannelRow) -> ApiResult<()> {
    let Some(guild_id) = channel.guild_id else { return Ok(()) };
    let managers: Vec<i64> = crate::access::viewer_permissions(state, channel)
        .await?
        .into_iter()
        .filter(|(_, permissions)| permissions & vokko_protocol::api::permissions::MANAGE_WEBHOOKS != 0)
        .map(|(user, _)| user)
        .collect();
    let event = GatewayEvent::WebhooksUpdate(vokko_protocol::api::WebhooksUpdate { guild_id: flake(guild_id), channel_id: flake(channel.id) });
    state.hub.send(&managers, &event);
    Ok(())
}

/// `avatar_url` override on execute: an http(s) URL of at most 2048 characters.
pub fn avatar_url(raw: &str) -> ApiResult<String> {
    let url = raw.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| ApiErr::invalid("avatar_url", "Not a well formed URL."))?;
    if !matches!(parsed.scheme(), "http" | "https") || url.len() > 2048 {
        return Err(ApiErr::invalid("avatar_url", "Must be an http or https URL of at most 2048 characters."));
    }
    Ok(url.to_owned())
}

// ---- cleanup ----

/// Drops expired ephemeral messages and interactions whose token can no longer be used.
pub async fn sweep(state: &AppState) -> ApiResult<u64> {
    let ephemeral = sqlx::query("DELETE FROM ephemeral_messages WHERE created_at < now() - make_interval(secs => $1)")
        .bind(EPHEMERAL_LIFETIME_SECS as f64)
        .execute(&state.db)
        .await?
        .rows_affected();
    let interactions = sqlx::query("DELETE FROM interactions WHERE created_at < now() - make_interval(secs => $1)")
        .bind((TOKEN_LIFETIME_SECS * 4) as f64)
        .execute(&state.db)
        .await?
        .rows_affected();
    Ok(ephemeral + interactions)
}

/// Runs `sweep` every ten minutes; the task ends with the runtime.
pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(600));
        loop {
            ticker.tick().await;
            if let Err(error) = sweep(&state).await {
                tracing::warn!("apps sweep failed: {error:?}");
            }
        }
    });
}

/// `Value` of an interaction option as an id (user/channel/role options carry the id as a string).
pub fn option_id(value: &Value) -> Option<i64> {
    match value {
        Value::String(text) => crate::extract::parse_id(text),
        Value::Number(number) => number.as_u64().and_then(|id| crate::extract::parse_id(&id.to_string())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(value: Value) -> ApplicationCommandRequest {
        serde_json::from_value(value).expect("request")
    }

    fn embeds(value: Value) -> Vec<Embed> {
        serde_json::from_value(value).expect("embeds")
    }

    #[test]
    fn embeds_are_rich_bounded_and_link_only_to_the_web() {
        let input = embeds(json!([{
            "type": "video", "title": "t", "url": "javascript:alert(1)",
            "image": {"url": "data:image/png;base64,AAAA"}, "thumbnail": {"url": "https://example.com/t.png"},
            "author": {"name": "a", "url": "file:///etc/passwd", "icon_url": "http://example.com/a.png"}
        }]));
        let (_, cleaned) = validate_body(None, Some(&input), false).expect("valid");
        let embed = &cleaned[0];
        assert_eq!(embed.kind, vokko_protocol::api::EmbedType::Rich);
        assert!(embed.url.is_none() && embed.image.is_none());
        assert_eq!(embed.thumbnail.as_ref().map(|media| media.url.as_str()), Some("https://example.com/t.png"));
        let author = embed.author.as_ref().expect("author");
        assert!(author.url.is_none() && author.icon_url.is_some());

        let too_long = |part: Value| validate_body(None, Some(&embeds(json!([part]))), false).is_err();
        assert!(too_long(json!({"type": "rich", "title": "x".repeat(257)})));
        assert!(too_long(json!({"type": "rich", "description": "x".repeat(4097)})));
        assert!(too_long(json!({"type": "rich", "footer": {"text": "x".repeat(2049)}})));
        assert!(too_long(json!({"type": "rich", "author": {"name": "x".repeat(257)}})));
        assert!(too_long(json!({"type": "rich", "fields": [{"name": "n", "value": "x".repeat(1025)}]})));
        assert!(too_long(json!({"type": "rich", "fields": vec![json!({"name": "n", "value": "v"}); 26]})));
        // 6000 characters across all embeds of the message
        let big = json!({"type": "rich", "description": "x".repeat(4000)});
        assert!(validate_body(None, Some(&embeds(json!([big.clone(), big]))), false).is_err());
    }

    #[test]
    fn command_names_follow_discord_rules() {
        assert!(valid_command_name("echo") && valid_command_name("roll-2_d6") && valid_command_name("bråk"));
        assert!(!valid_command_name("Echo") && !valid_command_name("two words") && !valid_command_name("") && !valid_command_name(&"a".repeat(33)));
    }

    #[test]
    fn chat_input_commands_are_validated() {
        let spec = validate_command(
            &request(json!({"name": "roll", "description": "Roll", "options": [{"type": 4, "name": "sides", "description": "Sides", "required": true, "min_value": 2, "max_value": 100}]})),
            None,
        )
        .expect("valid");
        assert_eq!((spec.kind, spec.options.len(), spec.dm_permission), (ApplicationCommandType::ChatInput, 1, true));
        let cases = [
            json!({"name": "roll"}),
            json!({"name": "Roll", "description": "x"}),
            json!({"name": "roll", "description": "x", "options": [{"type": 3, "name": "a", "description": "a"}, {"type": 3, "name": "b", "description": "b", "required": true}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 3, "name": "a", "description": "a"}, {"type": 3, "name": "a", "description": "b"}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 5, "name": "a", "description": "a", "choices": [{"name": "x", "value": "x"}]}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 4, "name": "a", "description": "a", "choices": [{"name": "x", "value": "x"}]}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 3, "name": "a", "description": "a", "autocomplete": true, "choices": [{"name": "x", "value": "x"}]}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 4, "name": "a", "description": "a", "min_value": 5, "max_value": 1}]}),
            json!({"name": "roll", "description": "x", "options": [{"type": 3, "name": "a", "description": "a", "min_value": 1}]}),
            json!({"name": "roll", "description": "x", "default_member_permissions": "abc"}),
        ];
        for case in cases {
            assert!(validate_command(&request(case.clone()), None).is_err(), "{case}");
        }
    }

    #[test]
    fn context_menu_commands_have_no_description_or_options() {
        let spec = validate_command(&request(json!({"name": "Wave at", "type": 2})), None).expect("user command");
        assert_eq!((spec.kind, spec.description.as_str()), (ApplicationCommandType::User, ""));
        assert!(validate_command(&request(json!({"name": "Wave", "type": 3, "description": "x"})), None).is_err());
        assert!(validate_command(&request(json!({"name": "Wave", "type": 3, "options": [{"type": 3, "name": "a", "description": "a"}]})), None).is_err());
    }

    #[test]
    fn patch_keeps_unsent_fields() {
        let base = validate_command(&request(json!({"name": "roll", "description": "Roll", "default_member_permissions": "8192"})), None).expect("base");
        let patched = validate_command(&request(json!({"description": "Roll dice"})), Some(&base)).expect("patch");
        assert_eq!((patched.name.as_str(), patched.description.as_str(), patched.default_member_permissions), ("roll", "Roll dice", Some(8192)));
        let cleared = validate_command(&request(json!({"default_member_permissions": null})), Some(&base)).expect("clear");
        assert_eq!(cleared.default_member_permissions, None);
        assert!(validate_command(&request(json!({"type": 2})), Some(&base)).is_err());
    }

    #[test]
    fn webhook_names_and_tokens() {
        assert_eq!(webhook_name("  Alerts ", "name").expect("ok"), "Alerts");
        assert!(webhook_name("My Discord hook", "name").is_err() && webhook_name("", "name").is_err() && webhook_name(&"x".repeat(81), "name").is_err());
        assert!(tokens_match("abc", "abc") && !tokens_match("abc", "abd") && !tokens_match("abc", "ab"));
        assert!(avatar_url("https://example.com/a.png").is_ok() && avatar_url("javascript:alert(1)").is_err() && avatar_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn body_validation() {
        assert!(validate_body(Some(""), None, false).is_err());
        assert!(validate_body(Some(""), None, true).is_ok());
        assert_eq!(validate_body(Some(" hi "), None, false).expect("ok").0, "hi");
        assert!(validate_body(Some(&"x".repeat(2001)), None, false).is_err());
    }
}
