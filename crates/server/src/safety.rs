//! Safety setup: the verification level gate on sending and AutoMod rules (CRUD routes and enforcement): custom keywords,
//! keyword presets (`assets/automod`), mention spam and a repeated-message spam heuristic.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex, PoisonError};
use std::time::Instant;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tokio::sync::{Mutex, OwnedMutexGuard};
use vokko_protocol::api::permissions::{ADMINISTRATOR, MANAGE_GUILD};
use vokko_protocol::api::{
    AuditEntryInfo, AuditLogEvent, AutoModerationAction, AutoModerationActionMetadata, AutoModerationActionType, AutoModerationEventType,
    AutoModerationKeywordPresetType, AutoModerationRule, AutoModerationRuleRequest, AutoModerationTriggerMetadata, AutoModerationTriggerType, ChannelType,
    Embed, EmbedField, EmbedType, GatewayEvent, MessageType, Snowflake, VerificationLevel,
};

use crate::access::{ChannelAccess, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::messages::{self, Draft, Extras, Resolved};
use crate::state::AppState;
use crate::store;

const MAX_KEYWORD_RULES: i64 = 6;
const MAX_KEYWORDS: usize = 1000;
const MAX_KEYWORD_CHARS: usize = 60;
const MAX_ALLOW_LIST: usize = 100;
const MAX_PRESET_ALLOW_LIST: usize = 1000;
const MAX_MENTION_LIMIT: u32 = 50;
const MAX_TIMEOUT_SECONDS: u32 = 2_419_200;
/// The spam heuristic (docs/api.md "AutoMod"): the third copy of one text within 30 seconds.
const SPAM_REPEATS: i64 = 3;
const SPAM_WINDOW_MS: u64 = 30_000;
const SPAM_MIN_CHARS: usize = 10;
/// One alert per rule and member in this window; the ones held back are counted in the next alert.
const ALERT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const ALERT_FORGET: std::time::Duration = std::time::Duration::from_secs(3600);
const MAX_EXEMPT_ROLES: usize = 20;
const MAX_EXEMPT_CHANNELS: usize = 50;
const MAX_CUSTOM_MESSAGE_CHARS: usize = 150;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/auto-moderation/rules", get(list_rules).post(create_rule))
        .route("/guilds/{id}/auto-moderation/rules/{rule_id}", get(get_rule).patch(update_rule).delete(delete_rule))
}

// ---- enforcement ----

/// Verification level, then AutoMod, for a new message by `user_id` in a guild channel; DMs pass. `screened` is everything AutoMod
/// reads (the content plus a poll's text), `plain` the content alone (what the spam check compares with stored messages).
/// Call it once the rest of the request is valid: a blocking rule runs its actions here and fails the send; otherwise run
/// [`Screening::act`] after the message is stored.
pub async fn check_send(state: &AppState, access: &ChannelAccess, user_id: i64, screened: &str, plain: &str) -> ApiResult<Screening> {
    let Some(guild_id) = access.channel.guild_id else { return Ok(Screening::default()) };
    check_verification(state, guild_id, user_id).await?;
    let screening = screen(state, access, user_id, screened, plain, false).await?;
    screening.block(state).await?;
    Ok(screening)
}

/// AutoMod for new content on an edit: like [`check_send`] without the verification level and the spam check.
pub async fn check_edit(state: &AppState, access: &ChannelAccess, user_id: i64, content: &str) -> ApiResult<Screening> {
    let screening = screen(state, access, user_id, content, content, true).await?;
    screening.block(state).await?;
    Ok(screening)
}

/// 403 50009 when the guild's verification level is above what the member meets. Roles, administrators and the owner bypass it.
async fn check_verification(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let row: Option<(i16, i64, OffsetDateTime, OffsetDateTime, bool, bool)> = sqlx::query_as(
        "SELECT g.verification_level, g.owner_id, u.created_at, m.joined_at, \
         EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id), u.email_verified \
         FROM guilds g JOIN guild_members m ON m.guild_id = g.id JOIN users u ON u.id = m.user_id WHERE g.id = $1 AND m.user_id = $2",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((level, owner_id, created_at, joined_at, has_roles, email_verified)) = row else { return Ok(()) };
    let level = VerificationLevel::from_u8(level as u8).unwrap_or_default();
    // An instance without SMTP only logs the verification mail: nobody could verify, so the email rule is off there.
    let email_ok = email_verified || !state.accounts.mailer.delivers();
    if owner_id == user_id || has_roles || meets_level(level, email_ok, created_at, joined_at, OffsetDateTime::now_utc()) {
        return Ok(());
    }
    if guild_access(state, user_id, guild_id).await?.permissions & ADMINISTRATOR != 0 {
        return Ok(());
    }
    Err(ApiErr::verification_level())
}

/// Discord's levels: Low needs a verified email (`email_ok`), Medium also a 5-minute-old account, High also 10 minutes of membership.
pub fn meets_level(level: VerificationLevel, email_ok: bool, created_at: OffsetDateTime, joined_at: OffsetDateTime, now: OffsetDateTime) -> bool {
    let account_ok = now - created_at >= Duration::minutes(5);
    let member_ok = now - joined_at >= Duration::minutes(10);
    match level {
        VerificationLevel::None => true,
        VerificationLevel::Low => email_ok,
        VerificationLevel::Medium => email_ok && account_ok,
        VerificationLevel::High | VerificationLevel::VeryHigh => email_ok && account_ok && member_ok,
    }
}

/// AutoMod's verdict on one message before it is stored: the rules it hit. While a spam rule applies it also holds the member's
/// spam lock, so this copy is stored before their next send is counted; keep it alive until the insert is done.
#[derive(Default)]
pub struct Screening {
    hits: Vec<Hit>,
    guild_id: i64,
    channel_id: i64,
    user_id: i64,
    content: String,
    _spam_lock: Option<OwnedMutexGuard<()>>,
}

struct Hit {
    rule: RuleRow,
    /// The matched keyword; `None` for spam and mention rules.
    keyword: Option<String>,
}

impl Screening {
    /// When a hit rule blocks: runs every hit's actions and fails with 400 200000 (the first blocking rule's custom message).
    async fn block(&self, state: &AppState) -> ApiResult<()> {
        let Some(blocking) = self.hits.iter().find(|hit| hit.rule.block_message) else { return Ok(()) };
        self.run(state).await;
        Err(ApiErr::automod_blocked(blocking.rule.custom_message.as_deref()))
    }

    /// The alert and timeout actions of rules that only flag, once the message is stored. A failure is logged; the message stands.
    pub async fn act(self, state: &AppState) {
        self.run(state).await;
    }

    async fn run(&self, state: &AppState) {
        for hit in &self.hits {
            if let Err(error) = self.run_hit(state, hit).await {
                tracing::warn!("automod rule {}: {error:?}", hit.rule.id);
            }
        }
    }

    async fn run_hit(&self, state: &AppState, hit: &Hit) -> ApiResult<()> {
        let (rule, guild_id, user_id) = (&hit.rule, self.guild_id, self.user_id);
        let options = AuditEntryInfo {
            channel_id: Some(Snowflake::from(self.channel_id)),
            auto_moderation_rule_name: Some(rule.name.clone()),
            auto_moderation_rule_trigger_type: Some(rule.trigger_type.to_string()),
            ..Default::default()
        };
        // Only alerts for blocked messages are throttled: those messages are gone (audit 143 still records each), while a
        // flagged one stays up and always gets its alert.
        let blocked = self.hits.iter().any(|hit| hit.rule.block_message);
        if let Some(alert_channel) = rule.alert_channel_id
            && let Some(held_back) = if blocked { alert_slot(rule.id, user_id) } else { Some(0) }
        {
            // A failed alert must not change what happens to the message.
            match post_alert(state, guild_id, alert_channel, self.channel_id, user_id, &self.content, rule, hit.keyword.as_deref(), held_back).await {
                Ok(()) => {
                    let entry = Entry::new(guild_id, user_id, AuditLogEvent::AutoModerationFlagToChannel, user_id).options(options.clone());
                    audit::record(state, entry).await?;
                }
                Err(error) => {
                    if blocked {
                        alert_release(rule.id, user_id, held_back);
                    }
                    tracing::warn!("automod rule {}: alert failed: {error:?}", rule.id);
                }
            }
        }
        if let Some(seconds) = rule.timeout_seconds {
            let until = apply_timeout(state, guild_id, user_id, seconds).await?;
            let entry = Entry::new(guild_id, user_id, AuditLogEvent::AutoModerationUserCommunicationDisabled, user_id).options(options.clone()).change(
                "communication_disabled_until",
                None::<String>,
                until.format(&Rfc3339).ok(),
            );
            audit::record(state, entry).await?;
        }
        if rule.block_message {
            audit::record(state, Entry::new(guild_id, user_id, AuditLogEvent::AutoModerationBlockMessage, user_id).options(options)).await?;
        }
        Ok(())
    }
}

/// Matches the guild's enabled rules against a new (`edit` = false) or edited message by `user_id`, without acting on them.
async fn screen(state: &AppState, access: &ChannelAccess, user_id: i64, screened: &str, plain: &str, edit: bool) -> ApiResult<Screening> {
    let mut out = Screening { channel_id: access.channel.id, user_id, content: screened.to_owned(), ..Screening::default() };
    let Some(guild_id) = access.channel.guild_id else { return Ok(out) };
    out.guild_id = guild_id;
    if screened.trim().is_empty() {
        return Ok(out);
    }
    let rules: Vec<RuleRow> = load_rules(state, guild_id).await?.into_iter().filter(|rule| rule.enabled).collect();
    if rules.is_empty() {
        return Ok(out);
    }
    let guild = guild_access(state, user_id, guild_id).await?;
    if guild.owner_id == user_id || guild.permissions & (MANAGE_GUILD | ADMINISTRATOR) != 0 {
        return Ok(out);
    }
    // A thread is exempt when its parent is.
    let channels = [Some(access.channel.id), access.channel.is_thread().then_some(access.channel.parent_id).flatten()];
    for rule in rules {
        if rule.exempt_roles.iter().any(|role| guild.roles.contains(role)) || channels.iter().flatten().any(|id| rule.exempt_channels.contains(id)) {
            continue;
        }
        let keyword = if rule.kind() == AutoModerationTriggerType::Spam {
            // An edit is no new post, so it never counts as a repeat.
            let Some(text) = spam_text(plain).filter(|_| !edit) else { continue };
            if out._spam_lock.is_none() {
                out._spam_lock = Some(spam_lock(guild_id, user_id).await);
            }
            if !is_repeat_spam(state, guild_id, user_id, &text).await? {
                continue;
            }
            None
        } else {
            let Some(keyword) = rule.matches(screened) else { continue };
            keyword
        };
        out.hits.push(Hit { rule, keyword });
    }
    Ok(out)
}

/// One lock per member and guild, held from the spam count to the insert, so parallel copies cannot all count as early ones.
/// shortcut: in-process, which is right for the single server instance; a second instance needs a Postgres advisory lock instead.
async fn spam_lock(guild_id: i64, user_id: i64) -> OwnedMutexGuard<()> {
    type Locks = StdMutex<HashMap<(i64, i64), Arc<Mutex<()>>>>;
    static LOCKS: LazyLock<Locks> = LazyLock::new(Default::default);
    let lock = {
        let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry((guild_id, user_id)).or_default().clone()
    };
    lock.lock_owned().await
}

type AlertSlots = StdMutex<HashMap<(i64, i64), (Instant, u32)>>;
static ALERTS_SENT: LazyLock<AlertSlots> = LazyLock::new(Default::default);

/// At most one alert per rule and member per [`ALERT_INTERVAL`] for blocked messages, so a member repeating one cannot flood the
/// mod channel. `Some(n)` when this alert may post, `n` = alerts held back since the last one (shown on the next alert; no
/// summary is posted when the window ends).
/// shortcut: in-process like [`spam_lock`]; a second server instance would alert once per instance.
fn alert_slot(rule_id: i64, user_id: i64) -> Option<u32> {
    let now = Instant::now();
    let mut sent = ALERTS_SENT.lock().unwrap_or_else(PoisonError::into_inner);
    sent.retain(|_, (at, _)| now.duration_since(*at) < ALERT_FORGET);
    if let Some((at, held_back)) = sent.get_mut(&(rule_id, user_id)) {
        if now.duration_since(*at) < ALERT_INTERVAL {
            *held_back += 1;
            return None;
        }
        *at = now;
        return Some(std::mem::take(held_back));
    }
    sent.insert((rule_id, user_id), (now, 0));
    Some(0)
}

/// The alert the slot was taken for failed: free the slot so the next blocked copy alerts, still counting the held-back ones.
fn alert_release(rule_id: i64, user_id: i64, held_back: u32) {
    let mut sent = ALERTS_SENT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((at, count)) = sent.get_mut(&(rule_id, user_id)) {
        *at -= ALERT_INTERVAL;
        *count += held_back;
    }
}

/// The text the spam check compares: trimmed and lowercased, or `None` when it is too short to count.
fn spam_text(content: &str) -> Option<String> {
    let text = content.trim().to_lowercase();
    (text.chars().count() >= SPAM_MIN_CHARS).then_some(text)
}

/// SPAM rule: the same text (case-insensitive, at least [`SPAM_MIN_CHARS`] characters) from one member for the
/// [`SPAM_REPEATS`]th time within [`SPAM_WINDOW_MS`] anywhere in the guild. The copies before it were already posted.
async fn is_repeat_spam(state: &AppState, guild_id: i64, user_id: i64, text: &str) -> ApiResult<bool> {
    let since = crate::ids::at(crate::ids::now_ms().saturating_sub(SPAM_WINDOW_MS), 0, 0);
    let (count,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id \
         WHERE m.author_id = $1 AND m.id > $2 AND c.guild_id = $3 AND lower(btrim(m.content)) = $4",
    )
    .bind(user_id)
    .bind(since)
    .bind(guild_id)
    .bind(text)
    .fetch_one(&state.db)
    .await?;
    Ok(count + 1 >= SPAM_REPEATS)
}

/// Unique user and role mentions in `content` (`@everyone` does not count, as on Discord).
pub fn mention_count(content: &str) -> usize {
    let parsed = messages::parse_mentions(content);
    parsed.users.len() + parsed.roles.len()
}

/// The words of a built-in preset list (`assets/automod`): one keyword per line, `#` starts a comment line.
fn preset_words(preset: AutoModerationKeywordPresetType) -> &'static [String] {
    static LISTS: LazyLock<[Vec<String>; 3]> = LazyLock::new(|| {
        [
            parse_preset(include_str!("../../../assets/automod/profanity.txt")),
            parse_preset(include_str!("../../../assets/automod/sexual.txt")),
            parse_preset(include_str!("../../../assets/automod/slurs.txt")),
        ]
    });
    match preset {
        AutoModerationKeywordPresetType::Profanity => &LISTS[0],
        AutoModerationKeywordPresetType::SexualContent => &LISTS[1],
        AutoModerationKeywordPresetType::Slurs => &LISTS[2],
    }
}

fn parse_preset(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).map(str::to_owned).collect()
}

/// Times the member out until `seconds` from now (a longer timeout stays), then announces the member and updates their voice rights.
async fn apply_timeout(state: &AppState, guild_id: i64, user_id: i64, seconds: i32) -> ApiResult<OffsetDateTime> {
    let until = OffsetDateTime::now_utc() + Duration::seconds(i64::from(seconds));
    let (stored,): (OffsetDateTime,) = sqlx::query_as(
        "UPDATE guild_members SET timeout_until = GREATEST(COALESCE(timeout_until, $3), $3) WHERE guild_id = $1 AND user_id = $2 RETURNING timeout_until",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(until)
    .fetch_one(&state.db)
    .await?;
    crate::voice::state::recompute_member(state, guild_id, user_id).await;
    crate::routes::moderation::publish_member(state, guild_id, user_id).await?;
    Ok(stored)
}

/// The type 24 message in the rule's alert channel: author = the member, content and rule in an `auto_moderation_message` embed.
#[allow(clippy::too_many_arguments)]
async fn post_alert(
    state: &AppState,
    guild_id: i64,
    alert_channel: i64,
    channel_id: i64,
    user_id: i64,
    content: &str,
    rule: &RuleRow,
    keyword: Option<&str>,
    held_back: u32,
) -> ApiResult<()> {
    // Deleting the channel clears the rule's alert_channel_id (ON DELETE SET NULL); a stale id still fails loudly here.
    let channel = store::channel_row(state, alert_channel).await?.filter(|channel| channel.guild_id == Some(guild_id)).ok_or_else(ApiErr::unknown_channel)?;
    let field = |name: &str, value: String| EmbedField { name: name.to_owned(), value, inline: None };
    let mut fields = vec![
        field("rule_name", rule.name.clone()),
        field("channel_id", channel_id.to_string()),
        field("decision_outcome", if rule.block_message { "blocked" } else { "flagged" }.to_owned()),
    ];
    if let Some(keyword) = keyword {
        fields.push(field("keyword", keyword.to_owned()));
    }
    if let Some(seconds) = rule.timeout_seconds {
        fields.push(field("timeout_duration", seconds.to_string()));
    }
    if held_back > 0 {
        fields.push(field("alerts_held_back", held_back.to_string()));
    }
    let embed = Embed {
        kind: EmbedType::AutoModerationMessage,
        title: None,
        description: Some(content.to_owned()),
        url: None,
        timestamp: None,
        color: None,
        footer: None,
        image: None,
        thumbnail: None,
        video: None,
        provider: None,
        author: None,
        fields: Some(fields),
    };
    let embeds = serde_json::to_string(&[embed]).map_err(|_| ApiErr::internal())?;
    let draft = Draft {
        content: String::new(),
        kind: MessageType::AutoModerationAction,
        reference: None,
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    messages::insert_message_with(state, &channel, user_id, draft, Extras { embeds: Some(embeds), ..Extras::default() }).await?;
    Ok(())
}

/// The first keyword of `keywords` that matches `content` (case-insensitive, whole words unless `*` wildcards say otherwise),
/// skipping matches whose word is on `allow_list`.
pub fn find_keyword<'a>(content: &str, keywords: &'a [String], allow_list: &[String]) -> Option<&'a str> {
    let text: Vec<char> = content.to_lowercase().chars().collect();
    keywords.iter().find(|keyword| matches_in(&text, keyword, allow_list)).map(String::as_str)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// (core, may extend left, may extend right).
fn pattern(keyword: &str) -> (Vec<char>, bool, bool) {
    let lower = keyword.trim().to_lowercase();
    let left = lower.starts_with('*');
    let right = lower.len() > 1 && lower.ends_with('*');
    (lower.trim_matches('*').chars().collect(), left, right)
}

fn matches_in(text: &[char], keyword: &str, allow_list: &[String]) -> bool {
    let (core, left, right) = pattern(keyword);
    if core.is_empty() || core.len() > text.len() {
        return false;
    }
    (0..=text.len() - core.len()).any(|start| {
        let end = start + core.len();
        if text[start..end] != core[..] {
            return false;
        }
        let bounded_left = start == 0 || !is_word(text[start - 1]) || !is_word(core[0]);
        let bounded_right = end == text.len() || !is_word(text[end]) || !core.last().copied().is_some_and(is_word);
        if !(left || bounded_left) || !(right || bounded_right) {
            return false;
        }
        // The whole word(s) around the hit: when the allow list matches it, this hit does not count.
        let mut word_start = start;
        while word_start > 0 && is_word(text[word_start - 1]) {
            word_start -= 1;
        }
        let mut word_end = end;
        while word_end < text.len() && is_word(text[word_end]) {
            word_end += 1;
        }
        let word = &text[word_start..word_end];
        !allow_list.iter().any(|allowed| whole_match(word, allowed))
    })
}

/// Whether `word` as a whole fits the keyword syntax of `allowed`.
fn whole_match(word: &[char], allowed: &str) -> bool {
    let (core, left, right) = pattern(allowed);
    if core.is_empty() || core.len() > word.len() {
        return false;
    }
    match (left, right) {
        (false, false) => word == &core[..],
        (false, true) => word.starts_with(&core),
        (true, false) => word.ends_with(&core),
        (true, true) => word.windows(core.len()).any(|window| window == &core[..]),
    }
}

// ---- rules ----

#[derive(sqlx::FromRow, Clone)]
struct RuleRow {
    id: i64,
    guild_id: i64,
    name: String,
    creator_id: i64,
    trigger_type: i16,
    keyword_filter: Vec<String>,
    allow_list: Vec<String>,
    presets: Vec<i16>,
    mention_total_limit: Option<i16>,
    block_message: bool,
    custom_message: Option<String>,
    alert_channel_id: Option<i64>,
    timeout_seconds: Option<i32>,
    enabled: bool,
    exempt_roles: Vec<i64>,
    exempt_channels: Vec<i64>,
}

const RULE_COLS: &str = "id, guild_id, name, creator_id, trigger_type, keyword_filter, allow_list, presets, mention_total_limit, block_message, \
    custom_message, alert_channel_id, timeout_seconds, enabled, exempt_roles, exempt_channels";

impl RuleRow {
    fn kind(&self) -> AutoModerationTriggerType {
        AutoModerationTriggerType::from_u8(self.trigger_type as u8).unwrap_or(AutoModerationTriggerType::Keyword)
    }

    fn presets(&self) -> Vec<AutoModerationKeywordPresetType> {
        self.presets.iter().filter_map(|value| AutoModerationKeywordPresetType::from_u8(*value as u8)).collect()
    }

    /// `Some(keyword)` when the rule fires on `content`; the keyword is `None` for mention rules. Spam needs the database ([`screen`]).
    fn matches(&self, content: &str) -> Option<Option<String>> {
        match self.kind() {
            AutoModerationTriggerType::Keyword => find_keyword(content, &self.keyword_filter, &self.allow_list).map(|word| Some(word.to_owned())),
            AutoModerationTriggerType::KeywordPreset => {
                self.presets().into_iter().find_map(|preset| find_keyword(content, preset_words(preset), &self.allow_list)).map(|word| Some(word.to_owned()))
            }
            AutoModerationTriggerType::MentionSpam => {
                let limit = self.mention_total_limit.map_or(usize::MAX, |limit| limit as usize);
                (mention_count(content) > limit).then_some(None)
            }
            AutoModerationTriggerType::Spam => None,
        }
    }

    fn api(&self) -> AutoModerationRule {
        let action = |kind, metadata| AutoModerationAction { kind, metadata };
        let mut actions = Vec::new();
        if self.block_message {
            let metadata = self.custom_message.clone().map(|message| AutoModerationActionMetadata { custom_message: Some(message), ..Default::default() });
            actions.push(action(AutoModerationActionType::BlockMessage, metadata));
        }
        if let Some(channel) = self.alert_channel_id {
            let metadata = AutoModerationActionMetadata { channel_id: Some(Snowflake::from(channel)), ..Default::default() };
            actions.push(action(AutoModerationActionType::SendAlertMessage, Some(metadata)));
        }
        if let Some(seconds) = self.timeout_seconds {
            let metadata = AutoModerationActionMetadata { duration_seconds: Some(seconds as u32), ..Default::default() };
            actions.push(action(AutoModerationActionType::Timeout, Some(metadata)));
        }
        AutoModerationRule {
            id: Snowflake::from(self.id),
            guild_id: Snowflake::from(self.guild_id),
            name: self.name.clone(),
            creator_id: Snowflake::from(self.creator_id),
            event_type: AutoModerationEventType::MessageSend,
            trigger_type: self.kind(),
            trigger_metadata: AutoModerationTriggerMetadata {
                keyword_filter: self.keyword_filter.clone(),
                allow_list: self.allow_list.clone(),
                presets: self.presets(),
                mention_total_limit: self.mention_total_limit.map(|limit| limit as u32),
            },
            actions,
            enabled: self.enabled,
            exempt_roles: self.exempt_roles.iter().copied().map(Snowflake::from).collect(),
            exempt_channels: self.exempt_channels.iter().copied().map(Snowflake::from).collect(),
        }
    }
}

async fn load_rules(state: &AppState, guild_id: i64) -> ApiResult<Vec<RuleRow>> {
    Ok(sqlx::query_as(&format!("SELECT {RULE_COLS} FROM automod_rules WHERE guild_id = $1 ORDER BY id")).bind(guild_id).fetch_all(&state.db).await?)
}

async fn load_rule(state: &AppState, guild_id: i64, raw: &str) -> ApiResult<RuleRow> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_automod_rule)?;
    let row: Option<RuleRow> = sqlx::query_as(&format!("SELECT {RULE_COLS} FROM automod_rules WHERE guild_id = $1 AND id = $2"))
        .bind(guild_id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    row.ok_or_else(ApiErr::unknown_automod_rule)
}

fn guild_of(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

async fn require_manager(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<()> {
    guild_access(state, user_id, guild_id).await?.require(MANAGE_GUILD)
}

fn clean_list(values: Vec<String>, max: usize, field: &str) -> ApiResult<Vec<String>> {
    if values.len() > max {
        return Err(ApiErr::invalid(field, &format!("Must have at most {max} entries.")));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        let count = value.chars().count();
        if count == 0 || count > MAX_KEYWORD_CHARS || value.trim_matches('*').is_empty() {
            return Err(ApiErr::invalid(field, "Each entry must be 1-60 characters."));
        }
        if !out.contains(&value) {
            out.push(value);
        }
    }
    Ok(out)
}

/// What the rule does on a match; each action type at most once.
struct Actions {
    block: bool,
    custom_message: Option<String>,
    alert_channel: Option<i64>,
    timeout_seconds: Option<i32>,
}

/// The trigger metadata a rule of its type keeps; keys that type does not use are dropped.
struct Trigger {
    keywords: Vec<String>,
    allow_list: Vec<String>,
    presets: Vec<i16>,
    mention_total_limit: Option<i16>,
}

/// Rule fields after validation; `None` = keep the stored value (PATCH).
struct Fields {
    name: Option<String>,
    trigger: Option<Trigger>,
    actions: Option<Actions>,
    enabled: Option<bool>,
    exempt_roles: Option<Vec<i64>>,
    exempt_channels: Option<Vec<i64>>,
}

fn validate_trigger(kind: AutoModerationTriggerType, meta: AutoModerationTriggerMetadata) -> ApiResult<Trigger> {
    use AutoModerationTriggerType as T;
    let keywords = if kind == T::Keyword { clean_list(meta.keyword_filter, MAX_KEYWORDS, "trigger_metadata.keyword_filter")? } else { Vec::new() };
    let allow_list = match kind {
        T::Keyword => clean_list(meta.allow_list, MAX_ALLOW_LIST, "trigger_metadata.allow_list")?,
        T::KeywordPreset => clean_list(meta.allow_list, MAX_PRESET_ALLOW_LIST, "trigger_metadata.allow_list")?,
        T::Spam | T::MentionSpam => Vec::new(),
    };
    let presets = if kind == T::KeywordPreset {
        let mut values: Vec<i16> = meta.presets.iter().map(|preset| i16::from(preset.as_u8())).collect();
        values.sort_unstable();
        values.dedup();
        if values.is_empty() {
            return Err(ApiErr::invalid("trigger_metadata.presets", "Choose at least one category."));
        }
        values
    } else {
        Vec::new()
    };
    let mention_total_limit = match (kind, meta.mention_total_limit) {
        (T::MentionSpam, Some(limit @ 1..=MAX_MENTION_LIMIT)) => Some(limit as i16),
        (T::MentionSpam, _) => return Err(ApiErr::invalid("trigger_metadata.mention_total_limit", "Must be between 1 and 50.")),
        _ => None,
    };
    Ok(Trigger { keywords, allow_list, presets, mention_total_limit })
}

async fn validate_actions(state: &AppState, guild_id: i64, kind: AutoModerationTriggerType, actions: Vec<AutoModerationAction>) -> ApiResult<Actions> {
    if actions.is_empty() {
        return Err(ApiErr::invalid("actions", "At least one action is required."));
    }
    let mut out = Actions { block: false, custom_message: None, alert_channel: None, timeout_seconds: None };
    let mut seen = Vec::new();
    for action in actions {
        if seen.contains(&action.kind) {
            return Err(ApiErr::invalid("actions", "Each action type may appear once."));
        }
        seen.push(action.kind);
        let meta = action.metadata.unwrap_or_default();
        match action.kind {
            AutoModerationActionType::BlockMessage => {
                let message = meta.custom_message.as_deref().map(str::trim).filter(|text| !text.is_empty());
                if message.is_some_and(|text| text.chars().count() > MAX_CUSTOM_MESSAGE_CHARS) {
                    return Err(ApiErr::invalid("actions", "The custom message must be 150 or fewer in length."));
                }
                out.block = true;
                out.custom_message = message.map(str::to_owned);
            }
            AutoModerationActionType::SendAlertMessage => {
                let channel = meta.channel_id.map(Snowflake::db).ok_or_else(|| ApiErr::invalid("actions", "An alert needs a channel_id."))?;
                let row: Option<(i16,)> =
                    sqlx::query_as("SELECT kind FROM channels WHERE id = $1 AND guild_id = $2").bind(channel).bind(guild_id).fetch_optional(&state.db).await?;
                let text = row.is_some_and(|(kind,)| matches!(ChannelType::from_u8(kind as u8), Some(ChannelType::GuildText | ChannelType::GuildAnnouncement)));
                if !text {
                    return Err(ApiErr::invalid("actions", "The alert channel must be a text channel of this server."));
                }
                out.alert_channel = Some(channel);
            }
            AutoModerationActionType::Timeout => {
                if !matches!(kind, AutoModerationTriggerType::Keyword | AutoModerationTriggerType::MentionSpam) {
                    return Err(ApiErr::invalid("actions", "Only keyword and mention spam rules can time members out."));
                }
                match meta.duration_seconds {
                    Some(seconds @ 1..=MAX_TIMEOUT_SECONDS) => out.timeout_seconds = Some(seconds as i32),
                    _ => return Err(ApiErr::invalid("actions", "A timeout lasts 1 second to 4 weeks.")),
                }
            }
        }
    }
    Ok(out)
}

async fn validate(state: &AppState, guild_id: i64, kind: AutoModerationTriggerType, body: AutoModerationRuleRequest) -> ApiResult<Fields> {
    let name = match body.name {
        Some(name) => {
            let name = name.trim().to_owned();
            if !(1..=100).contains(&name.chars().count()) {
                return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
            }
            Some(name)
        }
        None => None,
    };
    let trigger = body.trigger_metadata.map(|meta| validate_trigger(kind, meta)).transpose()?;
    let actions = match body.actions {
        Some(actions) => Some(validate_actions(state, guild_id, kind, actions).await?),
        None => None,
    };
    let exempt_roles = match body.exempt_roles {
        Some(roles) => {
            let ids: Vec<i64> = roles.into_iter().map(Snowflake::db).collect();
            if ids.len() > MAX_EXEMPT_ROLES {
                return Err(ApiErr::invalid("exempt_roles", "Must have at most 20 entries."));
            }
            let (found,): (i64,) =
                sqlx::query_as("SELECT count(*) FROM roles WHERE guild_id = $1 AND id = ANY($2)").bind(guild_id).bind(&ids).fetch_one(&state.db).await?;
            if found as usize != dedup(&ids).len() {
                return Err(ApiErr::invalid("exempt_roles", "Unknown role."));
            }
            Some(dedup(&ids))
        }
        None => None,
    };
    let exempt_channels = match body.exempt_channels {
        Some(channels) => {
            let ids: Vec<i64> = channels.into_iter().map(Snowflake::db).collect();
            if ids.len() > MAX_EXEMPT_CHANNELS {
                return Err(ApiErr::invalid("exempt_channels", "Must have at most 50 entries."));
            }
            let (found,): (i64,) =
                sqlx::query_as("SELECT count(*) FROM channels WHERE guild_id = $1 AND id = ANY($2)").bind(guild_id).bind(&ids).fetch_one(&state.db).await?;
            if found as usize != dedup(&ids).len() {
                return Err(ApiErr::invalid("exempt_channels", "Unknown channel."));
            }
            Some(dedup(&ids))
        }
        None => None,
    };
    Ok(Fields { name, trigger, actions, enabled: body.enabled, exempt_roles, exempt_channels })
}

fn dedup(ids: &[i64]) -> Vec<i64> {
    let mut out = ids.to_vec();
    out.sort_unstable();
    out.dedup();
    out
}

/// AUTO_MODERATION_RULE_* to members with MANAGE_GUILD.
async fn publish(state: &AppState, guild_id: i64, event: GatewayEvent) -> ApiResult<()> {
    let audience = crate::access::members_with_permission(state, guild_id, MANAGE_GUILD).await?;
    state.hub.send(&audience, &event);
    Ok(())
}

fn rule_changes(entry: Entry, old: Option<&AutoModerationRule>, new: Option<&AutoModerationRule>) -> Entry {
    entry
        .change("name", old.map(|r| &r.name), new.map(|r| &r.name))
        .change("enabled", old.map(|r| r.enabled), new.map(|r| r.enabled))
        .change("trigger_metadata", old.map(|r| &r.trigger_metadata), new.map(|r| &r.trigger_metadata))
        .change("actions", old.map(|r| &r.actions), new.map(|r| &r.actions))
        .change("exempt_roles", old.map(|r| &r.exempt_roles), new.map(|r| &r.exempt_roles))
        .change("exempt_channels", old.map(|r| &r.exempt_channels), new.map(|r| &r.exempt_channels))
}

async fn list_rules(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<AutoModerationRule>>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    Ok(Json(load_rules(&state, guild).await?.iter().map(RuleRow::api).collect()))
}

async fn get_rule(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, rule)): Path<(String, String)>) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    Ok(Json(load_rule(&state, guild, &rule).await?.api()))
}

async fn create_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<AutoModerationRuleRequest>,
) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    if body.event_type.is_none() {
        return Err(ApiErr::invalid("event_type", "Required."));
    }
    let kind = body.trigger_type.ok_or_else(|| ApiErr::invalid("trigger_type", "Required."))?;
    if body.actions.is_none() {
        return Err(ApiErr::invalid("actions", "Required."));
    }
    let fields = validate(&state, guild, kind, body).await?;
    let name = fields.name.ok_or_else(|| ApiErr::invalid("name", "Required."))?;
    let trigger = match fields.trigger {
        Some(trigger) => trigger,
        None => validate_trigger(kind, AutoModerationTriggerMetadata::default())?,
    };
    let actions = fields.actions.ok_or_else(|| ApiErr::invalid("actions", "Required."))?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM automod_rules WHERE guild_id = $1 AND trigger_type = $2")
        .bind(guild)
        .bind(i16::from(kind.as_u8()))
        .fetch_one(&state.db)
        .await?;
    let max = if kind == AutoModerationTriggerType::Keyword { MAX_KEYWORD_RULES } else { 1 };
    if count >= max {
        return Err(ApiErr::conflict(30035, &format!("Maximum number of rules of this type reached ({max})")));
    }
    let row: RuleRow = sqlx::query_as(&format!(
        "INSERT INTO automod_rules (id, guild_id, name, creator_id, trigger_type, keyword_filter, allow_list, presets, mention_total_limit, \
         block_message, custom_message, alert_channel_id, timeout_seconds, enabled, exempt_roles, exempt_channels) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING {RULE_COLS}"
    ))
    .bind(state.ids.next())
    .bind(guild)
    .bind(&name)
    .bind(user_id)
    .bind(i16::from(kind.as_u8()))
    .bind(trigger.keywords)
    .bind(trigger.allow_list)
    .bind(trigger.presets)
    .bind(trigger.mention_total_limit)
    .bind(actions.block)
    .bind(actions.custom_message)
    .bind(actions.alert_channel)
    .bind(actions.timeout_seconds)
    .bind(fields.enabled.unwrap_or(true))
    .bind(fields.exempt_roles.unwrap_or_default())
    .bind(fields.exempt_channels.unwrap_or_default())
    .fetch_one(&state.db)
    .await?;
    let rule = row.api();
    publish(&state, guild, GatewayEvent::AutoModerationRuleCreate(rule.clone())).await?;
    audit::record(&state, rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleCreate, row.id).reason(reason), None, Some(&rule))).await?;
    Ok(Json(rule))
}

async fn update_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rule_id)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<AutoModerationRuleRequest>,
) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    let current = load_rule(&state, guild, &rule_id).await?;
    let kind = current.kind();
    if body.trigger_type.is_some_and(|wanted| wanted != kind) {
        return Err(ApiErr::invalid("trigger_type", "The trigger type cannot change."));
    }
    let fields = validate(&state, guild, kind, body).await?;
    let trigger = fields.trigger.unwrap_or_else(|| Trigger {
        keywords: current.keyword_filter.clone(),
        allow_list: current.allow_list.clone(),
        presets: current.presets.clone(),
        mention_total_limit: current.mention_total_limit,
    });
    let actions = fields.actions.unwrap_or_else(|| Actions {
        block: current.block_message,
        custom_message: current.custom_message.clone(),
        alert_channel: current.alert_channel_id,
        timeout_seconds: current.timeout_seconds,
    });
    let row: RuleRow = sqlx::query_as(&format!(
        "UPDATE automod_rules SET name = $2, keyword_filter = $3, allow_list = $4, presets = $5, mention_total_limit = $6, block_message = $7, \
         custom_message = $8, alert_channel_id = $9, timeout_seconds = $10, enabled = $11, exempt_roles = $12, exempt_channels = $13 \
         WHERE id = $1 RETURNING {RULE_COLS}"
    ))
    .bind(current.id)
    .bind(fields.name.unwrap_or_else(|| current.name.clone()))
    .bind(trigger.keywords)
    .bind(trigger.allow_list)
    .bind(trigger.presets)
    .bind(trigger.mention_total_limit)
    .bind(actions.block)
    .bind(actions.custom_message)
    .bind(actions.alert_channel)
    .bind(actions.timeout_seconds)
    .bind(fields.enabled.unwrap_or(current.enabled))
    .bind(fields.exempt_roles.unwrap_or_else(|| current.exempt_roles.clone()))
    .bind(fields.exempt_channels.unwrap_or_else(|| current.exempt_channels.clone()))
    .fetch_one(&state.db)
    .await?;
    let (old, rule) = (current.api(), row.api());
    publish(&state, guild, GatewayEvent::AutoModerationRuleUpdate(rule.clone())).await?;
    let entry = rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleUpdate, row.id).reason(reason), Some(&old), Some(&rule));
    if !entry.changes.is_empty() {
        audit::record(&state, entry).await?;
    }
    Ok(Json(rule))
}

async fn delete_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rule_id)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    let current = load_rule(&state, guild, &rule_id).await?;
    sqlx::query("DELETE FROM automod_rules WHERE id = $1").bind(current.id).execute(&state.db).await?;
    let rule = current.api();
    publish(&state, guild, GatewayEvent::AutoModerationRuleDelete(rule.clone())).await?;
    audit::record(&state, rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleDelete, current.id).reason(reason), Some(&rule), None))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn keywords_match_whole_words_and_wildcards() {
        let hit = |content: &str, keyword: &str| find_keyword(content, &words(&[keyword]), &[]).is_some();
        assert!(hit("I like Cats.", "cats"));
        assert!(!hit("concatenate", "cat"), "whole words only");
        assert!(hit("concatenate", "*cat*"));
        assert!(hit("catalogue", "cat*"));
        assert!(!hit("bobcat", "cat*"));
        assert!(hit("bobcat!", "*cat"));
        assert!(hit("well, free money here", "free money"));
        assert!(!hit("freemoney", "free money"));
        assert!(hit("ÅSKA och regn", "åska"));
        assert!(!hit("", "x"));
    }

    #[test]
    fn allow_list_saves_a_word() {
        let keywords = words(&["bad*"]);
        assert_eq!(find_keyword("a badge", &keywords, &words(&["badge"])), None);
        assert_eq!(find_keyword("a badge and a baddie", &keywords, &words(&["badge"])), Some("bad*"));
        assert_eq!(find_keyword("badminton", &keywords, &words(&["*minton"])), None);
    }

    #[test]
    fn presets_and_mentions() {
        use AutoModerationKeywordPresetType as P;
        for preset in [P::Profanity, P::SexualContent, P::Slurs] {
            let words = preset_words(preset);
            assert!(words.len() >= 10 && words.iter().all(|word| !word.starts_with('#') && word.trim_matches('*').len() > 1), "{preset:?}");
        }
        assert_eq!(find_keyword("what the FUCKING hell", preset_words(P::Profanity), &[]), Some("fuck*"));
        assert_eq!(mention_count("<@1> <@!1> <@&2> @everyone <@x>"), 2);
    }

    #[test]
    fn verification_levels() {
        let now = OffsetDateTime::now_utc();
        let fresh = now - Duration::minutes(1);
        let old = now - Duration::hours(1);
        assert!(meets_level(VerificationLevel::None, false, fresh, fresh, now));
        assert!(meets_level(VerificationLevel::Low, true, fresh, fresh, now));
        assert!(!meets_level(VerificationLevel::Low, false, old, old, now), "Low needs a verified email");
        assert!(!meets_level(VerificationLevel::Medium, true, fresh, old, now));
        assert!(meets_level(VerificationLevel::Medium, true, old, fresh, now));
        assert!(!meets_level(VerificationLevel::Medium, false, old, old, now));
        assert!(!meets_level(VerificationLevel::High, true, old, fresh, now));
        assert!(meets_level(VerificationLevel::VeryHigh, true, old, old, now));
    }
}
