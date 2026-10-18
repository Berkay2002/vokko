//! Running application commands: `POST /interactions` (user), the bot's callback, followups and edits of the response.
use std::collections::BTreeMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use sqlx::FromRow;
use time::OffsetDateTime;
use vokko_protocol::api::message_flags::{EPHEMERAL, LOADING};
use vokko_protocol::api::{
    ApplicationCommandOption, ApplicationCommandOptionType, ApplicationCommandType, AutocompleteResponse, ComponentType, GatewayEvent, Interaction,
    InteractionCallbackType, InteractionCreated, InteractionData, InteractionDataOption, InteractionFailure, InteractionResolved, InteractionResponse,
    InteractionType, InvokeInteractionRequest, Message, MessageDelete, MessageInteractionMetadata, MessageType, ResolvedChannel, ResolvedMember, Snowflake,
    WebhookMessageRequest,
};

use crate::access::{self, channel_access};
use crate::apps::{
    self, CALLBACK_WINDOW, COMMAND_COLS, CommandRow, MessageIdentity, TOKEN_LIFETIME_SECS, find_component, option_id, resolve_app_mentions, validate_body,
    validate_components,
};
use crate::auth::{HumanUser, hash_token, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::messages::{Draft, Extras, broadcast_update, insert_message_with};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

pub fn routes() -> Router<AppState> {
    Router::new().route("/interactions", post(invoke)).route("/interactions/{id}/{token}/callback", post(callback))
}

#[derive(FromRow, Clone)]
pub struct InteractionRow {
    pub id: i64,
    pub application_id: i64,
    pub kind: i16,
    pub user_id: i64,
    pub channel_id: i64,
    pub command_name: String,
    pub command_type: i16,
    pub target_id: Option<i64>,
    pub nonce: Option<String>,
    pub responded: bool,
    pub original_message_id: Option<i64>,
    pub original_ephemeral: bool,
    pub created_at: OffsetDateTime,
}

const INTERACTION_COLS: &str = "id, application_id, kind, user_id, channel_id, command_name, command_type, target_id, nonce, responded, \
     original_message_id, original_ephemeral, created_at";

impl InteractionRow {
    fn command_type(&self) -> ApplicationCommandType {
        ApplicationCommandType::from_u8(self.command_type as u8).unwrap_or(ApplicationCommandType::ChatInput)
    }

    fn token_alive(&self) -> bool {
        (OffsetDateTime::now_utc() - self.created_at).whole_seconds() < TOKEN_LIFETIME_SECS
    }
}

// ---- invoking ----

fn option_error(name: &str, message: &str) -> ApiErr {
    ApiErr::invalid(&format!("data.options.{name}"), message)
}

/// Checks the options a user sent against the command; `autocomplete` relaxes required options and choices for the focused one.
fn check_options(definitions: &[ApplicationCommandOption], given: &[InteractionDataOption], autocomplete: bool) -> ApiResult<()> {
    use ApplicationCommandOptionType as Kind;
    let mut seen = std::collections::HashSet::new();
    for option in given {
        let Some(definition) = definitions.iter().find(|definition| definition.name == option.name) else {
            return Err(option_error(&option.name, "Unknown option."));
        };
        if !seen.insert(option.name.as_str()) {
            return Err(option_error(&option.name, "Given more than once."));
        }
        if definition.kind != option.kind {
            return Err(option_error(&option.name, "Wrong option type."));
        }
        let focused = autocomplete && option.focused == Some(true);
        let value = &option.value;
        let fits = match definition.kind {
            Kind::String => value.as_str().is_some_and(|text| {
                let length = text.chars().count() as u32;
                focused || (length >= definition.min_length.unwrap_or(0) && length <= definition.max_length.unwrap_or(6000))
            }),
            Kind::Integer => value.as_i64().is_some_and(|number| focused || in_range(definition, number as f64)),
            Kind::Number => value.as_f64().is_some_and(|number| number.is_finite() && (focused || in_range(definition, number))),
            Kind::Boolean => value.is_boolean(),
            Kind::User | Kind::Channel | Kind::Role => option_id(value).is_some(),
        };
        if !fits {
            return Err(option_error(&option.name, "Invalid value."));
        }
        if let Some(choices) = &definition.choices
            && !focused
            && !choices.iter().any(|choice| choice.value == *value || (choice.value.as_f64().is_some() && choice.value.as_f64() == value.as_f64()))
        {
            return Err(option_error(&option.name, "Not one of the choices."));
        }
    }
    if !autocomplete && let Some(missing) = definitions.iter().find(|definition| definition.required == Some(true) && !seen.contains(definition.name.as_str()))
    {
        return Err(option_error(&missing.name, "This option is required."));
    }
    Ok(())
}

fn in_range(definition: &ApplicationCommandOption, number: f64) -> bool {
    definition.min_value.is_none_or(|min| number >= min) && definition.max_value.is_none_or(|max| number <= max)
}

/// The users, members, channels and roles behind the options, and the target of a context-menu command.
async fn resolve(
    state: &AppState,
    row: &ChannelRow,
    user_id: i64,
    options: &[InteractionDataOption],
    target: Option<(ApplicationCommandType, i64)>,
) -> ApiResult<InteractionResolved> {
    let mut resolved = InteractionResolved::default();
    let mut user_ids: Vec<i64> =
        options.iter().filter(|option| option.kind == ApplicationCommandOptionType::User).filter_map(|option| option_id(&option.value)).collect();
    if let Some((ApplicationCommandType::User, id)) = target {
        user_ids.push(id);
    }
    if !user_ids.is_empty() {
        let users = store::users(state, &user_ids).await?;
        if users.len() != {
            let mut unique = user_ids.clone();
            unique.sort_unstable();
            unique.dedup();
            unique.len()
        } {
            return Err(ApiErr::invalid("data.options", "Unknown user."));
        }
        if let Some(guild_id) = row.guild_id {
            let mut members = BTreeMap::new();
            for id in &user_ids {
                if let Some(member) = store::member(state, guild_id, *id).await? {
                    members.insert(Snowflake::from(*id), ResolvedMember { nick: member.nick, roles: member.roles, joined_at: member.joined_at });
                }
            }
            resolved.members = (!members.is_empty()).then_some(members);
        }
        resolved.users = Some(users.into_iter().map(|(id, user)| (Snowflake::from(id), user)).collect());
    }
    let channel_ids: Vec<i64> =
        options.iter().filter(|option| option.kind == ApplicationCommandOptionType::Channel).filter_map(|option| option_id(&option.value)).collect();
    if !channel_ids.is_empty() {
        let visible = access::viewable_channels(state, user_id, &channel_ids).await?;
        let mut channels = BTreeMap::new();
        for id in channel_ids {
            let channel = store::channel_row(state, id).await?.filter(|channel| visible.contains(&channel.id) && channel.guild_id == row.guild_id);
            let Some(channel) = channel else { return Err(ApiErr::invalid("data.options", "Unknown channel.")) };
            channels.insert(
                Snowflake::from(id),
                ResolvedChannel {
                    id: Snowflake::from(id),
                    kind: channel.channel_type(),
                    name: channel.name.clone(),
                    parent_id: channel.parent_id.map(Snowflake::from),
                },
            );
        }
        resolved.channels = Some(channels);
    }
    let role_ids: Vec<i64> =
        options.iter().filter(|option| option.kind == ApplicationCommandOptionType::Role).filter_map(|option| option_id(&option.value)).collect();
    if !role_ids.is_empty() {
        let guild = match row.guild_id {
            Some(guild_id) => store::guild(state, guild_id).await?,
            None => None,
        };
        let mut roles = BTreeMap::new();
        for id in role_ids {
            let role = guild.as_ref().and_then(|guild| guild.roles.iter().find(|role| role.id.db() == id)).cloned();
            let Some(role) = role else { return Err(ApiErr::invalid("data.options", "Unknown role.")) };
            roles.insert(role.id, role);
        }
        resolved.roles = Some(roles);
    }
    if let Some((ApplicationCommandType::Message, id)) = target {
        let found: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2").bind(id).bind(row.id).fetch_optional(&state.db).await?;
        let view = match found {
            Some(_) => store::message_view(state, id, Some(user_id)).await?,
            None => None,
        };
        let Some(view) = view else { return Err(ApiErr::invalid("data.target_id", "Unknown message.")) };
        resolved.messages = Some(BTreeMap::from([(Snowflake::from(id), view.message)]));
    }
    Ok(resolved)
}

async fn invoke(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    ApiJson(body): ApiJson<InvokeInteractionRequest>,
) -> ApiResult<Json<InteractionCreated>> {
    let autocomplete = match body.kind {
        InteractionType::ApplicationCommand => false,
        InteractionType::ApplicationCommandAutocomplete => true,
        InteractionType::MessageComponent => return invoke_component(state, user_id, body).await,
        InteractionType::Ping => return Err(ApiErr::invalid("type", "Must be 2, 3 or 4.")),
    };
    if let Err(retry_after) = state.limiter.check_key("interactions", user_id, 5.0, 1.0) {
        return Err(ApiErr::rate_limited(retry_after));
    }
    let (Some(data_id), Some(data_kind)) = (body.data.id, body.data.kind) else {
        return Err(ApiErr::invalid("data", "id and type are required."));
    };
    let channel_id = body.channel_id.db();
    let access = channel_access(&state, user_id, channel_id).await?;
    let (_, commands) = apps::usable_commands(&state, user_id, &access).await?;
    let command = commands.into_iter().find(|command| command.id == data_id.db() && command.application_id == body.application_id.db());
    let Some(command) = command else {
        // A command that exists but may not be used here is a permission problem, anything else is unknown.
        let exists: Option<CommandRow> = sqlx::query_as(&format!("SELECT {COMMAND_COLS} FROM application_commands WHERE id = $1 AND application_id = $2"))
            .bind(data_id.db())
            .bind(body.application_id.db())
            .fetch_optional(&state.db)
            .await?;
        let bot_here: Option<(i64,)> = match access.channel.guild_id {
            Some(guild_id) => {
                sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
                    .bind(guild_id)
                    .bind(body.application_id.db())
                    .fetch_optional(&state.db)
                    .await?
            }
            None => None,
        };
        let visible_scope =
            bot_here.is_some() && exists.as_ref().is_some_and(|command| command.guild_id.is_none() || command.guild_id == access.channel.guild_id);
        return Err(if visible_scope { ApiErr::missing_permissions() } else { ApiErr::unknown_command() });
    };
    let kind = command.kind();
    if data_kind != kind {
        return Err(ApiErr::invalid("data.type", "Does not match the command."));
    }
    if autocomplete && kind != ApplicationCommandType::ChatInput {
        return Err(ApiErr::invalid("type", "Only slash commands autocomplete."));
    }
    let options = body.data.options.clone().unwrap_or_default();
    let definitions = command.options();
    check_options(&definitions, &options, autocomplete)?;
    if autocomplete && options.iter().filter(|option| option.focused == Some(true)).count() != 1 {
        return Err(ApiErr::invalid("data.options", "Exactly one option must be focused."));
    }
    let target = match kind {
        ApplicationCommandType::ChatInput => None,
        other => Some((other, body.data.target_id.map(Snowflake::db).ok_or_else(|| ApiErr::invalid("data.target_id", "This field is required."))?)),
    };
    let resolved = resolve(&state, &access.channel, user_id, &options, target).await?;

    let id = state.ids.next();
    let token = random_hex(32);
    let guild_id = access.channel.guild_id;
    sqlx::query(
        "INSERT INTO interactions (id, application_id, token_hash, kind, user_id, channel_id, guild_id, command_id, command_name, command_type, target_id, nonce) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(id)
    .bind(command.application_id)
    .bind(hash_token(&token))
    .bind(body.kind.as_u8() as i16)
    .bind(user_id)
    .bind(channel_id)
    .bind(guild_id)
    .bind(command.id)
    .bind(&command.name)
    .bind(kind.as_u8() as i16)
    .bind(target.map(|(_, id)| id))
    .bind(&body.nonce)
    .execute(&state.db)
    .await?;
    let user = store::user(&state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let member = match guild_id {
        Some(guild_id) => store::member(&state, guild_id, user_id).await?,
        None => None,
    };
    let app_permissions = match access::channel_access(&state, command.application_id, channel_id).await {
        Ok(bot) => bot.permissions,
        Err(_) => 0,
    };
    let interaction = Interaction {
        id: Snowflake::from(id),
        application_id: Snowflake::from(command.application_id),
        kind: body.kind,
        data: InteractionData {
            id: Some(Snowflake::from(command.id)),
            name: Some(command.name.clone()),
            kind: Some(kind),
            guild_id: command.guild_id.map(Snowflake::from),
            options: (!options.is_empty()).then_some(options),
            resolved: (resolved != InteractionResolved::default()).then_some(resolved),
            target_id: target.map(|(_, id)| Snowflake::from(id)),
            ..InteractionData::default()
        },
        guild_id: guild_id.map(Snowflake::from),
        channel_id: Snowflake::from(channel_id),
        member,
        user,
        token,
        app_permissions: app_permissions.to_string(),
        version: 1,
        message: None,
    };
    state.hub.send(&[command.application_id], &GatewayEvent::InteractionCreate(Box::new(interaction)));
    if !autocomplete {
        watch_answer(&state, id, command.application_id, user_id, channel_id, body.nonce.clone());
    }
    Ok(Json(InteractionCreated { id: Snowflake::from(id), nonce: body.nonce }))
}

/// Tells the user (INTERACTION_FAILURE) when the bot has not answered within the callback window.
fn watch_answer(state: &AppState, id: i64, application_id: i64, user_id: i64, channel_id: i64, nonce: Option<String>) {
    let watcher = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(CALLBACK_WINDOW).await;
        let answered: Option<(bool,)> =
            sqlx::query_as("SELECT responded FROM interactions WHERE id = $1").bind(id).fetch_optional(&watcher.db).await.ok().flatten();
        if answered.is_none_or(|(responded,)| !responded) {
            let event = GatewayEvent::InteractionFailure(InteractionFailure {
                id: Snowflake::from(id),
                nonce,
                channel_id: Snowflake::from(channel_id),
                application_id: Snowflake::from(application_id),
            });
            watcher.hub.send(&[user_id], &event);
        }
    });
}

/// A click on a button or a choice in a select menu: relayed to the message's application like a command.
async fn invoke_component(state: AppState, user_id: i64, body: InvokeInteractionRequest) -> ApiResult<Json<InteractionCreated>> {
    let required = |field: &str| ApiErr::invalid(field, "This field is required.");
    let custom_id = body.data.custom_id.clone().ok_or_else(|| required("data.custom_id"))?;
    let component_type = body.data.component_type.ok_or_else(|| required("data.component_type"))?;
    let message_id = body.message_id.ok_or_else(|| required("message_id"))?.db();
    if let Err(retry_after) = state.limiter.check_key("interactions", user_id, 5.0, 1.0) {
        return Err(ApiErr::rate_limited(retry_after));
    }
    let (channel_id, application_id) = (body.channel_id.db(), body.application_id.db());
    let access = channel_access(&state, user_id, channel_id).await?;
    // The message is a channel message, or an ephemeral one of this user.
    let message = match apps::ephemeral(&state, message_id).await? {
        Some((message, recipient)) => (recipient == user_id).then_some(message),
        None => store::message_view(&state, message_id, Some(user_id)).await?.map(|view| view.message),
    };
    let message = message.filter(|message| message.channel_id.db() == channel_id).ok_or_else(ApiErr::unknown_message)?;
    if message.application_id.unwrap_or(message.author.id).db() != application_id {
        return Err(ApiErr::invalid("application_id", "Does not match the message."));
    }
    let component = find_component(&message.components, &custom_id).ok_or_else(|| ApiErr::invalid("data.custom_id", "Unknown component."))?;
    if component.kind != component_type {
        return Err(ApiErr::invalid("data.component_type", "Does not match the component."));
    }
    if component.disabled == Some(true) {
        return Err(ApiErr::invalid("data.custom_id", "This component is disabled."));
    }
    let values = body.data.values.clone().unwrap_or_default();
    let fits = match component_type {
        ComponentType::StringSelect => values.len() == 1 && component.options.iter().flatten().any(|option| option.value == values[0]),
        _ => values.is_empty(),
    };
    if !fits {
        return Err(ApiErr::invalid("data.values", "Pick exactly one of the options (none for a button)."));
    }
    let id = state.ids.next();
    let token = random_hex(32);
    sqlx::query(
        "INSERT INTO interactions (id, application_id, token_hash, kind, user_id, channel_id, guild_id, command_name, command_type, target_id, nonce, custom_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '', 1, $8, $9, $10)",
    )
    .bind(id)
    .bind(application_id)
    .bind(hash_token(&token))
    .bind(InteractionType::MessageComponent.as_u8() as i16)
    .bind(user_id)
    .bind(channel_id)
    .bind(access.channel.guild_id)
    .bind(message_id)
    .bind(&body.nonce)
    .bind(&custom_id)
    .execute(&state.db)
    .await?;
    let user = store::user(&state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let member = match access.channel.guild_id {
        Some(guild_id) => store::member(&state, guild_id, user_id).await?,
        None => None,
    };
    let app_permissions = access::channel_access(&state, application_id, channel_id).await.map_or(0, |bot| bot.permissions);
    let interaction = Interaction {
        id: Snowflake::from(id),
        application_id: Snowflake::from(application_id),
        kind: InteractionType::MessageComponent,
        data: InteractionData {
            custom_id: Some(custom_id),
            component_type: Some(component_type),
            values: (component_type == ComponentType::StringSelect).then_some(values),
            ..InteractionData::default()
        },
        guild_id: access.channel.guild_id.map(Snowflake::from),
        channel_id: Snowflake::from(channel_id),
        member,
        user,
        token,
        app_permissions: app_permissions.to_string(),
        version: 1,
        message: Some(Box::new(message)),
    };
    state.hub.send(&[application_id], &GatewayEvent::InteractionCreate(Box::new(interaction)));
    watch_answer(&state, id, application_id, user_id, channel_id, body.nonce.clone());
    Ok(Json(InteractionCreated { id: Snowflake::from(id), nonce: body.nonce }))
}

// ---- the bot's side ----

async fn interaction_by_token(state: &AppState, id: i64, token: &str) -> ApiResult<InteractionRow> {
    let row: Option<InteractionRow> = sqlx::query_as(&format!("SELECT {INTERACTION_COLS} FROM interactions WHERE id = $1 AND token_hash = $2"))
        .bind(id)
        .bind(hash_token(token))
        .fetch_optional(&state.db)
        .await?;
    row.ok_or_else(ApiErr::unknown_interaction)
}

/// The interaction of a followup/edit URL: `/webhooks/{application_id}/{token}`, answered, token not expired.
pub async fn interaction_for_app_token(state: &AppState, application_id: i64, token: &str) -> ApiResult<Option<InteractionRow>> {
    let row: Option<InteractionRow> = sqlx::query_as(&format!("SELECT {INTERACTION_COLS} FROM interactions WHERE application_id = $1 AND token_hash = $2"))
        .bind(application_id)
        .bind(hash_token(token))
        .fetch_optional(&state.db)
        .await?;
    match row {
        Some(row) if !row.token_alive() => Err(ApiErr::unknown_interaction()),
        other => Ok(other),
    }
}

fn metadata(row: &InteractionRow, user: vokko_protocol::api::User, target_user: Option<vokko_protocol::api::User>) -> MessageInteractionMetadata {
    let command_type = row.command_type();
    MessageInteractionMetadata {
        id: Snowflake::from(row.id),
        kind: InteractionType::ApplicationCommand,
        user,
        name: row.command_name.clone(),
        command_type,
        target_user,
        target_message_id: (command_type == ApplicationCommandType::Message).then(|| row.target_id.map(Snowflake::from)).flatten(),
    }
}

/// Builds and stores a message of the interaction's bot in its channel: in `messages` (everyone sees it), or only for the user
/// who ran the command when `flags` has EPHEMERAL. `original` = the callback response (type 20/23 with interaction metadata).
async fn post_message(state: &AppState, row: &InteractionRow, request: &WebhookMessageRequest, original: bool, loading: bool) -> ApiResult<Message> {
    let channel = store::channel_row(state, row.channel_id).await?.ok_or_else(ApiErr::unknown_channel)?;
    let components = request.components.as_deref().map(validate_components).transpose()?.unwrap_or_default();
    let (content, embeds) = validate_body(request.content.as_deref(), request.embeds.as_ref(), loading || !components.is_empty())?;
    let ephemeral = request.flags.unwrap_or(0) & EPHEMERAL != 0;
    let flags = (if ephemeral { EPHEMERAL } else { 0 }) | (if loading { LOADING } else { 0 });
    // The reply to a click is a plain message: it ran no command, so it has no "used /command" line.
    let original = original && row.kind != InteractionType::MessageComponent.as_u8() as i16;
    let kind = match (original, row.command_type()) {
        (false, _) => MessageType::Default,
        (true, ApplicationCommandType::ChatInput) => MessageType::ChatInputCommand,
        (true, _) => MessageType::ContextMenuCommand,
    };
    let invoker = store::user(state, row.user_id).await?.ok_or_else(ApiErr::unknown_user)?;
    let target_user = match (row.command_type(), row.target_id) {
        (ApplicationCommandType::User, Some(id)) => store::user(state, id).await?,
        _ => None,
    };
    let interaction_metadata = original.then(|| metadata(row, invoker, target_user));
    let mentions = resolve_app_mentions(state, &channel, &content, request.allowed_mentions.as_ref(), Some(row.application_id)).await?;
    if ephemeral {
        let author = store::user(state, row.application_id).await?.ok_or_else(ApiErr::unknown_application)?;
        let mentioned = store::users(state, &mentions.users).await?;
        let mut embeds = embeds;
        crate::embed_media::fill(state, &mut embeds);
        let message = Message {
            id: Snowflake::from(state.ids.next()),
            channel_id: Snowflake::from(channel.id),
            guild_id: channel.guild_id.map(Snowflake::from),
            author,
            member: None,
            content,
            timestamp: store::iso(OffsetDateTime::now_utc()),
            edited_timestamp: None,
            kind,
            mentions: mentions.users.iter().filter_map(|id| mentioned.get(id).cloned()).collect(),
            mention_roles: Vec::new(),
            mention_everyone: false,
            attachments: Vec::new(),
            embeds,
            components,
            reactions: Vec::new(),
            pinned: false,
            tts: false,
            message_reference: None,
            referenced_message: None,
            nonce: None,
            sticker_items: Vec::new(),
            message_snapshots: Vec::new(),
            flags: Some(flags),
            thread: None,
            webhook_id: Some(Snowflake::from(row.application_id)),
            application_id: Some(Snowflake::from(row.application_id)),
            interaction_metadata: interaction_metadata.map(Box::new),
            call: None,
            poll: None,
        };
        apps::insert_ephemeral(state, &message, row.user_id, Some(row.id)).await?;
        return Ok(message);
    }
    let identity = MessageIdentity {
        webhook_id: Some(row.application_id),
        application_id: Some(row.application_id),
        name: None,
        avatar: None,
        interaction_metadata: interaction_metadata.map(|metadata| serde_json::to_string(&metadata)).transpose().map_err(|_| ApiErr::internal())?,
    };
    let extras = Extras {
        flags: flags as i32,
        embeds: (!embeds.is_empty()).then(|| serde_json::to_string(&embeds)).transpose().map_err(|_| ApiErr::internal())?,
        components: (!components.is_empty()).then(|| serde_json::to_string(&components)).transpose().map_err(|_| ApiErr::internal())?,
        identity: Some(identity),
        ..Extras::default()
    };
    let draft =
        Draft { content, kind, reference: None, attachments: Vec::new(), nonce: None, mentions, ping_replied: false, stickers: Vec::new(), forward: None };
    let view = insert_message_with(state, &channel, row.application_id, draft, extras).await?;
    Ok(view.message)
}

async fn callback(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
    ApiJson(body): ApiJson<InteractionResponse>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_interaction)?;
    let row = interaction_by_token(&state, id, &token).await?;
    let autocomplete = row.kind == InteractionType::ApplicationCommandAutocomplete.as_u8() as i16;
    let component = row.kind == InteractionType::MessageComponent.as_u8() as i16;
    let allowed = match body.kind {
        InteractionCallbackType::ApplicationCommandAutocompleteResult => autocomplete,
        InteractionCallbackType::DeferredUpdateMessage | InteractionCallbackType::UpdateMessage => component,
        InteractionCallbackType::DeferredChannelMessageWithSource => !autocomplete && !component,
        InteractionCallbackType::ChannelMessageWithSource => !autocomplete,
    };
    if !allowed {
        return Err(ApiErr::invalid("type", "This response type does not fit the interaction."));
    }
    let data = body.data.unwrap_or_default();
    // Validate before claiming the interaction, so a bad body can be corrected within the window.
    if body.kind == InteractionCallbackType::ApplicationCommandAutocompleteResult {
        let choices = data.choices.clone().unwrap_or_default();
        if choices.len() > 25 {
            return Err(ApiErr::invalid("data.choices", "Must be 25 or fewer in length."));
        }
    } else if body.kind != InteractionCallbackType::DeferredUpdateMessage {
        let components = data.components.as_deref().map(validate_components).transpose()?;
        let deferred = body.kind == InteractionCallbackType::DeferredChannelMessageWithSource;
        // An update keeps what it leaves out, so it may be empty; so may a message that carries components.
        let may_be_empty = deferred || body.kind == InteractionCallbackType::UpdateMessage || components.is_some_and(|components| !components.is_empty());
        validate_body(data.content.as_deref(), data.embeds.as_ref(), may_be_empty)?;
    }
    let window = CALLBACK_WINDOW.as_secs_f64();
    let claimed = sqlx::query("UPDATE interactions SET responded = TRUE WHERE id = $1 AND NOT responded AND created_at > now() - make_interval(secs => $2)")
        .bind(row.id)
        .bind(window)
        .execute(&state.db)
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(if row.responded { ApiErr::already_acknowledged() } else { ApiErr::unknown_interaction() });
    }
    match body.kind {
        InteractionCallbackType::ApplicationCommandAutocompleteResult => {
            let event = GatewayEvent::AutocompleteResponse(AutocompleteResponse {
                id: Snowflake::from(row.id),
                nonce: row.nonce.clone(),
                choices: data.choices.unwrap_or_default(),
            });
            state.hub.send(&[row.user_id], &event);
        }
        InteractionCallbackType::DeferredUpdateMessage | InteractionCallbackType::UpdateMessage => {
            // The response is the clicked message: @original names it from now on.
            let clicked = row.target_id.ok_or_else(ApiErr::unknown_message)?;
            let ephemeral = apps::ephemeral(&state, clicked).await?.is_some();
            if body.kind == InteractionCallbackType::UpdateMessage {
                let request = WebhookMessageRequest {
                    content: data.content,
                    embeds: data.embeds,
                    components: data.components,
                    allowed_mentions: data.allowed_mentions,
                    ..WebhookMessageRequest::default()
                };
                let shown = InteractionRow { original_message_id: Some(clicked), original_ephemeral: ephemeral, ..row.clone() };
                if let Err(error) = edit_message(&state, &shown, "@original", &request).await {
                    sqlx::query("UPDATE interactions SET responded = FALSE WHERE id = $1").bind(row.id).execute(&state.db).await?;
                    return Err(error);
                }
            }
            sqlx::query("UPDATE interactions SET original_message_id = $2, original_ephemeral = $3 WHERE id = $1")
                .bind(row.id)
                .bind(clicked)
                .bind(ephemeral)
                .execute(&state.db)
                .await?;
        }
        kind => {
            let loading = kind == InteractionCallbackType::DeferredChannelMessageWithSource;
            let request = WebhookMessageRequest {
                content: if loading { None } else { data.content },
                embeds: if loading { None } else { data.embeds },
                components: if loading { None } else { data.components },
                flags: data.flags,
                allowed_mentions: data.allowed_mentions,
                username: None,
                avatar_url: None,
            };
            let message = match post_message(&state, &row, &request, true, loading).await {
                Ok(message) => message,
                Err(error) => {
                    // no response message after all: unclaim, so the bot may retry and the user still hears that it failed
                    sqlx::query("UPDATE interactions SET responded = FALSE WHERE id = $1 AND original_message_id IS NULL")
                        .bind(row.id)
                        .execute(&state.db)
                        .await?;
                    return Err(error);
                }
            };
            let ephemeral = message.flags.unwrap_or(0) & EPHEMERAL != 0;
            sqlx::query("UPDATE interactions SET original_message_id = $2, original_ephemeral = $3 WHERE id = $1")
                .bind(row.id)
                .bind(message.id.db())
                .bind(ephemeral)
                .execute(&state.db)
                .await?;
        }
    }
    if component {
        let event = InteractionFailure {
            id: Snowflake::from(row.id),
            nonce: row.nonce.clone(),
            channel_id: Snowflake::from(row.channel_id),
            application_id: Snowflake::from(row.application_id),
        };
        state.hub.send(&[row.user_id], &GatewayEvent::InteractionSuccess(event));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /webhooks/{app_id}/{token}` for an interaction: a followup message (only after the callback).
pub async fn followup(state: &AppState, row: &InteractionRow, body: &WebhookMessageRequest) -> ApiResult<Message> {
    if !row.responded || row.original_message_id.is_none() {
        return Err(ApiErr::unknown_interaction());
    }
    post_message(state, row, body, false, false).await
}

/// Which message `/messages/{mid}` names for this interaction: `@original`, or a followup of the same bot in the same channel.
/// Returns (message id, ephemeral).
async fn target_message(state: &AppState, row: &InteractionRow, mid: &str) -> ApiResult<(i64, bool)> {
    if mid == "@original" {
        let id = row.original_message_id.ok_or_else(ApiErr::unknown_message)?;
        return Ok((id, row.original_ephemeral));
    }
    let id = parse_id(mid).ok_or_else(ApiErr::unknown_message)?;
    if let Some((message, recipient)) = apps::ephemeral(state, id).await? {
        if message.application_id.map(Snowflake::db) == Some(row.application_id) && recipient == row.user_id {
            return Ok((id, true));
        }
        return Err(ApiErr::unknown_message());
    }
    let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND (application_id = $3 OR author_id = $3)")
        .bind(id)
        .bind(row.channel_id)
        .bind(row.application_id)
        .fetch_optional(&state.db)
        .await?;
    found.map(|(id,)| (id, false)).ok_or_else(ApiErr::unknown_message)
}

pub async fn get_message(state: &AppState, row: &InteractionRow, mid: &str) -> ApiResult<Message> {
    let (id, ephemeral) = target_message(state, row, mid).await?;
    if ephemeral {
        return apps::ephemeral(state, id).await?.map(|(message, _)| message).ok_or_else(ApiErr::unknown_message);
    }
    store::message_view(state, id, None).await?.map(|view| view.message).ok_or_else(ApiErr::unknown_message)
}

/// Edits the response or a followup; a Loading response loses Loading (the "thinking" state ends) without counting as edited.
pub async fn edit_message(state: &AppState, row: &InteractionRow, mid: &str, body: &WebhookMessageRequest) -> ApiResult<Message> {
    let (id, ephemeral) = target_message(state, row, mid).await?;
    let channel = store::channel_row(state, row.channel_id).await?.ok_or_else(ApiErr::unknown_channel)?;
    if ephemeral {
        let (mut message, recipient) = apps::ephemeral(state, id).await?.ok_or_else(ApiErr::unknown_message)?;
        let was_loading = message.flags.unwrap_or(0) & LOADING != 0;
        let content = body.content.clone().unwrap_or_else(|| message.content.clone());
        let embeds = body.embeds.clone().unwrap_or_else(|| message.embeds.clone());
        if let Some(components) = &body.components {
            message.components = validate_components(components)?;
        }
        let (content, embeds) = validate_body(Some(&content), Some(&embeds), !message.components.is_empty())?;
        let mentions = resolve_app_mentions(state, &channel, &content, body.allowed_mentions.as_ref(), Some(row.application_id)).await?;
        let mentioned = store::users(state, &mentions.users).await?;
        message.mentions = mentions.users.iter().filter_map(|id| mentioned.get(id).cloned()).collect();
        message.content = content;
        message.embeds = embeds;
        message.flags = Some(message.flags.unwrap_or(0) & !LOADING);
        if !was_loading {
            message.edited_timestamp = Some(store::iso(OffsetDateTime::now_utc()));
        }
        apps::update_ephemeral(state, &message, recipient).await?;
        return Ok(message);
    }
    edit_stored(state, &channel, id, body, Some(row.application_id)).await
}

/// Edits a webhook or interaction message stored in `messages`: content, embeds and mentions; Loading is cleared (and then the
/// edit is not shown as one). MESSAGE_UPDATE to the channel.
/// `bot` is the interaction's application (None for a webhook message).
pub async fn edit_stored(state: &AppState, channel: &ChannelRow, id: i64, body: &WebhookMessageRequest, bot: Option<i64>) -> ApiResult<Message> {
    let current = store::message_view(state, id, None).await?.ok_or_else(ApiErr::unknown_message)?.message;
    let was_loading = current.flags.unwrap_or(0) & LOADING != 0;
    let content = body.content.clone().unwrap_or_else(|| current.content.clone());
    let embeds = body.embeds.clone().unwrap_or_else(|| current.embeds.clone());
    // Only applications send components; a plain webhook's buttons would have nobody to answer them.
    let components = match &body.components {
        Some(components) if bot.is_none() && !components.is_empty() => return Err(ApiErr::invalid("components", "Webhooks cannot send components.")),
        Some(components) => Some(validate_components(components)?),
        None => None,
    };
    let has_components = components.as_ref().map_or(!current.components.is_empty(), |components| !components.is_empty());
    let (content, embeds) = validate_body(Some(&content), Some(&embeds), has_components)?;
    let mentions = resolve_app_mentions(state, channel, &content, body.allowed_mentions.as_ref(), bot).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE messages SET content = $2, embeds = $3::jsonb, flags = flags & ~$4::int, mention_everyone = $5, \
         edited_at = CASE WHEN $6 THEN edited_at ELSE now() END, components = COALESCE($7::jsonb, components) WHERE id = $1",
    )
    .bind(id)
    .bind(&content)
    .bind(serde_json::to_string(&embeds).map_err(|_| ApiErr::internal())?)
    .bind(LOADING as i32)
    .bind(mentions.everyone)
    .bind(was_loading)
    .bind(components.as_ref().map(serde_json::to_string).transpose().map_err(|_| ApiErr::internal())?)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM message_mentions WHERE message_id = $1").bind(id).execute(&mut *tx).await?;
    for user in &mentions.users {
        sqlx::query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(id).bind(user).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    broadcast_update(state, channel, id).await?.map(|view| view.message).ok_or_else(ApiErr::unknown_message)
}

pub async fn delete_message(state: &AppState, row: &InteractionRow, mid: &str) -> ApiResult<()> {
    let (id, ephemeral) = target_message(state, row, mid).await?;
    if ephemeral {
        apps::delete_ephemeral(state, id).await?;
        return Ok(());
    }
    let channel = store::channel_row(state, row.channel_id).await?.ok_or_else(ApiErr::unknown_channel)?;
    delete_channel_message(state, &channel, id).await
}

/// Deletes a message the way `DELETE /channels/{id}/messages/{mid}` does (attachments, last_message_id, MESSAGE_DELETE).
pub async fn delete_channel_message(state: &AppState, channel: &ChannelRow, id: i64) -> ApiResult<()> {
    let viewers = access::channel_viewers(state, channel).await?;
    let files: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE message_id = $1 RETURNING id").bind(id).fetch_all(&state.db).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1").bind(id).execute(&state.db).await?;
    sqlx::query("UPDATE channels SET last_message_id = (SELECT max(id) FROM messages WHERE channel_id = $1) WHERE id = $1 AND last_message_id = $2")
        .bind(channel.id)
        .bind(id)
        .execute(&state.db)
        .await?;
    crate::media::remove_files(state, &files.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    let event = GatewayEvent::MessageDelete(MessageDelete {
        id: Snowflake::from(id),
        channel_id: Snowflake::from(channel.id),
        guild_id: channel.guild_id.map(Snowflake::from),
    });
    state.hub.send(&viewers, &event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn definitions() -> Vec<ApplicationCommandOption> {
        serde_json::from_value(json!([
            {"type": 3, "name": "text", "description": "t", "required": true, "max_length": 5},
            {"type": 4, "name": "sides", "description": "s", "min_value": 2, "max_value": 6},
            {"type": 3, "name": "mode", "description": "m", "choices": [{"name": "A", "value": "a"}]},
            {"type": 6, "name": "who", "description": "w"}
        ]))
        .expect("definitions")
    }

    fn given(value: Value) -> Vec<InteractionDataOption> {
        serde_json::from_value(value).expect("options")
    }

    #[test]
    fn options_are_checked_against_the_command() {
        let defs = definitions();
        assert!(check_options(&defs, &given(json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "sides", "type": 4, "value": 6}])), false).is_ok());
        let bad = [
            json!([]),
            json!([{"name": "text", "type": 3, "value": "toolong"}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "sides", "type": 4, "value": 7}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "sides", "type": 4, "value": "6"}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "mode", "type": 3, "value": "b"}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "who", "type": 6, "value": "nope"}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "nope", "type": 3, "value": "x"}]),
            json!([{"name": "text", "type": 3, "value": "hi"}, {"name": "text", "type": 3, "value": "x"}]),
        ];
        for case in bad {
            assert!(check_options(&defs, &given(case.clone()), false).is_err(), "{case}");
        }
        // autocomplete: required options may be missing and the focused value is not range-checked
        assert!(check_options(&defs, &given(json!([{"name": "sides", "type": 4, "value": 99, "focused": true}])), true).is_ok());
    }
}
