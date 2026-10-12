//! Applications and their bots, the OAuth2-style "add to server" flow, guild integrations and application commands.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use vokko_protocol::api::permissions::MANAGE_GUILD;
use vokko_protocol::api::{
    Application, ApplicationCommand, ApplicationCommandIndex, ApplicationCommandRequest, ApplicationWithToken, AuthorizeGuild, BotTokenResponse,
    CreateApplicationRequest, EditApplicationRequest, GatewayEvent, GuildIntegration, GuildMemberAdd, GuildRoleEvent, IntegrationApplication,
    OAuth2AuthorizeInfo, OAuth2AuthorizeRequest, OAuth2AuthorizeResponse, PresenceStatus, Role, Snowflake,
};

use crate::access::{self, channel_access, guild_access};
use crate::apps::{
    self, APP_COLS, AppRow, COMMAND_COLS, CommandRow, CommandSpec, MAX_APPLICATIONS_PER_USER, app_api, app_row, command_limit, issue_bot_token,
    parse_permissions, validate_command,
};
use crate::auth::{AuthUser, HumanUser};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::presence;
use crate::routes::moderation::{MAX_ROLES, remove_member};
use crate::routes::users::{ImageKind, image_path_on, publish_user};
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/applications", get(list_applications).post(create_application))
        .route("/applications/{id}", get(get_application).patch(edit_application).delete(delete_application))
        .route("/applications/{id}/bot/reset", post(reset_token))
        .route("/oauth2/authorize", get(authorize_info).post(authorize))
        .route("/guilds/{id}/integrations", get(list_integrations))
        .route("/guilds/{id}/integrations/{app}", axum::routing::delete(delete_integration))
        .route("/applications/{id}/commands", get(list_global).put(overwrite_global).post(create_global))
        .route("/applications/{id}/commands/{cmd}", get(get_global).patch(edit_global).delete(delete_global))
        .route("/applications/{id}/guilds/{gid}/commands", get(list_guild).put(overwrite_guild).post(create_guild))
        .route("/applications/{id}/guilds/{gid}/commands/{cmd}", get(get_guild).patch(edit_guild).delete(delete_guild))
        .route("/channels/{id}/application-commands", get(command_index))
}

fn app_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_application)
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

/// The application, when `user_id` owns it (404 otherwise, so others cannot probe ids).
async fn owned_app(state: &AppState, user_id: i64, id: i64) -> ApiResult<AppRow> {
    app_row(state, id).await?.filter(|row| row.owner_id == user_id).ok_or_else(ApiErr::unknown_application)
}

fn app_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_owned();
    if !(2..=32).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 2 and 32 in length."));
    }
    Ok(name)
}

fn app_description(raw: &str) -> ApiResult<String> {
    let description = raw.trim().to_owned();
    if description.chars().count() > 400 {
        return Err(ApiErr::invalid("description", "Must be 400 or fewer in length."));
    }
    Ok(description)
}

async fn list_applications(State(state): State<AppState>, HumanUser(user_id): HumanUser) -> ApiResult<Json<Vec<Application>>> {
    let rows: Vec<AppRow> =
        sqlx::query_as(&format!("SELECT {APP_COLS} FROM applications WHERE owner_id = $1 ORDER BY id")).bind(user_id).fetch_all(&state.db).await?;
    let mut apps = Vec::with_capacity(rows.len());
    for row in &rows {
        apps.push(app_api(&state, row).await?);
    }
    Ok(Json(apps))
}

async fn create_application(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    ApiJson(body): ApiJson<CreateApplicationRequest>,
) -> ApiResult<Json<ApplicationWithToken>> {
    let name = app_name(&body.name)?;
    let description = app_description(body.description.as_deref().unwrap_or(""))?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM applications WHERE owner_id = $1").bind(user_id).fetch_one(&state.db).await?;
    if count >= MAX_APPLICATIONS_PER_USER {
        return Err(ApiErr::conflict(30035, "Maximum number of applications reached (25)"));
    }
    let id = state.ids.next();
    let username = apps::bot_username(&state, &name).await?;
    let mut tx = state.db.begin().await?;
    // No password: a bot cannot log in, only use its token.
    sqlx::query("INSERT INTO users (id, username, email, global_name, bot, password_hash) VALUES ($1, $2, $3, $4, TRUE, NULL)")
        .bind(id)
        .bind(&username)
        .bind(format!("{id}@bots.invalid"))
        .bind(&name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO presences (user_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(PresenceStatus::Offline.as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO applications (id, owner_id, name, description) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(user_id)
        .bind(&name)
        .bind(&description)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let token = issue_bot_token(&state, id).await?;
    let row = owned_app(&state, user_id, id).await?;
    Ok(Json(ApplicationWithToken { application: app_api(&state, &row).await?, token }))
}

async fn get_application(State(state): State<AppState>, HumanUser(user_id): HumanUser, Path(id): Path<String>) -> ApiResult<Json<Application>> {
    let row = owned_app(&state, user_id, app_id(&id)?).await?;
    Ok(Json(app_api(&state, &row).await?))
}

async fn edit_application(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditApplicationRequest>,
) -> ApiResult<Json<Application>> {
    let row = owned_app(&state, user_id, app_id(&id)?).await?;
    let name = body.name.as_deref().map(app_name).transpose()?;
    let description = body.description.as_deref().map(app_description).transpose()?;
    let permissions = body.install_params.as_ref().map(|params| parse_permissions(&params.permissions, "install_params.permissions")).transpose()?;
    // the claim and the write share one transaction: an account delete waits for both or sees neither
    let mut tx = state.db.begin().await?;
    let icon = match body.icon_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(attachment)) => Some(Some(image_path_on(&mut tx, attachment.db(), user_id, ImageKind::Avatar, "icon_attachment_id", false).await?)),
    };
    sqlx::query(
        "UPDATE applications SET name = COALESCE($2, name), description = COALESCE($3, description), bot_public = COALESCE($4, bot_public), \
         install_permissions = COALESCE($5, install_permissions), icon_path = CASE WHEN $6 THEN $7 ELSE icon_path END WHERE id = $1",
    )
    .bind(row.id)
    .bind(&name)
    .bind(&description)
    .bind(body.bot_public)
    .bind(permissions.map(|bits| bits as i64))
    .bind(icon.is_some())
    .bind(icon.clone().flatten())
    .execute(&mut *tx)
    .await?;
    // The bot user shows the application's name and icon.
    sqlx::query("UPDATE users SET global_name = COALESCE($2, global_name), avatar_path = CASE WHEN $3 THEN $4 ELSE avatar_path END WHERE id = $1")
        .bind(row.id)
        .bind(&name)
        .bind(icon.is_some())
        .bind(icon.clone().flatten())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if name.is_some() || icon.is_some() {
        publish_user(&state, row.id).await?;
    }
    let row = owned_app(&state, user_id, row.id).await?;
    Ok(Json(app_api(&state, &row).await?))
}

async fn delete_application(State(state): State<AppState>, HumanUser(user_id): HumanUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let row = owned_app(&state, user_id, app_id(&id)?).await?;
    let mut tx = state.db.begin().await?;
    let deleted = apps::delete_app(&mut tx, row.id).await?;
    tx.commit().await?;
    apps::announce_deleted_app(&state, deleted).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reset_token(State(state): State<AppState>, HumanUser(user_id): HumanUser, Path(id): Path<String>) -> ApiResult<Json<BotTokenResponse>> {
    let row = owned_app(&state, user_id, app_id(&id)?).await?;
    Ok(Json(BotTokenResponse { token: issue_bot_token(&state, row.id).await? }))
}

// ---- OAuth2-style authorize ----

#[derive(Deserialize)]
struct AuthorizeQuery {
    client_id: Snowflake,
    permissions: Option<String>,
}

/// The application behind `client_id`, as far as `user_id` may add it (private bots: the owner only).
async fn addable_app(state: &AppState, user_id: i64, client_id: Snowflake) -> ApiResult<AppRow> {
    app_row(state, client_id.db()).await?.filter(|row| row.bot_public || row.owner_id == user_id).ok_or_else(ApiErr::unknown_application)
}

async fn authorize_info(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    ApiQuery(query): ApiQuery<AuthorizeQuery>,
) -> ApiResult<Json<OAuth2AuthorizeInfo>> {
    let row = addable_app(&state, user_id, query.client_id).await?;
    let requested = match query.permissions.as_deref() {
        Some(raw) => parse_permissions(raw, "permissions")?,
        None => row.install_permissions as u64,
    };
    let candidates: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT g.id, g.name, g.icon_path FROM guilds g JOIN guild_members m ON m.guild_id = g.id AND m.user_id = $1 \
         WHERE NOT EXISTS (SELECT 1 FROM guild_members b WHERE b.guild_id = g.id AND b.user_id = $2) ORDER BY m.joined_at, g.id",
    )
    .bind(user_id)
    .bind(row.id)
    .fetch_all(&state.db)
    .await?;
    let mut guilds = Vec::new();
    for (id, name, icon) in candidates {
        let access = guild_access(&state, user_id, id).await?;
        if access.permissions & MANAGE_GUILD != 0 {
            guilds.push(AuthorizeGuild {
                id: Snowflake::from(id),
                name,
                icon: icon.map(|path| state.asset_url(&path)),
                permissions: access.permissions.to_string(),
            });
        }
    }
    let application = app_api(&state, &row).await?;
    Ok(Json(OAuth2AuthorizeInfo { bot: application.bot.clone(), application, permissions: requested.to_string(), guilds }))
}

async fn authorize(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    ApiQuery(query): ApiQuery<AuthorizeQuery>,
    ApiJson(body): ApiJson<OAuth2AuthorizeRequest>,
) -> ApiResult<Json<OAuth2AuthorizeResponse>> {
    let row = addable_app(&state, user_id, query.client_id).await?;
    let guild = body.guild_id.db();
    let access = guild_access(&state, user_id, guild).await?;
    access.require(MANAGE_GUILD)?;
    let requested = match body.permissions.as_deref().or(query.permissions.as_deref()) {
        Some(raw) => parse_permissions(raw, "permissions")?,
        None => row.install_permissions as u64,
    };
    // Nobody hands out more than they have.
    let granted = requested & access.permissions;
    let banned: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(row.id).fetch_optional(&state.db).await?;
    if banned.is_some() {
        return Err(ApiErr::banned());
    }
    let mut tx = state.db.begin().await?;
    let inserted =
        sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(guild).bind(row.id).execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiErr::invalid("guild_id", "The bot is already a member of this server."));
    }
    let role_id = (granted != 0).then(|| state.ids.next());
    if let Some(role_id) = role_id {
        let (roles,): (i64,) = sqlx::query_as("SELECT count(*) FROM roles WHERE guild_id = $1").bind(guild).fetch_one(&mut *tx).await?;
        if roles >= MAX_ROLES {
            return Err(ApiErr::conflict(30005, "Maximum number of guild roles reached (250)"));
        }
        let name: String = row.name.chars().take(100).collect();
        sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $2, $3, 1, $4)")
            .bind(role_id)
            .bind(guild)
            .bind(&name)
            .bind(granted as i64)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(guild)
            .bind(row.id)
            .bind(role_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT INTO guild_integrations (guild_id, application_id, added_by, role_id) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (guild_id, application_id) DO UPDATE SET added_by = EXCLUDED.added_by, role_id = EXCLUDED.role_id, created_at = now()",
    )
    .bind(guild)
    .bind(row.id)
    .bind(user_id)
    .bind(role_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let others: Vec<i64> = access::guild_member_ids(&state, guild).await?.into_iter().filter(|id| *id != row.id).collect();
    if let Some(role_id) = role_id
        && let Some(role) = store::guild(&state, guild).await?.and_then(|full| full.roles.into_iter().find(|role: &Role| role.id.db() == role_id))
    {
        state.hub.send(&others, &GatewayEvent::GuildRoleCreate(GuildRoleEvent { guild_id: Snowflake::from(guild), role }));
    }
    sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id) SELECT $1, id, last_message_id FROM channels WHERE guild_id = $2 AND kind IN (0, 2, 5) ON CONFLICT DO NOTHING")
        .bind(row.id)
        .bind(guild)
        .execute(&state.db)
        .await?;
    let mut full = events::guild_with_state(&state, guild, row.id).await?;
    full.presences = Some(presence::guild_presences(&state, guild, row.id).await?);
    state.hub.send(&[row.id], &GatewayEvent::GuildCreate(Box::new(full)));
    if let Some(member) = store::member(&state, guild, row.id).await? {
        state.hub.send(&others, &GatewayEvent::GuildMemberAdd(GuildMemberAdd { member, guild_id: Snowflake::from(guild) }));
    }
    presence::announce_join(&state, guild, row.id).await?;
    Ok(Json(OAuth2AuthorizeResponse { guild_id: body.guild_id, role_id: role_id.map(Snowflake::from) }))
}

// ---- integrations ----

async fn list_integrations(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GuildIntegration>>> {
    let guild = guild_id(&id)?;
    guild_access(&state, user_id, guild).await?.require(MANAGE_GUILD)?;
    let rows: Vec<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT i.application_id, i.added_by, i.role_id FROM guild_integrations i \
         JOIN guild_members m ON m.guild_id = i.guild_id AND m.user_id = i.application_id WHERE i.guild_id = $1 ORDER BY i.created_at",
    )
    .bind(guild)
    .fetch_all(&state.db)
    .await?;
    let mut integrations = Vec::with_capacity(rows.len());
    for (app, added_by, role_id) in rows {
        let Some(row) = app_row(&state, app).await? else { continue };
        let application = app_api(&state, &row).await?;
        let user = match added_by {
            Some(id) => store::user(&state, id).await?,
            None => None,
        };
        integrations.push(GuildIntegration {
            id: application.id,
            kind: "bot".to_owned(),
            name: application.name.clone(),
            enabled: true,
            application: IntegrationApplication {
                id: application.id,
                name: application.name,
                description: application.description,
                icon: application.icon,
                bot: application.bot,
            },
            user,
            role_id: role_id.map(Snowflake::from),
        });
    }
    Ok(Json(integrations))
}

async fn delete_integration(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, app)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let app = app_id(&app)?;
    guild_access(&state, user_id, guild).await?.require(MANAGE_GUILD)?;
    let member: Option<(i64,)> = sqlx::query_as("SELECT a.id FROM applications a JOIN guild_members m ON m.user_id = a.id AND m.guild_id = $1 WHERE a.id = $2")
        .bind(guild)
        .bind(app)
        .fetch_optional(&state.db)
        .await?;
    if member.is_none() {
        return Err(ApiErr::unknown_application());
    }
    remove_member(&state, guild, app).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- commands ----

/// The owner or the bot itself manages an application's commands. Guild commands also need the bot in that guild.
async fn command_scope(state: &AppState, user_id: i64, id: &str, guild: Option<&str>) -> ApiResult<(i64, Option<i64>)> {
    let app = app_row(state, app_id(id)?).await?.filter(|row| row.owner_id == user_id || row.id == user_id).ok_or_else(ApiErr::unknown_application)?;
    let guild = match guild {
        Some(raw) => {
            let guild = guild_id(raw)?;
            let member: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
                .bind(guild)
                .bind(app.id)
                .fetch_optional(&state.db)
                .await?;
            if member.is_none() {
                return Err(ApiErr::missing_access());
            }
            Some(guild)
        }
        None => None,
    };
    Ok((app.id, guild))
}

async fn scope_commands<'e>(db: impl sqlx::PgExecutor<'e>, app: i64, guild: Option<i64>) -> ApiResult<Vec<CommandRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COMMAND_COLS} FROM application_commands WHERE application_id = $1 AND COALESCE(guild_id, 0) = $2 ORDER BY kind, name, id"
    ))
    .bind(app)
    .bind(guild.unwrap_or(0))
    .fetch_all(db)
    .await?)
}

async fn scope_command(state: &AppState, app: i64, guild: Option<i64>, raw: &str) -> ApiResult<CommandRow> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_command)?;
    let row: Option<CommandRow> =
        sqlx::query_as(&format!("SELECT {COMMAND_COLS} FROM application_commands WHERE id = $1 AND application_id = $2 AND COALESCE(guild_id, 0) = $3"))
            .bind(id)
            .bind(app)
            .bind(guild.unwrap_or(0))
            .fetch_optional(&state.db)
            .await?;
    row.ok_or_else(ApiErr::unknown_command)
}

/// Inserts or replaces (same name and type) a command; true when it was new.
async fn upsert<'e>(
    state: &AppState,
    db: impl sqlx::PgExecutor<'e>,
    app: i64,
    guild: Option<i64>,
    spec: &CommandSpec,
    existing: Option<i64>,
) -> ApiResult<(CommandRow, bool)> {
    let options = serde_json::to_string(&spec.options).map_err(|_| ApiErr::internal())?;
    let version = state.ids.next();
    let id = existing.unwrap_or_else(|| state.ids.next());
    let row: CommandRow = sqlx::query_as(&format!(
        "INSERT INTO application_commands (id, application_id, guild_id, kind, name, description, options, default_member_permissions, dm_permission, version) \
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) \
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, options = EXCLUDED.options, \
         default_member_permissions = EXCLUDED.default_member_permissions, dm_permission = EXCLUDED.dm_permission, version = EXCLUDED.version \
         RETURNING {COMMAND_COLS}"
    ))
    .bind(id)
    .bind(app)
    .bind(guild)
    .bind(spec.kind.as_u8() as i16)
    .bind(&spec.name)
    .bind(&spec.description)
    .bind(options)
    .bind(spec.default_member_permissions.map(|bits| bits as i64))
    .bind(spec.dm_permission)
    .bind(version)
    .fetch_one(db)
    .await
    .map_err(|error| match &error {
        sqlx::Error::Database(database) if database.is_unique_violation() => ApiErr::invalid("name", "A command with this name and type already exists."),
        _ => ApiErr::from(error),
    })?;
    Ok((row, existing.is_none()))
}

/// Takes the application row lock that serialises writes to its commands.
async fn lock_commands(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, app: i64) -> ApiResult<()> {
    sqlx::query("SELECT id FROM applications WHERE id = $1 FOR UPDATE").bind(app).execute(&mut **tx).await?;
    Ok(())
}

fn check_limit(commands: &[CommandRow], spec: &CommandSpec, replacing: bool) -> ApiResult<()> {
    let same_kind = commands.iter().filter(|command| command.kind() == spec.kind).count();
    if !replacing && same_kind >= command_limit(spec.kind) {
        return Err(ApiErr::conflict(30032, "Maximum number of application commands reached"));
    }
    Ok(())
}

async fn list_commands(state: &AppState, user_id: i64, id: &str, guild: Option<&str>) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    let (app, guild) = command_scope(state, user_id, id, guild).await?;
    Ok(Json(scope_commands(&state.db, app, guild).await?.iter().map(CommandRow::api).collect()))
}

async fn create_command(state: &AppState, user_id: i64, id: &str, guild: Option<&str>, body: ApplicationCommandRequest) -> ApiResult<Response> {
    let (app, guild) = command_scope(state, user_id, id, guild).await?;
    let spec = validate_command(&body, None)?;
    // the application row lock serialises command writes: the limit check and the insert see the same set
    let mut tx = state.db.begin().await?;
    lock_commands(&mut tx, app).await?;
    let commands = scope_commands(&mut *tx, app, guild).await?;
    let existing = commands.iter().find(|command| command.kind() == spec.kind && command.name == spec.name).map(|command| command.id);
    check_limit(&commands, &spec, existing.is_some())?;
    let (row, created) = upsert(state, &mut *tx, app, guild, &spec, existing).await?;
    tx.commit().await?;
    Ok((if created { StatusCode::CREATED } else { StatusCode::OK }, Json(row.api())).into_response())
}

async fn overwrite_commands(
    state: &AppState,
    user_id: i64,
    id: &str,
    guild: Option<&str>,
    body: Vec<ApplicationCommandRequest>,
) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    let (app, guild) = command_scope(state, user_id, id, guild).await?;
    let specs = body.iter().map(|request| validate_command(request, None)).collect::<ApiResult<Vec<_>>>()?;
    let mut seen = std::collections::HashSet::new();
    for spec in &specs {
        if !seen.insert((spec.kind, spec.name.clone())) {
            return Err(ApiErr::invalid("name", "Command names must be unique per type."));
        }
    }
    for kind in [
        vokko_protocol::api::ApplicationCommandType::ChatInput,
        vokko_protocol::api::ApplicationCommandType::User,
        vokko_protocol::api::ApplicationCommandType::Message,
    ] {
        if specs.iter().filter(|spec| spec.kind == kind).count() > command_limit(kind) {
            return Err(ApiErr::conflict(30032, "Maximum number of application commands reached"));
        }
    }
    // all or nothing: a failure halfway leaves the previous set in place
    let mut tx = state.db.begin().await?;
    lock_commands(&mut tx, app).await?;
    let existing = scope_commands(&mut *tx, app, guild).await?;
    let kept: Vec<i64> = existing.iter().filter(|row| specs.iter().any(|spec| spec.kind == row.kind() && spec.name == row.name)).map(|row| row.id).collect();
    sqlx::query("DELETE FROM application_commands WHERE application_id = $1 AND COALESCE(guild_id, 0) = $2 AND NOT (id = ANY($3))")
        .bind(app)
        .bind(guild.unwrap_or(0))
        .bind(&kept)
        .execute(&mut *tx)
        .await?;
    let mut result = Vec::with_capacity(specs.len());
    for spec in &specs {
        let same = existing.iter().find(|row| row.kind() == spec.kind && row.name == spec.name);
        // an unchanged command keeps its version
        let row = match same {
            Some(row) if CommandSpec::from_row(row) == *spec => row.clone(),
            _ => upsert(state, &mut *tx, app, guild, spec, same.map(|row| row.id)).await?.0,
        };
        result.push(row.api());
    }
    tx.commit().await?;
    Ok(Json(result))
}

async fn edit_command(
    state: &AppState,
    user_id: i64,
    id: &str,
    guild: Option<&str>,
    cmd: &str,
    body: ApplicationCommandRequest,
) -> ApiResult<Json<ApplicationCommand>> {
    let (app, guild) = command_scope(state, user_id, id, guild).await?;
    let row = scope_command(state, app, guild, cmd).await?;
    let spec = validate_command(&body, Some(&CommandSpec::from_row(&row)))?;
    Ok(Json(upsert(state, &state.db, app, guild, &spec, Some(row.id)).await?.0.api()))
}

async fn delete_command(state: &AppState, user_id: i64, id: &str, guild: Option<&str>, cmd: &str) -> ApiResult<StatusCode> {
    let (app, guild) = command_scope(state, user_id, id, guild).await?;
    let row = scope_command(state, app, guild, cmd).await?;
    sqlx::query("DELETE FROM application_commands WHERE id = $1").bind(row.id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_global(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    list_commands(&state, user, &id, None).await
}

async fn create_global(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ApplicationCommandRequest>,
) -> ApiResult<Response> {
    create_command(&state, user, &id, None, body).await
}

async fn overwrite_global(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Vec<ApplicationCommandRequest>>,
) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    overwrite_commands(&state, user, &id, None, body).await
}

async fn get_global(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, cmd)): Path<(String, String)>) -> ApiResult<Json<ApplicationCommand>> {
    let (app, guild) = command_scope(&state, user, &id, None).await?;
    Ok(Json(scope_command(&state, app, guild, &cmd).await?.api()))
}

async fn edit_global(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, cmd)): Path<(String, String)>,
    ApiJson(body): ApiJson<ApplicationCommandRequest>,
) -> ApiResult<Json<ApplicationCommand>> {
    edit_command(&state, user, &id, None, &cmd, body).await
}

async fn delete_global(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, cmd)): Path<(String, String)>) -> ApiResult<StatusCode> {
    delete_command(&state, user, &id, None, &cmd).await
}

async fn list_guild(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, gid)): Path<(String, String)>,
) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    list_commands(&state, user, &id, Some(&gid)).await
}

async fn create_guild(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, gid)): Path<(String, String)>,
    ApiJson(body): ApiJson<ApplicationCommandRequest>,
) -> ApiResult<Response> {
    create_command(&state, user, &id, Some(&gid), body).await
}

async fn overwrite_guild(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, gid)): Path<(String, String)>,
    ApiJson(body): ApiJson<Vec<ApplicationCommandRequest>>,
) -> ApiResult<Json<Vec<ApplicationCommand>>> {
    overwrite_commands(&state, user, &id, Some(&gid), body).await
}

async fn get_guild(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, gid, cmd)): Path<(String, String, String)>,
) -> ApiResult<Json<ApplicationCommand>> {
    let (app, guild) = command_scope(&state, user, &id, Some(&gid)).await?;
    Ok(Json(scope_command(&state, app, guild, &cmd).await?.api()))
}

async fn edit_guild(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, gid, cmd)): Path<(String, String, String)>,
    ApiJson(body): ApiJson<ApplicationCommandRequest>,
) -> ApiResult<Json<ApplicationCommand>> {
    edit_command(&state, user, &id, Some(&gid), &cmd, body).await
}

async fn delete_guild(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, gid, cmd)): Path<(String, String, String)>) -> ApiResult<StatusCode> {
    delete_command(&state, user, &id, Some(&gid), &cmd).await
}

/// `GET /channels/{id}/application-commands`.
async fn command_index(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<ApplicationCommandIndex>> {
    let channel = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, channel).await?;
    let (apps, commands) = apps::usable_commands(&state, user_id, &access).await?;
    let used: std::collections::HashSet<i64> = commands.iter().map(|command| command.application_id).collect();
    Ok(Json(ApplicationCommandIndex {
        applications: apps.iter().filter(|app| used.contains(&app.id)).map(|app| apps::index_application(&state, app)).collect(),
        application_commands: commands.iter().map(CommandRow::api).collect(),
    }))
}
