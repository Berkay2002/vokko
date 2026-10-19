//! Member onboarding: the guild's questions (prompts with options that grant roles and point at channels), a rules screen,
//! default channels, and the member's answers.
use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use sqlx::FromRow;
use vokko_protocol::api::member_flags::COMPLETED_ONBOARDING;
use vokko_protocol::api::permissions::{MANAGE_GUILD, MANAGE_ROLES};
use vokko_protocol::api::{
    EditOnboardingRequest, GatewayEvent, GuildMemberAdd, GuildOnboarding, OnboardingCompletion, OnboardingMode, OnboardingOption, OnboardingOptionInput,
    OnboardingPrompt, OnboardingPromptInput, OnboardingPromptType, OnboardingResponses, OnboardingResponsesRequest, OnboardingRules, ReactionEmoji, Snowflake,
};

use crate::access::{self, RoleRank, compare_roles, guild_access, highest_role};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::overwrites;
use crate::state::AppState;
use crate::store;

const MAX_PROMPTS: usize = 15;
const MAX_OPTIONS: usize = 50;
const MAX_DEFAULT_CHANNELS: usize = 50;
const MAX_RULES: usize = 16;
/// Channels or roles one option may point at.
const MAX_TARGETS: usize = 25;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/onboarding", get(get_onboarding).put(put_onboarding))
        .route("/guilds/{id}/onboarding-responses", get(get_responses).put(put_responses))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn flake(id: i64) -> Snowflake {
    Snowflake::from(id)
}

#[derive(FromRow)]
struct PromptRow {
    id: i64,
    kind: i16,
    title: String,
    single_select: bool,
    required: bool,
    in_onboarding: bool,
}

#[derive(FromRow)]
struct OptionRow {
    id: i64,
    prompt_id: i64,
    title: String,
    description: Option<String>,
    emoji_name: Option<String>,
    emoji_id: Option<i64>,
    channel_ids: Vec<i64>,
    role_ids: Vec<i64>,
}

#[derive(FromRow)]
struct ConfigRow {
    enabled: bool,
    mode: i16,
    default_channel_ids: Vec<i64>,
    rules_description: Option<String>,
    rules: Option<String>,
}

/// Ids of the guild's text and voice channels, and of its roles other than @everyone.
/// Roles of the guild's bots (managed by their integration).
async fn managed_roles(state: &AppState, guild: i64) -> ApiResult<HashSet<i64>> {
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT role_id FROM guild_integrations WHERE guild_id = $1 AND role_id IS NOT NULL").bind(guild).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

async fn targets(state: &AppState, guild: i64) -> ApiResult<(HashSet<i64>, HashSet<i64>)> {
    let channels: Vec<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE guild_id = $1 AND kind IN (0, 2)").bind(guild).fetch_all(&state.db).await?;
    let roles: Vec<(i64,)> = sqlx::query_as("SELECT id FROM roles WHERE guild_id = $1 AND id <> $1").bind(guild).fetch_all(&state.db).await?;
    Ok((channels.into_iter().map(|(id,)| id).collect(), roles.into_iter().map(|(id,)| id).collect()))
}

/// The configuration as stored, with ids of deleted channels and roles dropped.
pub async fn load(state: &AppState, guild: i64) -> ApiResult<GuildOnboarding> {
    let config: Option<ConfigRow> =
        sqlx::query_as("SELECT enabled, mode, default_channel_ids, rules_description, rules FROM guild_onboarding WHERE guild_id = $1")
            .bind(guild)
            .fetch_optional(&state.db)
            .await?;
    let prompts: Vec<PromptRow> =
        sqlx::query_as("SELECT id, kind, title, single_select, required, in_onboarding FROM onboarding_prompts WHERE guild_id = $1 ORDER BY position, id")
            .bind(guild)
            .fetch_all(&state.db)
            .await?;
    let options: Vec<OptionRow> = sqlx::query_as(
        "SELECT o.id, o.prompt_id, o.title, o.description, o.emoji_name, o.emoji_id, o.channel_ids, o.role_ids FROM onboarding_options o \
         JOIN onboarding_prompts p ON p.id = o.prompt_id WHERE p.guild_id = $1 ORDER BY o.position, o.id",
    )
    .bind(guild)
    .fetch_all(&state.db)
    .await?;
    let (channels, roles) = targets(state, guild).await?;
    let mut by_prompt: HashMap<i64, Vec<OnboardingOption>> = HashMap::new();
    for row in options {
        let emoji = row.emoji_name.map(|name| ReactionEmoji { id: row.emoji_id.map(flake), name, animated: None });
        by_prompt.entry(row.prompt_id).or_default().push(OnboardingOption {
            id: flake(row.id),
            title: row.title,
            description: row.description,
            emoji,
            channel_ids: row.channel_ids.into_iter().filter(|id| channels.contains(id)).map(flake).collect(),
            role_ids: row.role_ids.into_iter().filter(|id| roles.contains(id)).map(flake).collect(),
        });
    }
    let prompts = prompts
        .into_iter()
        .map(|row| OnboardingPrompt {
            id: flake(row.id),
            kind: OnboardingPromptType::from_u8(row.kind as u8).unwrap_or(OnboardingPromptType::MultipleChoice),
            title: row.title,
            options: by_prompt.remove(&row.id).unwrap_or_default(),
            single_select: row.single_select,
            required: row.required,
            in_onboarding: row.in_onboarding,
        })
        .collect();
    let Some(config) = config else {
        return Ok(GuildOnboarding {
            guild_id: flake(guild),
            prompts,
            default_channel_ids: Vec::new(),
            enabled: false,
            mode: OnboardingMode::Default,
            rules: None,
            rules_pending: false,
        });
    };
    let items: Option<Vec<String>> = config.rules.as_deref().and_then(|raw| serde_json::from_str(raw).ok());
    Ok(GuildOnboarding {
        guild_id: flake(guild),
        prompts,
        default_channel_ids: config.default_channel_ids.into_iter().filter(|id| channels.contains(id)).map(flake).collect(),
        enabled: config.enabled,
        mode: OnboardingMode::from_u8(config.mode as u8).unwrap_or(OnboardingMode::Default),
        rules: items.filter(|items| !items.is_empty()).map(|items| OnboardingRules { description: config.rules_description, items }),
        rules_pending: false,
    })
}

async fn get_onboarding(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<GuildOnboarding>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let mut config = load(&state, guild).await?;
    config.rules_pending = crate::safety::rules_pending(&state, guild, user_id).await?;
    // Channels the member cannot view are not theirs to learn about; editors (MANAGE_GUILD) see the whole configuration.
    if access.permissions & MANAGE_GUILD == 0 {
        let mut ids: Vec<i64> = config.default_channel_ids.iter().map(|id| id.db()).collect();
        ids.extend(config.prompts.iter().flat_map(|prompt| prompt.options.iter().flat_map(|option| option.channel_ids.iter().map(|id| id.db()))));
        let viewable = access::viewable_channels(&state, user_id, &ids).await?;
        config.default_channel_ids.retain(|id| viewable.contains(&id.db()));
        for option in config.prompts.iter_mut().flat_map(|prompt| prompt.options.iter_mut()) {
            option.channel_ids.retain(|id| viewable.contains(&id.db()));
        }
    }
    Ok(Json(config))
}

fn text(value: &str, field: &str, max: usize) -> ApiResult<String> {
    let trimmed = value.trim().to_owned();
    if trimmed.is_empty() || trimmed.chars().count() > max {
        return Err(ApiErr::invalid(field, &format!("Must be between 1 and {max} in length.")));
    }
    Ok(trimmed)
}

fn dedupe(ids: &[Snowflake]) -> Vec<i64> {
    let mut seen = HashSet::new();
    ids.iter().map(|id| id.db()).filter(|id| seen.insert(*id)).collect()
}

struct ValidOption {
    id: i64,
    title: String,
    description: Option<String>,
    emoji: Option<(String, Option<i64>)>,
    channel_ids: Vec<i64>,
    role_ids: Vec<i64>,
}

struct ValidPrompt {
    id: i64,
    kind: OnboardingPromptType,
    title: String,
    single_select: bool,
    required: bool,
    in_onboarding: bool,
    options: Vec<ValidOption>,
}

struct Context<'a> {
    channels: &'a HashSet<i64>,
    roles: &'a HashSet<i64>,
    /// Roles the editor may hand out: below their highest role, everything for the owner.
    grantable: HashSet<i64>,
    /// Bot roles: never handed out by onboarding, not even when an option already listed one.
    managed: HashSet<i64>,
    /// existing option id -> (prompt id, roles it already grants)
    existing_options: &'a HashMap<i64, (i64, Vec<i64>)>,
}

fn option_input(state: &AppState, ctx: &Context<'_>, prompt: Option<i64>, index: usize, option: &OnboardingOptionInput) -> ApiResult<ValidOption> {
    let field = format!("prompts[{index}].options");
    let existing =
        option.id.map(Snowflake::db).and_then(|id| ctx.existing_options.get(&id).filter(|(owner, _)| Some(*owner) == prompt).map(|(_, roles)| (id, roles)));
    let id = existing.map_or_else(|| state.ids.next(), |(id, _)| id);
    let channel_ids = dedupe(&option.channel_ids);
    let role_ids = dedupe(&option.role_ids);
    if channel_ids.len() > MAX_TARGETS || role_ids.len() > MAX_TARGETS {
        return Err(ApiErr::invalid(&field, "Too many channels or roles."));
    }
    if channel_ids.iter().any(|id| !ctx.channels.contains(id)) {
        return Err(ApiErr::invalid(&field, "Unknown channel."));
    }
    for role in &role_ids {
        if !ctx.roles.contains(role) {
            return Err(ApiErr::invalid(&field, "Unknown role."));
        }
        if ctx.managed.contains(role) {
            return Err(ApiErr::invalid(&field, "A bot's role cannot be granted by onboarding."));
        }
        let kept = existing.is_some_and(|(_, roles)| roles.contains(role));
        if !kept && !ctx.grantable.contains(role) {
            return Err(ApiErr::missing_permissions());
        }
    }
    let emoji = match &option.emoji {
        Some(emoji) => {
            let name = emoji.name.trim().to_owned();
            if name.is_empty() || name.chars().count() > 64 {
                return Err(ApiErr::invalid(&field, "Invalid emoji."));
            }
            Some((name, emoji.id.map(Snowflake::db)))
        }
        None => None,
    };
    Ok(ValidOption {
        id,
        title: text(&option.title, &format!("{field}.title"), 50)?,
        description: clean_text(option.description.clone(), 100, &format!("{field}.description"))?,
        emoji,
        channel_ids,
        role_ids,
    })
}

fn prompt_input(state: &AppState, ctx: &Context<'_>, existing_prompts: &HashSet<i64>, index: usize, prompt: &OnboardingPromptInput) -> ApiResult<ValidPrompt> {
    let field = format!("prompts[{index}]");
    if prompt.options.is_empty() || prompt.options.len() > MAX_OPTIONS {
        return Err(ApiErr::invalid(&format!("{field}.options"), "Needs between 1 and 50 options."));
    }
    let kept = prompt.id.map(Snowflake::db).filter(|id| existing_prompts.contains(id));
    let id = kept.unwrap_or_else(|| state.ids.next());
    let mut options = Vec::with_capacity(prompt.options.len());
    let mut used = HashSet::new();
    for option in &prompt.options {
        let valid = option_input(state, ctx, kept, index, option)?;
        if !used.insert(valid.id) {
            return Err(ApiErr::invalid(&format!("{field}.options"), "Duplicate option."));
        }
        options.push(valid);
    }
    Ok(ValidPrompt {
        id,
        kind: prompt.kind,
        title: text(&prompt.title, &format!("{field}.title"), 100)?,
        single_select: prompt.single_select.unwrap_or(false),
        required: prompt.required.unwrap_or(false),
        in_onboarding: prompt.in_onboarding.unwrap_or(true),
        options,
    })
}

async fn put_onboarding(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditOnboardingRequest>,
) -> ApiResult<Json<GuildOnboarding>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    access.require(MANAGE_GUILD | MANAGE_ROLES)?;
    let (channels, roles) = targets(&state, guild).await?;
    let role_rows: Vec<(i64, i32)> = sqlx::query_as("SELECT id, position FROM roles WHERE guild_id = $1 AND id <> $1").bind(guild).fetch_all(&state.db).await?;
    let actor_ranks: Vec<RoleRank> =
        role_rows.iter().filter(|(id, _)| access.roles.contains(id)).map(|(id, position)| RoleRank { id: *id, position: *position, everyone: false }).collect();
    let top = highest_role(&actor_ranks);
    let grantable: HashSet<i64> = role_rows
        .iter()
        .filter(|(id, position)| {
            access.owner_id == user_id
                || top.is_some_and(|top| compare_roles(&top, &RoleRank { id: *id, position: *position, everyone: false }) == std::cmp::Ordering::Greater)
        })
        .map(|(id, _)| *id)
        .collect();
    let current = load(&state, guild).await?;
    // Raw stored options (including ids of roles that are gone) tell which grants the editor merely kept.
    let stored: Vec<(i64, i64, Vec<i64>)> =
        sqlx::query_as("SELECT o.id, o.prompt_id, o.role_ids FROM onboarding_options o JOIN onboarding_prompts p ON p.id = o.prompt_id WHERE p.guild_id = $1")
            .bind(guild)
            .fetch_all(&state.db)
            .await?;
    let existing_options: HashMap<i64, (i64, Vec<i64>)> = stored.into_iter().map(|(id, prompt, roles)| (id, (prompt, roles))).collect();
    let existing_prompts: HashSet<i64> = current.prompts.iter().map(|prompt| prompt.id.db()).collect();
    let managed = managed_roles(&state, guild).await?;
    let ctx = Context { channels: &channels, roles: &roles, grantable, managed, existing_options: &existing_options };

    let prompts = match &body.prompts {
        Some(inputs) => {
            if inputs.len() > MAX_PROMPTS {
                return Err(ApiErr::invalid("prompts", "At most 15 prompts."));
            }
            let mut valid = Vec::with_capacity(inputs.len());
            let mut used = HashSet::new();
            for (index, input) in inputs.iter().enumerate() {
                let prompt = prompt_input(&state, &ctx, &existing_prompts, index, input)?;
                if !used.insert(prompt.id) {
                    return Err(ApiErr::invalid("prompts", "Duplicate prompt."));
                }
                valid.push(prompt);
            }
            Some(valid)
        }
        None => None,
    };
    let default_channels = match &body.default_channel_ids {
        Some(ids) => {
            let ids = dedupe(ids);
            if ids.len() > MAX_DEFAULT_CHANNELS || ids.iter().any(|id| !channels.contains(id)) {
                return Err(ApiErr::invalid("default_channel_ids", "Up to 50 channels of this guild."));
            }
            ids
        }
        None => current.default_channel_ids.iter().map(|id| id.db()).collect(),
    };
    let (rules_description, rules) = match &body.rules {
        Some(Some(rules)) => {
            if rules.items.is_empty() || rules.items.len() > MAX_RULES {
                return Err(ApiErr::invalid("rules.items", "Needs between 1 and 16 rules."));
            }
            let items = rules.items.iter().map(|item| text(item, "rules.items", 300)).collect::<ApiResult<Vec<_>>>()?;
            (clean_text(rules.description.clone(), 300, "rules.description")?, serde_json::to_string(&items).ok())
        }
        Some(None) => (None, None),
        None => match &current.rules {
            Some(rules) => (rules.description.clone(), serde_json::to_string(&rules.items).ok()),
            None => (None, None),
        },
    };
    let enabled = body.enabled.unwrap_or(current.enabled);
    let mode = body.mode.unwrap_or(current.mode);

    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR UPDATE").bind(guild).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO guild_onboarding (guild_id, enabled, mode, default_channel_ids, rules_description, rules, rules_since) \
         VALUES ($1, $2, $3, $4, $5, $6::text, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END) \
         ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, mode = $3, default_channel_ids = $4, rules_description = $5, rules = $6::text, \
         rules_since = CASE WHEN $6::text IS NULL THEN NULL WHEN guild_onboarding.rules IS NULL THEN now() ELSE guild_onboarding.rules_since END",
    )
    .bind(guild)
    .bind(enabled)
    .bind(mode.as_u8() as i16)
    .bind(&default_channels)
    .bind(&rules_description)
    .bind(&rules)
    .execute(&mut *tx)
    .await?;
    if let Some(prompts) = &prompts {
        let kept_prompts: Vec<i64> = prompts.iter().map(|prompt| prompt.id).collect();
        let kept_options: Vec<i64> = prompts.iter().flat_map(|prompt| prompt.options.iter().map(|option| option.id)).collect();
        sqlx::query("DELETE FROM onboarding_prompts WHERE guild_id = $1 AND NOT (id = ANY($2))").bind(guild).bind(&kept_prompts).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM onboarding_options o USING onboarding_prompts p WHERE p.id = o.prompt_id AND p.guild_id = $1 AND NOT (o.id = ANY($2))")
            .bind(guild)
            .bind(&kept_options)
            .execute(&mut *tx)
            .await?;
        for (position, prompt) in prompts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO onboarding_prompts (id, guild_id, position, kind, title, single_select, required, in_onboarding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
                 ON CONFLICT (id) DO UPDATE SET position = $3, kind = $4, title = $5, single_select = $6, required = $7, in_onboarding = $8",
            )
            .bind(prompt.id)
            .bind(guild)
            .bind(position as i32)
            .bind(prompt.kind.as_u8() as i16)
            .bind(&prompt.title)
            .bind(prompt.single_select)
            .bind(prompt.required)
            .bind(prompt.in_onboarding)
            .execute(&mut *tx)
            .await?;
            for (slot, option) in prompt.options.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO onboarding_options (id, prompt_id, position, title, description, emoji_name, emoji_id, channel_ids, role_ids) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
                     ON CONFLICT (id) DO UPDATE SET position = $3, title = $4, description = $5, emoji_name = $6, emoji_id = $7, channel_ids = $8, role_ids = $9",
                )
                .bind(option.id)
                .bind(prompt.id)
                .bind(slot as i32)
                .bind(&option.title)
                .bind(&option.description)
                .bind(option.emoji.as_ref().map(|(name, _)| name))
                .bind(option.emoji.as_ref().and_then(|(_, id)| *id))
                .bind(&option.channel_ids)
                .bind(&option.role_ids)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(Json(load(&state, guild).await?))
}

async fn get_responses(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<OnboardingResponses>> {
    let guild = guild_id(&id)?;
    guild_access(&state, user_id, guild).await?;
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT option_id FROM member_onboarding_answers WHERE guild_id = $1 AND user_id = $2 ORDER BY option_id")
        .bind(guild)
        .bind(user_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(OnboardingResponses { option_ids: rows.into_iter().map(|(id,)| flake(id)).collect() }))
}

async fn put_responses(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OnboardingResponsesRequest>,
) -> ApiResult<Json<OnboardingCompletion>> {
    let guild = guild_id(&id)?;
    guild_access(&state, user_id, guild).await?;
    let config = load(&state, guild).await?;
    if !config.enabled {
        return Err(ApiErr::invalid("guild", "Onboarding is not enabled."));
    }
    let chosen = dedupe(&body.option_ids);
    let known: HashMap<i64, (i64, &OnboardingOption)> =
        config.prompts.iter().flat_map(|prompt| prompt.options.iter().map(move |option| (option.id.db(), (prompt.id.db(), option)))).collect();
    if chosen.iter().any(|id| !known.contains_key(id)) {
        return Err(ApiErr::invalid("option_ids", "Unknown option."));
    }
    for prompt in &config.prompts {
        let picked = prompt.options.iter().filter(|option| chosen.contains(&option.id.db())).count();
        if prompt.single_select && picked > 1 {
            return Err(ApiErr::invalid("option_ids", "That question takes one answer."));
        }
        if prompt.required && prompt.in_onboarding && picked == 0 {
            return Err(ApiErr::invalid("option_ids", "Answer every required question."));
        }
    }
    if config.rules.is_some() && body.rules_accepted != Some(true) {
        return Err(ApiErr::invalid("rules_accepted", "Accept the rules to continue."));
    }
    let managed = managed_roles(&state, guild).await?;
    let wanted: HashSet<i64> = chosen.iter().flat_map(|id| known[id].1.role_ids.iter().map(|role| role.db())).filter(|role| !managed.contains(role)).collect();

    let mut tx = state.db.begin().await?;
    let locked: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(guild)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if locked.is_none() {
        return Err(ApiErr::missing_access());
    }
    // What onboarding added earlier is taken back when no chosen option grants it any more; roles the member held already
    // (or got elsewhere) are never touched.
    let held: Vec<(i64,)> =
        sqlx::query_as("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).fetch_all(&mut *tx).await?;
    let held: HashSet<i64> = held.into_iter().map(|(role,)| role).collect();
    let earlier: Vec<(i64,)> = sqlx::query_as("SELECT role_id FROM member_onboarding_roles WHERE guild_id = $1 AND user_id = $2")
        .bind(guild)
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
    let earlier: HashSet<i64> = earlier.into_iter().map(|(role,)| role).collect();
    let to_remove: Vec<i64> = earlier.iter().copied().filter(|role| !wanted.contains(role)).collect();
    let to_add: Vec<i64> = wanted.iter().copied().filter(|role| !held.contains(role)).collect();
    // The channels the member sees before the role change, so the ones it opens or closes reach them.
    let visible_before = access::visible_guild_channels(&state, user_id, guild).await?;
    if !to_remove.is_empty() {
        sqlx::query("DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3)")
            .bind(guild)
            .bind(user_id)
            .bind(&to_remove)
            .execute(&mut *tx)
            .await?;
    }
    for role in &to_add {
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(guild)
            .bind(user_id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
    }
    let recorded: Vec<i64> = earlier.iter().copied().filter(|role| wanted.contains(role)).chain(to_add.iter().copied()).collect();
    sqlx::query("DELETE FROM member_onboarding_roles WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).execute(&mut *tx).await?;
    for role in &recorded {
        sqlx::query("INSERT INTO member_onboarding_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(guild)
            .bind(user_id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM member_onboarding_answers WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).execute(&mut *tx).await?;
    for option in &chosen {
        sqlx::query("INSERT INTO member_onboarding_answers (guild_id, user_id, option_id) VALUES ($1, $2, $3)")
            .bind(guild)
            .bind(user_id)
            .bind(option)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE guild_members SET flags = flags | $3 WHERE guild_id = $1 AND user_id = $2")
        .bind(guild)
        .bind(user_id)
        .bind(COMPLETED_ONBOARDING as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    overwrites::dispatch_member_visibility(&state, user_id, guild, &visible_before).await?;
    let member = store::member(&state, guild, user_id).await?.ok_or_else(ApiErr::internal)?;
    let members = access::guild_member_ids(&state, guild).await?;
    state.hub.send(&members, &GatewayEvent::GuildMemberUpdate(GuildMemberAdd { member: member.clone(), guild_id: flake(guild) }));

    // Default mode lands the member in the default channels only; Advanced adds the channels of the chosen options.
    let from_answers: Vec<i64> = if config.mode == OnboardingMode::Advanced {
        chosen.iter().flat_map(|id| known[id].1.channel_ids.iter().map(|channel| channel.db())).collect()
    } else {
        Vec::new()
    };
    let mut wanted: Vec<i64> = Vec::new();
    for channel in config.default_channel_ids.iter().map(|id| id.db()).chain(from_answers) {
        if !wanted.contains(&channel) {
            wanted.push(channel);
        }
    }
    let viewable = access::viewable_channels(&state, user_id, &wanted).await?;
    let channel_ids = wanted.into_iter().filter(|id| viewable.contains(id)).map(flake).collect();
    Ok(Json(OnboardingCompletion { member, channel_ids }))
}
