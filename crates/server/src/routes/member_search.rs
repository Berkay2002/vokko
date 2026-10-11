//! Members page: `POST /guilds/{id}/members-search` (Discord's member-safety search, see docs/api.md).
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::post;
use sqlx::{Postgres, QueryBuilder};
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{ADMINISTRATOR, BAN_MEMBERS, KICK_MEMBERS, MANAGE_GUILD, MANAGE_NICKNAMES, MANAGE_ROLES, MODERATE_MEMBERS};
use vokko_protocol::api::{MemberSearchQuery, MemberSearchRequest, MemberSearchResponse, RangeQuery, Snowflake, SupplementalGuildMember, member_search_sort};

use crate::access::guild_access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::ids::EPOCH_MS;
use crate::state::AppState;
use crate::store;

/// Discord's member-safety access check: holding any of these opens the members page.
pub const MEMBERS_PAGE_PERMISSIONS: u64 = ADMINISTRATOR | MANAGE_GUILD | KICK_MEMBERS | BAN_MEMBERS | MODERATE_MEMBERS | MANAGE_ROLES | MANAGE_NICKNAMES;

const DEFAULT_LIMIT: u32 = 25;
const MAX_LIMIT: u32 = 1000;
const MAX_OFFSET: u32 = 100_000;
const MAX_LIST: usize = 100;
const MAX_USERNAME_TERMS: usize = 10;
const MAX_TERM_CHARS: usize = 100;

pub fn routes() -> Router<AppState> {
    Router::new().route("/guilds/{id}/members-search", post(search_members))
}

/// The validated filters, ready to bind.
#[derive(Debug, Default)]
struct Filters {
    user_ids: Vec<i64>,
    /// Lower-cased prefixes, each with the user id it names when it is all digits.
    terms: Vec<(String, Option<i64>)>,
    any_roles: Vec<i64>,
    all_roles: Vec<i64>,
    joined_from: Option<OffsetDateTime>,
    joined_to: Option<OffsetDateTime>,
    /// Inclusive snowflake bounds for the account creation range.
    created_from: Option<i64>,
    created_to: Option<i64>,
    invite_codes: Vec<String>,
    join_sources: Vec<i16>,
}

fn list<T>(values: &[T], field: &str) -> ApiResult<()> {
    if values.len() > MAX_LIST { Err(ApiErr::invalid(field, "Must be 100 or fewer in length.")) } else { Ok(()) }
}

fn ids(values: &[Snowflake], field: &str) -> ApiResult<Vec<i64>> {
    list(values, field)?;
    Ok(values.iter().map(|id| id.db()).collect())
}

fn instant(ms: i64, field: &str) -> ApiResult<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).map_err(|_| ApiErr::invalid(field, "Not a valid timestamp."))
}

/// First snowflake of the millisecond `ms` (ids before the epoch clamp to 0).
fn snowflake_floor(ms: i64) -> i64 {
    let since = ms.saturating_sub(EPOCH_MS as i64).clamp(0, (i64::MAX >> 22) - 1);
    since << 22
}

fn range(query: &Option<RangeQuery>) -> Option<(Option<i64>, Option<i64>)> {
    query.as_ref().map(|query| (query.range.gte, query.range.lte))
}

impl Filters {
    fn parse(query: &MemberSearchQuery) -> ApiResult<Self> {
        let mut filters = Self::default();
        if let Some(user_id) = &query.user_id {
            filters.user_ids = ids(&user_id.or_query, "and_query.user_id")?;
        }
        if let Some(usernames) = &query.usernames {
            if usernames.or_query.len() > MAX_USERNAME_TERMS {
                return Err(ApiErr::invalid("and_query.usernames", "Must be 10 or fewer in length."));
            }
            for raw in &usernames.or_query {
                let term = raw.trim();
                if term.is_empty() || term.chars().count() > MAX_TERM_CHARS {
                    return Err(ApiErr::invalid("and_query.usernames", "Must be between 1 and 100 in length."));
                }
                let id = if term.bytes().all(|byte| byte.is_ascii_digit()) { parse_id(term) } else { None };
                filters.terms.push((term.to_owned(), id));
            }
        }
        if let Some(roles) = &query.role_ids {
            if let Some(any) = &roles.or_query {
                filters.any_roles = ids(any, "and_query.role_ids")?;
            }
            if let Some(all) = &roles.and_query {
                filters.all_roles = ids(all, "and_query.role_ids")?;
                filters.all_roles.sort_unstable();
                filters.all_roles.dedup();
            }
        }
        if let Some((gte, lte)) = range(&query.guild_joined_at) {
            filters.joined_from = gte.map(|ms| instant(ms, "and_query.guild_joined_at")).transpose()?;
            filters.joined_to = lte.map(|ms| instant(ms, "and_query.guild_joined_at")).transpose()?;
        }
        if let Some((gte, lte)) = range(&query.user_created_at) {
            filters.created_from = gte.map(snowflake_floor);
            filters.created_to = lte.map(|ms| snowflake_floor(ms.saturating_add(1)) - 1);
        }
        if let Some(codes) = &query.source_invite_code {
            list(&codes.or_query, "and_query.source_invite_code")?;
            if codes.or_query.iter().any(|code| code.is_empty() || code.chars().count() > MAX_TERM_CHARS) {
                return Err(ApiErr::invalid("and_query.source_invite_code", "Must be between 1 and 100 in length."));
            }
            filters.invite_codes = codes.or_query.clone();
        }
        if let Some(sources) = &query.join_source_type {
            list(&sources.or_query, "and_query.join_source_type")?;
            filters.join_sources = sources.or_query.iter().map(|value| i16::from(*value)).collect();
        }
        Ok(filters)
    }

    /// `FROM ... WHERE ...` shared by the page and the count.
    fn push_from_where<'a>(&'a self, builder: &mut QueryBuilder<'a, Postgres>, guild_id: i64) {
        builder.push(" FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ").push_bind(guild_id);
        if !self.user_ids.is_empty() {
            builder.push(" AND m.user_id = ANY(").push_bind(&self.user_ids).push(")");
        }
        if !self.terms.is_empty() {
            builder.push(" AND (");
            for (index, (term, id)) in self.terms.iter().enumerate() {
                if index > 0 {
                    builder.push(" OR ");
                }
                builder.push("starts_with(lower(u.username), lower(").push_bind(term);
                builder.push(")) OR starts_with(lower(COALESCE(u.global_name, '')), lower(").push_bind(term);
                builder.push(")) OR starts_with(lower(COALESCE(m.nick, '')), lower(").push_bind(term).push("))");
                if let Some(id) = id {
                    builder.push(" OR m.user_id = ").push_bind(*id);
                }
            }
            builder.push(")");
        }
        if !self.any_roles.is_empty() {
            builder
                .push(" AND EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id AND r.role_id = ANY(")
                .push_bind(&self.any_roles)
                .push("))");
        }
        if !self.all_roles.is_empty() {
            builder
                .push(" AND (SELECT count(*) FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id AND r.role_id = ANY(")
                .push_bind(&self.all_roles)
                .push(")) = ")
                .push_bind(self.all_roles.len() as i64);
        }
        if let Some(from) = self.joined_from {
            builder.push(" AND m.joined_at >= ").push_bind(from);
        }
        if let Some(to) = self.joined_to {
            builder.push(" AND m.joined_at <= ").push_bind(to);
        }
        if let Some(from) = self.created_from {
            builder.push(" AND m.user_id >= ").push_bind(from);
        }
        if let Some(to) = self.created_to {
            builder.push(" AND m.user_id <= ").push_bind(to);
        }
        if !self.invite_codes.is_empty() {
            builder.push(" AND m.source_invite_code = ANY(").push_bind(&self.invite_codes).push(")");
        }
        if !self.join_sources.is_empty() {
            builder.push(" AND m.join_source_type = ANY(").push_bind(&self.join_sources).push(")");
        }
    }
}

fn order_by(sort: u8) -> ApiResult<&'static str> {
    match sort {
        member_search_sort::MEMBER_SINCE_NEWEST_FIRST => Ok(" ORDER BY m.joined_at DESC, m.user_id DESC"),
        member_search_sort::MEMBER_SINCE_OLDEST_FIRST => Ok(" ORDER BY m.joined_at ASC, m.user_id ASC"),
        member_search_sort::JOINED_VOKKO_NEWEST_FIRST => Ok(" ORDER BY m.user_id DESC"),
        member_search_sort::JOINED_VOKKO_OLDEST_FIRST => Ok(" ORDER BY m.user_id ASC"),
        _ => Err(ApiErr::invalid("sort", "Value must be one of {1, 2, 3, 4}.")),
    }
}

async fn search_members(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<MemberSearchRequest>,
) -> ApiResult<Json<MemberSearchResponse>> {
    let guild_id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    let access = guild_access(&state, user_id, guild_id).await?;
    if access.permissions & MEMBERS_PAGE_PERMISSIONS == 0 {
        return Err(ApiErr::missing_permissions());
    }
    let limit = body.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 1000."));
    }
    let offset = body.offset.unwrap_or(0);
    if offset > MAX_OFFSET {
        return Err(ApiErr::invalid("offset", "Must be between 0 and 100000."));
    }
    let order = order_by(body.sort.unwrap_or(member_search_sort::MEMBER_SINCE_NEWEST_FIRST))?;
    let filters = Filters::parse(&body.and_query)?;

    let mut count = QueryBuilder::<Postgres>::new("SELECT count(*)");
    filters.push_from_where(&mut count, guild_id);
    let (total,): (i64,) = count.build_query_as().fetch_one(&state.db).await?;

    let mut page = QueryBuilder::<Postgres>::new("SELECT m.user_id, m.source_invite_code, m.inviter_id, m.join_source_type");
    filters.push_from_where(&mut page, guild_id);
    page.push(order).push(" LIMIT ").push_bind(i64::from(limit)).push(" OFFSET ").push_bind(i64::from(offset));
    let rows: Vec<(i64, Option<String>, Option<i64>, i16)> = page.build_query_as().fetch_all(&state.db).await?;

    let user_ids: Vec<i64> = rows.iter().map(|row| row.0).collect();
    let mut members = store::members_by_ids(&state, guild_id, &user_ids).await?;
    let members: Vec<SupplementalGuildMember> = rows
        .into_iter()
        .filter_map(|(id, source_invite_code, inviter_id, join_source_type)| {
            members.remove(&id).map(|member| SupplementalGuildMember {
                member,
                source_invite_code,
                join_source_type: u8::try_from(join_source_type).unwrap_or(0),
                inviter_id: inviter_id.map(Snowflake::from),
            })
        })
        .collect();
    Ok(Json(MemberSearchResponse {
        guild_id: Snowflake::from(guild_id),
        page_result_count: members.len() as u32,
        total_result_count: total.clamp(0, i64::from(u32::MAX)) as u32,
        members,
    }))
}
