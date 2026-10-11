//! Polls: validation and storage of a new poll, loading polls (with per-viewer `me_voted`) into messages, and ending them exactly once
//! (End Poll Now or the expiry sweep), which posts the type 46 result message.
use std::collections::HashMap;
use std::time::Duration;

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use vokko_protocol::api::{
    Embed, EmbedField, EmbedType, MessageType, POLL_ANSWER_MAX_CHARS, POLL_DEFAULT_DURATION_HOURS, POLL_LAYOUT_DEFAULT, POLL_MAX_ANSWERS,
    POLL_MAX_DURATION_HOURS, POLL_QUESTION_MAX_CHARS, Poll, PollAnswer, PollAnswerCount, PollCreateRequest, PollMedia, PollResults, ReactionEmoji, Snowflake,
    poll_result_fields as field,
};

use crate::error::{ApiErr, ApiResult};
use crate::routes::messages::{self, Draft, Extras, Resolved};
use crate::state::AppState;
use crate::store;

const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

pub fn expired() -> ApiErr {
    ApiErr::conflict(520001, "Poll expired")
}

pub fn cannot_edit() -> ApiErr {
    ApiErr::conflict(520003, "Cannot edit a poll message")
}

pub fn not_a_poll() -> ApiErr {
    ApiErr::conflict(520006, "Cannot expire a non-poll message")
}

pub struct DraftAnswer {
    pub text: String,
    pub emoji: Option<ReactionEmoji>,
}

/// A validated `PollCreateRequest`.
pub struct PollDraft {
    pub question: String,
    pub answers: Vec<DraftAnswer>,
    pub duration_hours: u32,
    pub allow_multiselect: bool,
    pub layout_type: u8,
}

fn text_of(media: &PollMedia, field: &str, max: usize) -> ApiResult<String> {
    let text = media.text.as_deref().map(str::trim).unwrap_or("");
    if text.is_empty() || text.chars().count() > max {
        return Err(ApiErr::invalid(field, &format!("Must be between 1 and {max} in length.")));
    }
    Ok(text.to_owned())
}

fn valid_emoji(emoji: &ReactionEmoji) -> bool {
    match emoji.id {
        Some(_) => (2..=32).contains(&emoji.name.len()) && emoji.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        None => {
            let name = emoji.name.trim();
            !name.is_empty() && name.len() <= 64 && !name.chars().any(|c| c.is_ascii_alphanumeric() || c.is_control() || c.is_whitespace())
        }
    }
}

pub fn validate(request: &PollCreateRequest) -> ApiResult<PollDraft> {
    let question = text_of(&request.question, "poll.question.text", POLL_QUESTION_MAX_CHARS)?;
    if request.answers.is_empty() || request.answers.len() > POLL_MAX_ANSWERS {
        return Err(ApiErr::invalid("poll.answers", "A poll needs 1 to 10 answers."));
    }
    let mut answers = Vec::with_capacity(request.answers.len());
    for answer in &request.answers {
        let text = text_of(&answer.poll_media, "poll.answers.poll_media.text", POLL_ANSWER_MAX_CHARS)?;
        let emoji = match &answer.poll_media.emoji {
            Some(emoji) if !valid_emoji(emoji) => return Err(ApiErr::invalid("poll.answers.poll_media.emoji", "Unknown Emoji")),
            Some(emoji) => Some(ReactionEmoji { id: emoji.id, name: emoji.name.trim().to_owned(), animated: None }),
            None => None,
        };
        answers.push(DraftAnswer { text, emoji });
    }
    let duration_hours = request.duration.unwrap_or(POLL_DEFAULT_DURATION_HOURS);
    if !(1..=POLL_MAX_DURATION_HOURS).contains(&duration_hours) {
        return Err(ApiErr::invalid("poll.duration", "Must be between 1 and 768 hours."));
    }
    let layout_type = request.layout_type.unwrap_or(POLL_LAYOUT_DEFAULT);
    if layout_type != POLL_LAYOUT_DEFAULT {
        return Err(ApiErr::invalid("poll.layout_type", "Unknown layout type."));
    }
    Ok(PollDraft { question, answers, duration_hours, allow_multiselect: request.allow_multiselect.unwrap_or(false), layout_type })
}

/// Stores the poll of a message inside the message's own insert transaction.
pub async fn insert(tx: &mut Transaction<'_, Postgres>, message_id: i64, poll: &PollDraft) -> ApiResult<()> {
    sqlx::query("INSERT INTO polls (message_id, question, allow_multiselect, layout_type, expiry) VALUES ($1, $2, $3, $4, now() + $5 * interval '1 hour')")
        .bind(message_id)
        .bind(&poll.question)
        .bind(poll.allow_multiselect)
        .bind(poll.layout_type as i16)
        .bind(poll.duration_hours as i32)
        .execute(&mut **tx)
        .await?;
    for (index, answer) in poll.answers.iter().enumerate() {
        sqlx::query("INSERT INTO poll_answers (message_id, answer_id, text, emoji_id, emoji_name) VALUES ($1, $2, $3, $4, $5)")
            .bind(message_id)
            .bind(index as i32 + 1)
            .bind(&answer.text)
            .bind(answer.emoji.as_ref().and_then(|emoji| emoji.id).map(Snowflake::db))
            .bind(answer.emoji.as_ref().map(|emoji| emoji.name.clone()))
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// A message's poll plus who voted for each answer (in `answers` order), so `me_voted` can be filled per viewer.
pub struct LoadedPoll {
    pub poll: Poll,
    pub voters: Vec<Vec<i64>>,
}

impl LoadedPoll {
    pub fn for_viewer(&self, viewer: Option<i64>) -> Poll {
        let mut poll = self.poll.clone();
        for (count, voters) in poll.results.answer_counts.iter_mut().zip(&self.voters) {
            count.me_voted = viewer.is_some_and(|viewer| voters.contains(&viewer));
        }
        poll
    }
}

/// (message_id, answer_id, text, emoji_id, emoji_name)
type AnswerRow = (i64, i32, String, Option<i64>, Option<String>);

#[derive(sqlx::FromRow)]
struct PollRow {
    message_id: i64,
    question: String,
    allow_multiselect: bool,
    layout_type: i16,
    expiry: OffsetDateTime,
    finalized: bool,
}

/// Polls of the given messages (messages without one are absent).
pub async fn load(state: &AppState, message_ids: &[i64]) -> ApiResult<HashMap<i64, LoadedPoll>> {
    let mut loaded = HashMap::new();
    if message_ids.is_empty() {
        return Ok(loaded);
    }
    let rows: Vec<PollRow> =
        sqlx::query_as("SELECT message_id, question, allow_multiselect, layout_type, expiry, finalized FROM polls WHERE message_id = ANY($1)")
            .bind(message_ids)
            .fetch_all(&state.db)
            .await?;
    if rows.is_empty() {
        return Ok(loaded);
    }
    let ids: Vec<i64> = rows.iter().map(|row| row.message_id).collect();
    let answers: Vec<AnswerRow> =
        sqlx::query_as("SELECT message_id, answer_id, text, emoji_id, emoji_name FROM poll_answers WHERE message_id = ANY($1) ORDER BY message_id, answer_id")
            .bind(&ids)
            .fetch_all(&state.db)
            .await?;
    let votes: Vec<(i64, i32, i64)> = sqlx::query_as("SELECT message_id, answer_id, user_id FROM poll_votes WHERE message_id = ANY($1) ORDER BY user_id")
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
    let mut voters: HashMap<(i64, i32), Vec<i64>> = HashMap::new();
    for (message_id, answer_id, user_id) in votes {
        voters.entry((message_id, answer_id)).or_default().push(user_id);
    }
    let mut by_poll: HashMap<i64, Vec<(PollAnswer, Vec<i64>)>> = HashMap::new();
    for (message_id, answer_id, text, emoji_id, emoji_name) in answers {
        let emoji = emoji_name.map(|name| ReactionEmoji { id: emoji_id.map(Snowflake::from), name, animated: None });
        let answer = PollAnswer { answer_id: answer_id.max(0) as u32, poll_media: PollMedia { text: Some(text), emoji } };
        by_poll.entry(message_id).or_default().push((answer, voters.remove(&(message_id, answer_id)).unwrap_or_default()));
    }
    for row in rows {
        let entries = by_poll.remove(&row.message_id).unwrap_or_default();
        let answer_counts =
            entries.iter().map(|(answer, users)| PollAnswerCount { id: answer.answer_id, count: users.len() as u32, me_voted: false }).collect();
        let (answers, voters): (Vec<PollAnswer>, Vec<Vec<i64>>) = entries.into_iter().unzip();
        let poll = Poll {
            question: PollMedia { text: Some(row.question), emoji: None },
            answers,
            expiry: store::iso(row.expiry),
            allow_multiselect: row.allow_multiselect,
            layout_type: row.layout_type.max(0) as u8,
            results: PollResults { is_finalized: row.finalized, answer_counts },
        };
        loaded.insert(row.message_id, LoadedPoll { poll, voters });
    }
    Ok(loaded)
}

/// The `poll_result` embed: question and total, plus the winner when one answer has strictly the most votes.
pub fn result_embed(poll: &Poll) -> Embed {
    let pair = |name: &str, value: String| EmbedField { name: name.to_owned(), value, inline: None };
    let total: u32 = poll.results.answer_counts.iter().map(|count| count.count).sum();
    let mut fields = vec![pair(field::QUESTION_TEXT, poll.question.text.clone().unwrap_or_default()), pair(field::TOTAL_VOTES, total.to_string())];
    let top = poll.results.answer_counts.iter().map(|count| count.count).max().unwrap_or(0);
    let leaders: Vec<&PollAnswerCount> = poll.results.answer_counts.iter().filter(|count| count.count == top).collect();
    if let ([winner], true) = (leaders.as_slice(), top > 0)
        && let Some(answer) = poll.answers.iter().find(|answer| answer.answer_id == winner.id)
    {
        fields.push(pair(field::VICTOR_ANSWER_ID, winner.id.to_string()));
        fields.push(pair(field::VICTOR_ANSWER_TEXT, answer.poll_media.text.clone().unwrap_or_default()));
        fields.push(pair(field::VICTOR_ANSWER_VOTES, winner.count.to_string()));
        if let Some(emoji) = &answer.poll_media.emoji {
            if let Some(id) = emoji.id {
                fields.push(pair(field::VICTOR_ANSWER_EMOJI_ID, id.to_string()));
            }
            fields.push(pair(field::VICTOR_ANSWER_EMOJI_NAME, emoji.name.clone()));
        }
    }
    Embed {
        kind: EmbedType::PollResult,
        title: None,
        description: None,
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
    }
}

/// Marks the poll finalised if nobody did yet. `now` ends it immediately (End Poll Now); otherwise only an expired poll is finalised.
/// Returns whether this call won, in which case it must call [`announce`].
pub async fn finalize(state: &AppState, message_id: i64, now: bool) -> ApiResult<bool> {
    // The UPDATE waits for votes holding the poll row (FOR SHARE), so every vote that got in is committed before the counts are read.
    let done =
        sqlx::query("UPDATE polls SET finalized = TRUE, expiry = LEAST(expiry, now()) WHERE message_id = $1 AND NOT finalized AND ($2 OR expiry <= now())")
            .bind(message_id)
            .bind(now)
            .execute(&state.db)
            .await?;
    Ok(done.rows_affected() > 0)
}

/// After a winning [`finalize`]: MESSAGE_UPDATE for the poll with its final results, then the type 46 result message.
pub async fn announce(state: &AppState, message_id: i64) -> ApiResult<()> {
    let Some((channel_id, author_id)) =
        sqlx::query_as::<_, (i64, i64)>("SELECT channel_id, author_id FROM messages WHERE id = $1").bind(message_id).fetch_optional(&state.db).await?
    else {
        return Ok(());
    };
    let Some(channel) = store::channel_row(state, channel_id).await? else { return Ok(()) };
    let Some(view) = messages::broadcast_update(state, &channel, message_id).await? else { return Ok(()) };
    let Some(poll) = view.message.poll.as_deref() else { return Ok(()) };
    let embeds = serde_json::to_string(&[result_embed(poll)]).map_err(|_| ApiErr::internal())?;
    let draft = Draft {
        content: String::new(),
        kind: MessageType::PollResult,
        reference: Some(message_id),
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    messages::insert_message_with(state, &channel, author_id, draft, Extras { embeds: Some(embeds), ..Extras::default() }).await?;
    Ok(())
}

/// Finalises every poll whose expiry has passed and announces each; returns how many this call ended.
pub async fn sweep_expired(state: &AppState) -> ApiResult<usize> {
    let due: Vec<(i64,)> =
        sqlx::query_as("SELECT message_id FROM polls WHERE NOT finalized AND expiry <= now() ORDER BY expiry LIMIT 500").fetch_all(&state.db).await?;
    let mut ended = 0;
    for (message_id,) in due {
        if finalize(state, message_id, false).await? {
            if let Err(error) = announce(state, message_id).await {
                tracing::warn!("poll {message_id}: result message failed: {error:?}");
            }
            ended += 1;
        }
    }
    Ok(ended)
}

/// Runs `sweep_expired` every few seconds; the task ends with the runtime.
pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            match sweep_expired(&state).await {
                Ok(0) => {}
                Ok(count) => tracing::info!("ended {count} expired polls"),
                Err(error) => tracing::warn!("poll sweep failed: {error:?}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll(counts: &[u32]) -> Poll {
        Poll {
            question: PollMedia { text: Some("Q".to_owned()), emoji: None },
            answers: (1..=counts.len() as u32)
                .map(|id| PollAnswer {
                    answer_id: id,
                    poll_media: PollMedia { text: Some(format!("A{id}")), emoji: (id == 2).then(|| ReactionEmoji { id: None, name: "🍕".to_owned() }) },
                })
                .collect(),
            expiry: String::new(),
            allow_multiselect: false,
            layout_type: 1,
            results: PollResults {
                is_finalized: true,
                answer_counts: counts
                    .iter()
                    .enumerate()
                    .map(|(index, count)| PollAnswerCount { id: index as u32 + 1, count: *count, me_voted: false })
                    .collect(),
            },
        }
    }

    fn fields(embed: &Embed) -> Vec<(String, String)> {
        embed.fields.iter().flatten().map(|field| (field.name.clone(), field.value.clone())).collect()
    }

    #[test]
    fn a_clear_winner_is_named_with_its_emoji() {
        let embed = result_embed(&poll(&[1, 3, 0]));
        assert_eq!(embed.kind, EmbedType::PollResult);
        let fields = fields(&embed);
        let get = |name: &str| fields.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert_eq!((get("poll_question_text"), get("total_votes")), (Some("Q"), Some("4")));
        assert_eq!((get("victor_answer_id"), get("victor_answer_text"), get("victor_answer_votes")), (Some("2"), Some("A2"), Some("3")));
        assert_eq!((get("victor_answer_emoji_name"), get("victor_answer_emoji_id")), (Some("🍕"), None));
    }

    #[test]
    fn ties_and_empty_polls_have_no_winner() {
        for counts in [[2, 2, 1], [0, 0, 0]] {
            let names: Vec<String> = fields(&result_embed(&poll(&counts))).into_iter().map(|(name, _)| name).collect();
            assert_eq!(names, ["poll_question_text", "total_votes"]);
        }
    }

    #[test]
    fn validation_bounds() {
        let answer = |text: &str| vokko_protocol::api::PollAnswerRequest { poll_media: PollMedia { text: Some(text.to_owned()), emoji: None } };
        let request = |question: &str, answers: Vec<vokko_protocol::api::PollAnswerRequest>, duration: Option<u32>| PollCreateRequest {
            question: PollMedia { text: Some(question.to_owned()), emoji: None },
            answers,
            duration,
            allow_multiselect: None,
            layout_type: None,
        };
        let ok = validate(&request(" Lunch? ", vec![answer("Pizza")], None)).expect("valid");
        assert_eq!((ok.question.as_str(), ok.duration_hours, ok.allow_multiselect), ("Lunch?", 24, false));
        assert!(validate(&request("", vec![answer("a")], None)).is_err());
        assert!(validate(&request(&"q".repeat(301), vec![answer("a")], None)).is_err());
        assert!(validate(&request("q", vec![], None)).is_err());
        assert!(validate(&request("q", (0..11).map(|_| answer("a")).collect(), None)).is_err());
        assert!(validate(&request("q", vec![answer(&"a".repeat(56))], None)).is_err());
        assert!(validate(&request("q", vec![answer("a")], Some(0))).is_err());
        assert!(validate(&request("q", vec![answer("a")], Some(769))).is_err());
        assert!(validate(&request("q", vec![answer("a")], Some(768))).is_ok());
    }
}
