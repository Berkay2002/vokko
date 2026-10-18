//! Guild scheduled events: CRUD, status transitions, "Interested" and the GUILD_SCHEDULED_EVENT_* gateway events.
use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use serde::Deserialize;
use serde_json::json;
use sqlx::{FromRow, PgConnection};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::permissions::{CONNECT, CREATE_EVENTS, MANAGE_EVENTS};
use vokko_protocol::api::{
    ChannelType, CreateScheduledEventRequest, EditScheduledEventRequest, EventEntityMetadata, EventRecurrenceRule, GatewayEvent, GuildScheduledEvent,
    RecurrenceFrequency, ScheduledEventEntityType, ScheduledEventStatus, ScheduledEventUser, ScheduledEventUserEvent, Snowflake,
};

use crate::access::{self, GuildAccess, guild_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::users::{ImageKind, image_path_on};
use crate::state::AppState;
use crate::store::{self, iso};

/// Scheduled and active events per guild.
const MAX_OPEN_EVENTS: i64 = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/scheduled-events", get(list).post(create))
        .route("/guilds/{id}/scheduled-events/{eid}", get(get_one).patch(edit).delete(remove))
        .route("/guilds/{id}/scheduled-events/{eid}/users", get(interested))
        .route("/guilds/{id}/scheduled-events/{eid}/users/@me", put(show_interest).delete(withdraw_interest))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn event_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_scheduled_event)
}

fn flake(id: i64) -> Snowflake {
    Snowflake::from(id)
}

#[derive(FromRow, Clone)]
struct EventRow {
    id: i64,
    guild_id: i64,
    channel_id: Option<i64>,
    creator_id: Option<i64>,
    name: String,
    description: Option<String>,
    starts_at: OffsetDateTime,
    ends_at: Option<OffsetDateTime>,
    status: i16,
    entity_type: i16,
    location: Option<String>,
    image_path: Option<String>,
    recurrence: Option<String>,
    user_count: i64,
}

const EVENT_SELECT: &str = "SELECT e.id, e.guild_id, e.channel_id, e.creator_id, e.name, e.description, e.starts_at, e.ends_at, e.status, e.entity_type, \
     e.location, e.image_path, e.recurrence, (SELECT count(*) FROM scheduled_event_users u WHERE u.event_id = e.id) AS user_count FROM scheduled_events e";

impl EventRow {
    fn status(&self) -> ScheduledEventStatus {
        ScheduledEventStatus::from_u8(self.status as u8).unwrap_or(ScheduledEventStatus::Scheduled)
    }

    fn entity_type(&self) -> ScheduledEventEntityType {
        ScheduledEventEntityType::from_u8(self.entity_type as u8).unwrap_or(ScheduledEventEntityType::External)
    }

    fn rule(&self) -> Option<EventRecurrenceRule> {
        self.recurrence.as_deref().and_then(|raw| serde_json::from_str(raw).ok())
    }

    fn api(&self, state: &AppState, creator: Option<vokko_protocol::api::User>, rsvp: bool) -> GuildScheduledEvent {
        let external = self.entity_type() == ScheduledEventEntityType::External;
        GuildScheduledEvent {
            id: flake(self.id),
            guild_id: flake(self.guild_id),
            channel_id: self.channel_id.map(flake),
            creator_id: self.creator_id.map(flake),
            creator,
            name: self.name.clone(),
            description: self.description.clone(),
            scheduled_start_time: iso(self.starts_at),
            scheduled_end_time: self.ends_at.map(iso),
            privacy_level: 2,
            status: self.status(),
            entity_type: self.entity_type(),
            entity_id: None,
            entity_metadata: external.then(|| EventEntityMetadata { location: self.location.clone() }),
            user_count: self.user_count.max(0) as u32,
            user_rsvp: rsvp,
            image: self.image_path.as_ref().map(|path| state.asset_url(path)),
            recurrence_rule: self.rule(),
        }
    }
}

async fn load_row(state: &AppState, guild: i64, id: i64) -> ApiResult<EventRow> {
    let row: Option<EventRow> =
        sqlx::query_as(&format!("{EVENT_SELECT} WHERE e.id = $1 AND e.guild_id = $2")).bind(id).bind(guild).fetch_optional(&state.db).await?;
    row.ok_or_else(ApiErr::unknown_scheduled_event)
}

/// The events as `viewer` sees them (creator expanded, `user_rsvp` for the viewer).
async fn present(state: &AppState, rows: Vec<EventRow>, viewer: i64) -> ApiResult<Vec<GuildScheduledEvent>> {
    let creators: Vec<i64> = rows.iter().filter_map(|row| row.creator_id).collect();
    let users = store::users(state, &creators).await?;
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let mine: Vec<(i64,)> = sqlx::query_as("SELECT event_id FROM scheduled_event_users WHERE user_id = $1 AND event_id = ANY($2)")
        .bind(viewer)
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
    let mine: HashSet<i64> = mine.into_iter().map(|(id,)| id).collect();
    Ok(rows.iter().map(|row| row.api(state, row.creator_id.and_then(|id| users.get(&id).cloned()), mine.contains(&row.id))).collect())
}

/// Whether the event is shown to `user_id`, a guild member whose `access` is given. External events belong to the whole guild; an
/// event in a channel is shown to those who can view that channel; a voice event whose channel is gone only to its creator and
/// people with MANAGE_EVENTS (it would otherwise leak what a private channel hosted).
fn visible_without_channel(access: &GuildAccess, row: &EventRow, user_id: i64) -> bool {
    row.creator_id == Some(user_id) || access.permissions & MANAGE_EVENTS != 0
}

async fn can_see(state: &AppState, access: &GuildAccess, row: &EventRow, user_id: i64) -> ApiResult<bool> {
    if row.entity_type() == ScheduledEventEntityType::External {
        return Ok(true);
    }
    match row.channel_id {
        Some(channel) => Ok(access::viewable_channels(state, user_id, &[channel]).await?.contains(&channel)),
        None => Ok(visible_without_channel(access, row, user_id)),
    }
}

/// `load_row` for a caller who must be allowed to see the event: one that is hidden from them does not exist (10065).
async fn load_visible(state: &AppState, access: &GuildAccess, guild: i64, id: i64, user_id: i64) -> ApiResult<EventRow> {
    let row = load_row(state, guild, id).await?;
    if can_see(state, access, &row, user_id).await? { Ok(row) } else { Err(ApiErr::unknown_scheduled_event()) }
}

/// Everyone who may see the event (see `can_see`).
async fn viewers(state: &AppState, row: &EventRow) -> ApiResult<Vec<i64>> {
    if row.entity_type() == ScheduledEventEntityType::External {
        return access::guild_member_ids(state, row.guild_id).await;
    }
    if let Some(channel) = row.channel_id {
        return match store::channel_row(state, channel).await? {
            Some(channel) => access::channel_viewers(state, &channel).await,
            None => Ok(Vec::new()),
        };
    }
    let mut seen = access::members_with_permission(state, row.guild_id, MANAGE_EVENTS).await?;
    if let Some(creator) = row.creator_id
        && !seen.contains(&creator)
        && access::guild_member_ids(state, row.guild_id).await?.contains(&creator)
    {
        seen.push(creator);
    }
    Ok(seen)
}

/// Sends the event to `recipients`, `user_rsvp` filled per receiver.
async fn send_event(state: &AppState, row: &EventRow, recipients: &[i64], make: fn(Box<GuildScheduledEvent>) -> GatewayEvent) -> ApiResult<()> {
    let creator = match row.creator_id {
        Some(id) => store::user(state, id).await?,
        None => None,
    };
    let interested: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM scheduled_event_users WHERE event_id = $1").bind(row.id).fetch_all(&state.db).await?;
    let interested: HashSet<i64> = interested.into_iter().map(|(id,)| id).collect();
    let event = make(Box::new(row.api(state, creator, false)));
    let name = event.name();
    let data = event.data();
    state.hub.send_with(recipients, name, |user| {
        let mut data = data.clone();
        data["user_rsvp"] = json!(interested.contains(&user));
        data
    });
    Ok(())
}

/// Sends the event to the members who can see it.
async fn broadcast(state: &AppState, row: &EventRow, make: fn(Box<GuildScheduledEvent>) -> GatewayEvent) -> ApiResult<()> {
    let recipients = viewers(state, row).await?;
    send_event(state, row, &recipients, make).await
}

fn can_create(access: &GuildAccess) -> bool {
    access.permissions & (CREATE_EVENTS | MANAGE_EVENTS) != 0
}

/// MANAGE_EVENTS, or CREATE_EVENTS on an event the caller created.
fn can_manage(access: &GuildAccess, row: &EventRow, user_id: i64) -> bool {
    access.permissions & MANAGE_EVENTS != 0 || (access.permissions & CREATE_EVENTS != 0 && row.creator_id == Some(user_id))
}

fn parse_time(raw: &str, field: &str) -> ApiResult<OffsetDateTime> {
    OffsetDateTime::parse(raw.trim(), &Rfc3339).map_err(|_| ApiErr::invalid(field, "Must be an ISO 8601 timestamp."))
}

fn event_name(value: &str) -> ApiResult<String> {
    let name = value.trim().to_owned();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

fn location(value: &str) -> ApiResult<String> {
    let place = value.trim().to_owned();
    if !(1..=100).contains(&place.chars().count()) {
        return Err(ApiErr::invalid("entity_metadata.location", "Must be between 1 and 100 in length."));
    }
    Ok(place)
}

fn recurrence(rule: EventRecurrenceRule) -> ApiResult<EventRecurrenceRule> {
    let start = parse_time(&rule.start, "recurrence_rule.start")?;
    if let Some(end) = &rule.end
        && parse_time(end, "recurrence_rule.end")? <= start
    {
        return Err(ApiErr::invalid("recurrence_rule.end", "Must be after the start."));
    }
    if !(1..=12).contains(&rule.interval) {
        return Err(ApiErr::invalid("recurrence_rule.interval", "Must be between 1 and 12."));
    }
    if rule.count.is_some_and(|count| !(1..=1000).contains(&count)) {
        return Err(ApiErr::invalid("recurrence_rule.count", "Must be between 1 and 1000."));
    }
    let mut rule = rule;
    if let Some(days) = rule.by_weekday.as_mut() {
        if rule.frequency != RecurrenceFrequency::Weekly {
            return Err(ApiErr::invalid("recurrence_rule.by_weekday", "Only weekly rules take weekdays."));
        }
        days.sort_unstable();
        days.dedup();
        if days.is_empty() || days.iter().any(|day| *day > 6) {
            return Err(ApiErr::invalid("recurrence_rule.by_weekday", "Use 0 (Monday) to 6 (Sunday)."));
        }
    }
    Ok(rule)
}

/// The values an event ends up with after create or edit, validated together.
struct Fields {
    name: String,
    description: Option<String>,
    entity_type: ScheduledEventEntityType,
    channel_id: Option<i64>,
    location: Option<String>,
    starts_at: OffsetDateTime,
    ends_at: Option<OffsetDateTime>,
    recurrence: Option<EventRecurrenceRule>,
}

impl Fields {
    /// Cross-field rules; `channel_changed` re-checks the caller's access to the voice channel.
    async fn validate(&self, state: &AppState, user_id: i64, guild: i64, check_channel: bool, require_channel: bool) -> ApiResult<()> {
        match self.entity_type {
            ScheduledEventEntityType::External => {
                if self.channel_id.is_some() {
                    return Err(ApiErr::invalid("channel_id", "External events have no channel."));
                }
                if self.location.is_none() {
                    return Err(ApiErr::invalid("entity_metadata.location", "External events need a location."));
                }
                if self.ends_at.is_none() {
                    return Err(ApiErr::invalid("scheduled_end_time", "External events need an end time."));
                }
            }
            ScheduledEventEntityType::Voice | ScheduledEventEntityType::StageInstance => {
                match self.channel_id {
                    Some(channel) if check_channel => {
                        let access = access::channel_access(state, user_id, channel).await.map_err(|_| ApiErr::invalid("channel_id", "Unknown channel."))?;
                        // Stage events happen in a stage channel, voice events in a voice channel (as in Discord).
                        let (wanted, message) = match self.entity_type {
                            ScheduledEventEntityType::StageInstance => (ChannelType::GuildStage, "Must be a stage channel of this guild."),
                            _ => (ChannelType::GuildVoice, "Must be a voice channel of this guild."),
                        };
                        if access.channel.guild_id != Some(guild) || access.channel.channel_type() != wanted {
                            return Err(ApiErr::invalid("channel_id", message));
                        }
                        access.require(CONNECT)?;
                    }
                    Some(_) => {}
                    // An event whose channel was deleted can still be edited; only picking or changing the entity needs one.
                    None if require_channel => return Err(ApiErr::invalid("channel_id", "Voice events need a voice channel.")),
                    None => {}
                }
            }
        }
        if self.ends_at.is_some_and(|end| end <= self.starts_at) {
            return Err(ApiErr::invalid("scheduled_end_time", "Must be after the start."));
        }
        Ok(())
    }
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GuildScheduledEvent>>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let rows: Vec<EventRow> = sqlx::query_as(&format!("{EVENT_SELECT} WHERE e.guild_id = $1 AND e.status IN (1, 2) ORDER BY e.starts_at, e.id"))
        .bind(guild)
        .fetch_all(&state.db)
        .await?;
    // Events in channels the caller cannot view are not theirs to see.
    let channels: Vec<i64> = rows.iter().filter_map(|row| row.channel_id).collect();
    let viewable = access::viewable_channels(&state, user_id, &channels).await?;
    let rows = rows
        .into_iter()
        .filter(|row| match row.channel_id {
            _ if row.entity_type() == ScheduledEventEntityType::External => true,
            Some(channel) => viewable.contains(&channel),
            None => visible_without_channel(&access, row, user_id),
        })
        .collect();
    Ok(Json(present(&state, rows, user_id).await?))
}

async fn get_one(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, eid)): Path<(String, String)>) -> ApiResult<Json<GuildScheduledEvent>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let row = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?;
    present(&state, vec![row], user_id).await?.pop().map(Json).ok_or_else(ApiErr::internal)
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateScheduledEventRequest>,
) -> ApiResult<Json<GuildScheduledEvent>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    if !can_create(&access) {
        return Err(ApiErr::missing_permissions());
    }
    if body.privacy_level.is_some_and(|level| level != 2) {
        return Err(ApiErr::invalid("privacy_level", "Only 2 (guild only) is supported."));
    }
    let starts_at = parse_time(&body.scheduled_start_time, "scheduled_start_time")?;
    if starts_at <= OffsetDateTime::now_utc() {
        return Err(ApiErr::invalid("scheduled_start_time", "Must be in the future."));
    }
    let external = body.entity_type == ScheduledEventEntityType::External;
    let fields = Fields {
        name: event_name(&body.name)?,
        description: clean_text(body.description, 1000, "description")?,
        entity_type: body.entity_type,
        channel_id: body.channel_id.map(Snowflake::db),
        location: match body.entity_metadata.and_then(|meta| meta.location) {
            Some(place) if external => Some(location(&place)?),
            _ => None,
        },
        starts_at,
        ends_at: body.scheduled_end_time.as_deref().map(|raw| parse_time(raw, "scheduled_end_time")).transpose()?,
        recurrence: body.recurrence_rule.map(recurrence).transpose()?,
    };
    fields.validate(&state, user_id, guild, true, true).await?;
    // The guild row lock makes count-then-insert atomic: two creates cannot both take the last slot. It is a NO KEY lock, so channel,
    // role and member inserts (which only share the key) go on.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR NO KEY UPDATE").bind(guild).execute(&mut *tx).await?;
    let (open,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM scheduled_events WHERE guild_id = $1 AND status IN (1, 2)").bind(guild).fetch_one(&mut *tx).await?;
    if open >= MAX_OPEN_EVENTS {
        return Err(ApiErr::conflict(30038, "Maximum number of scheduled events reached"));
    }
    let image_path = match body.image_attachment_id {
        Some(attachment) => Some(claim_cover(&mut tx, attachment.db(), user_id).await?),
        None => None,
    };
    let event = state.ids.next();
    sqlx::query(
        "INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, description, starts_at, ends_at, entity_type, location, image_path, recurrence) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(event)
    .bind(guild)
    .bind(fields.channel_id)
    .bind(user_id)
    .bind(&fields.name)
    .bind(&fields.description)
    .bind(fields.starts_at)
    .bind(fields.ends_at)
    .bind(fields.entity_type.as_u8() as i16)
    .bind(&fields.location)
    .bind(&image_path)
    .bind(fields.recurrence.as_ref().and_then(|rule| serde_json::to_string(rule).ok()))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let row = load_row(&state, guild, event).await?;
    broadcast(&state, &row, GatewayEvent::GuildScheduledEventCreate).await?;
    present(&state, vec![row], user_id).await?.pop().map(Json).ok_or_else(ApiErr::internal)
}

/// Allowed status changes: Scheduled → Active | Canceled, Active → Completed.
fn transition_allowed(from: ScheduledEventStatus, to: ScheduledEventStatus) -> bool {
    matches!(
        (from, to),
        (ScheduledEventStatus::Scheduled, ScheduledEventStatus::Active | ScheduledEventStatus::Canceled)
            | (ScheduledEventStatus::Active, ScheduledEventStatus::Completed)
    )
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, eid)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditScheduledEventRequest>,
) -> ApiResult<Json<GuildScheduledEvent>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let row = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?;
    if !can_manage(&access, &row, user_id) {
        return Err(ApiErr::missing_permissions());
    }
    let current = row.status();
    if matches!(current, ScheduledEventStatus::Completed | ScheduledEventStatus::Canceled) {
        return Err(ApiErr::finished_event());
    }
    let new_status = match body.status {
        Some(status) if status != current => {
            if !transition_allowed(current, status) {
                return Err(ApiErr::invalid("status", "That status change is not allowed."));
            }
            Some(status)
        }
        _ => None,
    };
    // A status change counts as acting on the channel: whoever starts, ends or cancels must still be able to join it. A voice
    // event whose channel is gone cannot be started.
    if let Some(status) = new_status
        && row.entity_type() != ScheduledEventEntityType::External
    {
        match row.channel_id {
            Some(channel) => access::channel_access(&state, user_id, channel).await?.require(CONNECT)?,
            None if status == ScheduledEventStatus::Active => return Err(ApiErr::invalid("channel_id", "Pick a voice channel before starting this event.")),
            None => {}
        }
    }
    // Once started only the descriptive parts and the end time change.
    if current == ScheduledEventStatus::Active {
        let locked = [
            ("entity_type", body.entity_type.is_some()),
            ("channel_id", body.channel_id.is_some()),
            ("entity_metadata", body.entity_metadata.is_some()),
            ("scheduled_start_time", body.scheduled_start_time.is_some()),
            ("recurrence_rule", body.recurrence_rule.is_some()),
        ];
        if let Some((field, _)) = locked.iter().find(|(_, set)| *set) {
            return Err(ApiErr::invalid(field, "Cannot change this once the event started."));
        }
    }
    let entity_type = body.entity_type.unwrap_or_else(|| row.entity_type());
    let external = entity_type == ScheduledEventEntityType::External;
    let channel_id = match body.channel_id {
        Some(value) => value.map(Snowflake::db),
        None if external => None,
        None => row.channel_id,
    };
    let place = match &body.entity_metadata {
        Some(meta) => meta.as_ref().and_then(|meta| meta.location.clone()).map(|place| location(&place)).transpose()?,
        None => row.location.clone(),
    };
    let starts_at = match &body.scheduled_start_time {
        Some(raw) => {
            let at = parse_time(raw, "scheduled_start_time")?;
            if at != row.starts_at && at <= OffsetDateTime::now_utc() {
                return Err(ApiErr::invalid("scheduled_start_time", "Must be in the future."));
            }
            at
        }
        None => row.starts_at,
    };
    if new_status == Some(ScheduledEventStatus::Active) && starts_at != row.starts_at {
        return Err(ApiErr::invalid("scheduled_start_time", "Start the event or move it, not both at once."));
    }
    let fields = Fields {
        name: match &body.name {
            Some(name) => event_name(name)?,
            None => row.name.clone(),
        },
        description: match body.description {
            Some(value) => clean_text(value, 1000, "description")?,
            None => row.description.clone(),
        },
        entity_type,
        channel_id,
        location: if external { place } else { None },
        starts_at,
        ends_at: match &body.scheduled_end_time {
            Some(value) => value.as_deref().map(|raw| parse_time(raw, "scheduled_end_time")).transpose()?,
            None => row.ends_at,
        },
        recurrence: match body.recurrence_rule {
            Some(value) => value.map(recurrence).transpose()?,
            None => row.rule(),
        },
    };
    let entity_touched = body.entity_type.is_some() || body.channel_id.is_some();
    fields.validate(&state, user_id, guild, entity_touched, entity_touched).await?;
    // The claim and the update commit together: a failing update leaves the upload unclaimed. The event row is locked first, so two
    // edits replacing the cover take turns and each releases the cover it actually replaced.
    let mut tx = state.db.begin().await?;
    let locked: Option<(Option<String>, i16)> =
        sqlx::query_as("SELECT image_path, status FROM scheduled_events WHERE id = $1 FOR UPDATE").bind(row.id).fetch_optional(&mut *tx).await?;
    let Some((current_cover, locked_status)) = locked else { return Err(ApiErr::unknown_scheduled_event()) };
    // Everything above was checked against the row as read before the lock. A status that moved in between (another manager started,
    // ended or canceled the event) makes those checks stale: the request fails and the caller retries on the new state.
    if locked_status != current.as_u8() as i16 {
        return Err(if locked_status >= ScheduledEventStatus::Completed.as_u8() as i16 {
            ApiErr::finished_event()
        } else {
            ApiErr::invalid("status", "The event changed while you were editing it. Reload it and try again.")
        });
    }
    let image_path = match body.image_attachment_id {
        // sending the current cover again changes nothing
        Some(Some(attachment)) if current_cover.as_deref().is_some_and(|path| cover_id(path) == Some(attachment.db())) => current_cover.clone(),
        Some(Some(attachment)) => Some(claim_cover(&mut tx, attachment.db(), user_id).await?),
        Some(None) => None,
        None => current_cover.clone(),
    };
    let before = viewers(&state, &row).await?;
    sqlx::query(
        "UPDATE scheduled_events SET channel_id = $2, name = $3, description = $4, starts_at = $5, ends_at = $6, entity_type = $7, location = $8, \
         image_path = $9, recurrence = $10, status = COALESCE($11, status) WHERE id = $1",
    )
    .bind(row.id)
    .bind(fields.channel_id)
    .bind(&fields.name)
    .bind(&fields.description)
    .bind(fields.starts_at)
    .bind(fields.ends_at)
    .bind(fields.entity_type.as_u8() as i16)
    .bind(&fields.location)
    .bind(&image_path)
    .bind(fields.recurrence.as_ref().and_then(|rule| serde_json::to_string(rule).ok()))
    .bind(new_status.map(|status| status.as_u8() as i16))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // A replaced or removed cover is not needed any more.
    if let Some(old) = current_cover.as_ref().filter(|old| Some(*old) != image_path.as_ref()) {
        release_covers(&state, std::slice::from_ref(old)).await;
    }
    let updated = load_row(&state, guild, row.id).await?;
    republish(&state, &row, &before, &updated).await?;
    present(&state, vec![updated], user_id).await?.pop().map(Json).ok_or_else(ApiErr::internal)
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, eid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let row = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?;
    if !can_manage(&access, &row, user_id) {
        return Err(ApiErr::missing_permissions());
    }
    // The gateway event carries the last state, so it is built before the rows disappear.
    let creator = match row.creator_id {
        Some(id) => store::user(&state, id).await?,
        None => None,
    };
    let members = viewers(&state, &row).await?;
    let interested: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM scheduled_event_users WHERE event_id = $1").bind(row.id).fetch_all(&state.db).await?;
    let interested: HashSet<i64> = interested.into_iter().map(|(id,)| id).collect();
    // The cover to release is the one the row had when it went, not the one read at the start (an edit may have replaced it since).
    let gone: Option<(Option<String>,)> =
        sqlx::query_as("DELETE FROM scheduled_events WHERE id = $1 RETURNING image_path").bind(row.id).fetch_optional(&state.db).await?;
    release_covers(&state, &gone.and_then(|(path,)| path).into_iter().collect::<Vec<_>>()).await;
    let event = GatewayEvent::GuildScheduledEventDelete(Box::new(row.api(&state, creator, false)));
    let data = event.data();
    state.hub.send_with(&members, event.name(), |user| {
        let mut data = data.clone();
        data["user_rsvp"] = json!(interested.contains(&user));
        data
    });
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UsersQuery {
    limit: Option<i64>,
    after: Option<Snowflake>,
    with_member: Option<bool>,
}

async fn interested(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, eid)): Path<(String, String)>,
    ApiQuery(query): ApiQuery<UsersQuery>,
) -> ApiResult<Json<Vec<ScheduledEventUser>>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let event = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?.id;
    let limit = query.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let ids: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM scheduled_event_users WHERE event_id = $1 AND user_id > $2 ORDER BY user_id LIMIT $3")
        .bind(event)
        .bind(query.after.map_or(0, Snowflake::db))
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    let ids: Vec<i64> = ids.into_iter().map(|(id,)| id).collect();
    let users = store::users(&state, &ids).await?;
    let mut members = if query.with_member == Some(true) { store::members_by_ids(&state, guild, &ids).await? } else { HashMap::new() };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(user) = users.get(&id).cloned() else { continue };
        out.push(ScheduledEventUser { guild_scheduled_event_id: flake(event), user, member: members.remove(&id) });
    }
    Ok(Json(out))
}

fn user_event(guild: i64, event: i64, user: i64) -> ScheduledEventUserEvent {
    ScheduledEventUserEvent { guild_scheduled_event_id: flake(event), user_id: flake(user), guild_id: flake(guild) }
}

async fn show_interest(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, eid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let row = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?;
    if matches!(row.status(), ScheduledEventStatus::Completed | ScheduledEventStatus::Canceled) {
        return Err(ApiErr::finished_event());
    }
    let inserted = sqlx::query("INSERT INTO scheduled_event_users (event_id, guild_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(row.id)
        .bind(guild)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    if inserted.rows_affected() > 0 {
        let members = viewers(&state, &row).await?;
        state.hub.send(&members, &GatewayEvent::GuildScheduledEventUserAdd(user_event(guild, row.id, user_id)));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn withdraw_interest(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, eid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    let row = load_visible(&state, &access, guild, event_id(&eid)?, user_id).await?;
    let removed = sqlx::query("DELETE FROM scheduled_event_users WHERE event_id = $1 AND user_id = $2").bind(row.id).bind(user_id).execute(&state.db).await?;
    if removed.rows_affected() > 0 {
        let members = viewers(&state, &row).await?;
        state.hub.send(&members, &GatewayEvent::GuildScheduledEventUserRemove(user_event(guild, row.id, user_id)));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// A cover belongs to its event alone (so it can be deleted with it): an upload that already serves as an avatar, icon or another
/// cover is refused.
/// Claimed inside the caller's transaction, so a failed write leaves nothing claimed that no event would ever clean up.
async fn claim_cover(conn: &mut PgConnection, attachment: i64, user_id: i64) -> ApiResult<String> {
    image_path_on(conn, attachment, user_id, ImageKind::Banner, "image_attachment_id", true).await
}

/// The upload id at the start of an asset path (`<id>/<key>/<filename>`).
fn cover_id(path: &str) -> Option<i64> {
    path.split('/').next()?.parse().ok()
}

/// Deletes the cover uploads behind asset paths (`<id>/<key>/<filename>`): rows and files. Covers are exclusive to their event.
pub async fn release_covers(state: &AppState, paths: &[String]) {
    let ids: Vec<i64> = paths.iter().filter_map(|path| cover_id(path)).collect();
    if ids.is_empty() {
        return;
    }
    let deleted: Result<Vec<(i64,)>, _> =
        sqlx::query_as("DELETE FROM attachments WHERE id = ANY($1) AND message_id IS NULL AND event_cover RETURNING id").bind(&ids).fetch_all(&state.db).await;
    match deleted {
        Ok(rows) => crate::media::remove_files(state, &rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await,
        Err(error) => tracing::warn!("releasing event covers failed: {error}"),
    }
}

/// The guild is about to be deleted: its events' covers may live in channels of other guilds or DMs.
pub async fn release_guild_covers(state: &AppState, guild: i64) {
    let paths: Result<Vec<(String,)>, _> =
        sqlx::query_as("SELECT image_path FROM scheduled_events WHERE guild_id = $1 AND image_path IS NOT NULL").bind(guild).fetch_all(&state.db).await;
    match paths {
        Ok(rows) => release_covers(state, &rows.into_iter().map(|(path,)| path).collect::<Vec<_>>()).await,
        Err(error) => tracing::warn!("listing event covers failed: {error}"),
    }
}

/// Called before a guild channel is deleted: events that pointed at it lose their `channel_id`. Members who could see them through the
/// channel (and are not their creator or an events manager) are told they are gone; the rest get the update.
pub async fn channel_removed(state: &AppState, channel_id: i64) -> ApiResult<()> {
    let ids: Vec<(i64, i64)> = sqlx::query_as("SELECT id, guild_id FROM scheduled_events WHERE channel_id = $1").bind(channel_id).fetch_all(&state.db).await?;
    let mut before = Vec::new();
    for (id, guild) in &ids {
        if let Ok(row) = load_row(state, *guild, *id).await {
            let seen = viewers(state, &row).await?;
            before.push((row, seen));
        }
    }
    sqlx::query("UPDATE scheduled_events SET channel_id = NULL WHERE channel_id = $1").bind(channel_id).execute(&state.db).await?;
    for (old, seen) in before {
        let Ok(row) = load_row(state, old.guild_id, old.id).await else { continue };
        republish(state, &old, &seen, &row).await?;
    }
    Ok(())
}

/// An event changed: those who saw it before (`before`) and no longer do are told it is gone, everyone who sees it now gets the update.
async fn republish(state: &AppState, old: &EventRow, before: &[i64], new: &EventRow) -> ApiResult<()> {
    let now = viewers(state, new).await?;
    let gone: Vec<i64> = before.iter().copied().filter(|user| !now.contains(user)).collect();
    if !gone.is_empty() {
        send_event(state, old, &gone, GatewayEvent::GuildScheduledEventDelete).await?;
    }
    send_event(state, new, &now, GatewayEvent::GuildScheduledEventUpdate).await
}
