//! `vokko-server seed`: idempotent demo data (users, a guild, DMs with ~60 messages, friendships, presences).
//!
//! Ids are derived from a base timestamp stored in `meta` the first time the seed runs, so the data is deterministic and a
//! second run finds the marker and changes nothing.
use std::collections::HashMap;

use sqlx::PgConnection;
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{CREATE_INSTANT_INVITE, DEFAULT_EVERYONE, MANAGE_CHANNELS, MANAGE_MESSAGES, VIEW_CHANNEL};

use crate::ids;
use crate::media;
use crate::state::AppState;

pub const PASSWORD: &str = "vokko-dev";
const BASE_KEY: &str = "seed_base_ms";
const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;

const SAM: usize = 0;
const CAROL: usize = 1;
const ALICE: usize = 2;
const BOB: usize = 3;
const NOVA: usize = 4;

/// username, display name, bio, banner colour, presence, custom status
type SeedUser = (&'static str, &'static str, &'static str, &'static str, &'static str, Option<&'static str>);
const USERS: [SeedUser; 5] = [
    ("sam", "Sam", "Building Vokko. Coffee first.", "#7c5cff", "online", None),
    ("carol", "Carol", "Frontend, rust, ramen.", "#2dd4bf", "online", Some("shipping the shell")),
    ("alice", "Alice", "Moderator. Cat person.", "#f472b6", "idle", Some("brb, coffee")),
    ("bob", "Bob", "Likes long builds, hates flaky tests.", "#f59e0b", "dnd", Some("in a meeting")),
    ("nova", "Nova", "Just looking around.", "#60a5fa", "offline", None),
];

pub async fn run(state: &AppState) -> Result<String, String> {
    let db_error = |error: sqlx::Error| format!("seed failed: {error}");
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT value FROM meta WHERE key = $1").bind(BASE_KEY).fetch_optional(&state.db).await.map_err(db_error)?;
    if existing.is_some() {
        return Ok("demo data is already present; nothing to do".to_owned());
    }
    let taken: Vec<(String,)> = sqlx::query_as("SELECT username FROM users WHERE username = ANY($1)")
        .bind(USERS.iter().map(|user| user.0.to_owned()).collect::<Vec<_>>())
        .fetch_all(&state.db)
        .await
        .map_err(db_error)?;
    if let Some((name,)) = taken.first() {
        return Err(format!("username `{name}` already exists without the seed marker; use a fresh database"));
    }
    let hash = crate::auth::hash_password(PASSWORD.to_owned()).await.map_err(|error| format!("cannot hash the demo password: {:?}", error.body))?;
    tokio::fs::create_dir_all(state.attachments_dir()).await.map_err(|error| format!("cannot create the data directory: {error}"))?;

    let base = ids::now_ms();
    let mut gen_ = Gen { base, seq: 0, per_channel: HashMap::new(), messages: 0 };
    let mut tx = state.db.begin().await.map_err(db_error)?;
    let summary = populate(state, &mut gen_, &mut tx, &hash).await.map_err(db_error)?;
    sqlx::query("INSERT INTO meta (key, value) VALUES ($1, $2)").bind(BASE_KEY).bind(base.to_string()).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(summary)
}

struct Gen {
    base: u64,
    seq: u64,
    per_channel: HashMap<i64, Vec<i64>>,
    messages: usize,
}

impl Gen {
    fn id(&mut self, age_ms: u64, worker: u64) -> i64 {
        self.seq += 1;
        ids::at(self.base - age_ms, worker, self.seq % 4096)
    }

    fn time(&self, age_ms: u64) -> OffsetDateTime {
        ts(self.base - age_ms)
    }
}

fn ts(unix_ms: u64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(unix_ms) * 1_000_000).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

#[derive(Default)]
struct New<'a> {
    channel: i64,
    author: i64,
    age_ms: u64,
    content: &'a str,
    reply: Option<(i64, i64)>,
    mentions: Vec<i64>,
    edited: bool,
    pinned: bool,
    system_kind: Option<i16>,
}

async fn add_message(gen_: &mut Gen, c: &mut PgConnection, m: New<'_>) -> Result<i64, sqlx::Error> {
    let id = gen_.id(m.age_ms, 30);
    let created = gen_.time(m.age_ms);
    let kind = m.system_kind.unwrap_or(if m.reply.is_some() { 19 } else { 0 });
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, kind, pinned, pinned_at, reference_message_id, created_at, edited_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(m.channel)
    .bind(m.author)
    .bind(m.content)
    .bind(kind)
    .bind(m.pinned)
    .bind(m.pinned.then(|| created + time::Duration::minutes(1)))
    .bind(m.reply.map(|(message, _)| message))
    .bind(created)
    .bind(m.edited.then(|| created + time::Duration::seconds(95)))
    .execute(&mut *c)
    .await?;
    let mut mentioned = m.mentions.clone();
    if let (Some((_, replied_author)), None) = (m.reply, m.system_kind)
        && replied_author != m.author
        && !mentioned.contains(&replied_author)
    {
        mentioned.push(replied_author);
    }
    for user in mentioned {
        sqlx::query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(id).bind(user).execute(&mut *c).await?;
    }
    gen_.per_channel.entry(m.channel).or_default().push(id);
    gen_.messages += 1;
    if m.pinned {
        let notice = New {
            channel: m.channel,
            author: m.author,
            age_ms: m.age_ms.saturating_sub(MINUTE),
            reply: Some((id, m.author)),
            system_kind: Some(6),
            ..New::default()
        };
        Box::pin(add_message(gen_, c, notice)).await?;
    }
    Ok(id)
}

async fn react(c: &mut PgConnection, message: i64, user: i64, emoji: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO reactions (message_id, user_id, emoji_name, emoji_id) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING")
        .bind(message)
        .bind(user)
        .bind(emoji)
        .execute(&mut *c)
        .await?;
    Ok(())
}

/// `spec` = (kind, name, topic, position, parent).
async fn add_channel(c: &mut PgConnection, guild: i64, id: i64, spec: (i16, &str, Option<&str>, i32, Option<i64>)) -> Result<(), sqlx::Error> {
    let (kind, name, topic, position, parent) = spec;
    sqlx::query("INSERT INTO channels (id, kind, guild_id, name, topic, position, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(id)
        .bind(kind)
        .bind(guild)
        .bind(name)
        .bind(topic)
        .bind(position)
        .bind(parent)
        .execute(&mut *c)
        .await?;
    Ok(())
}

async fn read_state(c: &mut PgConnection, user: i64, channel: i64, last: Option<i64>, mentions: i32) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
        .bind(user)
        .bind(channel)
        .bind(last)
        .bind(mentions)
        .execute(&mut *c)
        .await?;
    Ok(())
}

struct DmLine {
    who: usize,
    text: &'static str,
    reply: Option<usize>,
    edited: bool,
    pin: bool,
    image: bool,
    reactions: &'static [(usize, &'static str)],
}

fn line(who: usize, text: &'static str) -> DmLine {
    DmLine { who, text, reply: None, edited: false, pin: false, image: false, reactions: &[] }
}

fn dm_lines() -> Vec<DmLine> {
    // constants so the reaction slices below are promoted to 'static
    #[allow(non_upper_case_globals)]
    const r: usize = SAM;
    #[allow(non_upper_case_globals)]
    const b: usize = CAROL;
    vec![
        line(b, "yo, did you get a chance to look at the gateway notes?"),
        line(r, "yeah, reading them now"),
        line(r, "heartbeat, then resume within 3 minutes, otherwise identify again"),
        line(b, "exactly. the server keeps a ring buffer per session for replay"),
        line(r, "how big is it?"),
        DmLine { reply: Some(4), ..line(b, "1000 events, 5 minute ttl") },
        line(r, "that is plenty for a laptop lid close"),
        DmLine { reactions: &[(r, "😂")], ..line(b, "lol yes") },
        line(r, "btw can you review my branch before dinner?"),
        line(b, "sure, which one"),
        line(r, "worktree-server. mostly migrations and the permission resolver"),
        line(b, "👀 on it"),
        line(b, "the overwrite order matches discord right? everyone, roles, member"),
        line(r, "yep. deny then allow at each step"),
        line(b, "nice"),
        line(r, "also added a seed command so the desktop app has something to show"),
        DmLine { reactions: &[(r, "👍")], ..line(b, "finally, the mock data was getting stale") },
        line(r, "same people, real database"),
        line(b, "perfect"),
        line(r, "ping me when the review is done"),
        line(b, "reviewed. two nits and one actual bug"),
        line(r, "go on"),
        line(b, "the unread count resets even when you ack an older message"),
        DmLine { edited: true, ..line(r, "oh. fixed in the ack handler now") },
        line(b, "here is what I would expect:"),
        line(b, "```rust\nif acked_id >= last_message_id {\n    mention_count = 0;\n}\n```"),
        DmLine { reply: Some(22), ..line(r, "that is what it does now") },
        line(b, "ship it"),
        line(r, "will do. lunch?"),
        line(b, "give me 10"),
        line(r, "taking the dog out first, 20 min?"),
        line(b, "perfect"),
        line(b, "back"),
        line(r, "nice, ramen?"),
        DmLine { reactions: &[(r, "❤️")], ..line(b, "always") },
        line(r, "ok leaving now"),
        line(b, "see you there"),
        line(r, "table by the window"),
        line(b, "lol you got there first"),
        line(r, "obviously"),
        line(b, "the ui shell is looking good, check out the new context menus"),
        line(r, "they are so crisp"),
        DmLine { image: true, ..line(b, "screenshot from this morning") },
        DmLine { reply: Some(42), reactions: &[(b, "❤️")], ..line(r, "the unread pill is perfect") },
        line(b, "thanks! shell milestone A is merged"),
        line(r, "so what is next?"),
        line(b, "channel list and message view"),
        line(r, "wire it to the real server"),
        line(b, "yep, that is the plan. mock backend first, then swap the base url"),
        line(r, "just point it at 127.0.0.1:8710"),
        DmLine { reactions: &[(r, "👍")], ..line(b, "easy") },
        DmLine { pin: true, ..line(r, "pin for later: the gateway is at the server root, not under /api/v1") },
        line(b, "good call"),
        line(b, "oh and avatars and bios"),
        line(r, "later, after messages"),
        line(b, "agreed"),
        line(r, "i will push the seed branch tonight"),
        line(b, "i will have the client pull it tomorrow"),
        DmLine { reactions: &[(b, "🤝")], ..line(r, "deal") },
        line(b, "gn"),
        line(r, "gn!"),
    ]
}

async fn populate(state: &AppState, gen_: &mut Gen, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, hash: &str) -> Result<String, sqlx::Error> {
    let c: &mut PgConnection = &mut *tx;

    // users + presences
    let user_ids: Vec<i64> = (0..USERS.len()).map(|index| ids::at(gen_.base - 30 * DAY, 29, index as u64)).collect();
    for (index, (username, global_name, bio, banner, status, custom)) in USERS.iter().enumerate() {
        sqlx::query("INSERT INTO users (id, username, email, global_name, banner_color, bio, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)")
            .bind(user_ids[index])
            .bind(username)
            .bind(format!("{username}@vokko.local"))
            .bind(global_name)
            .bind(banner)
            .bind(bio)
            .bind(hash)
            .execute(&mut *c)
            .await?;
        sqlx::query(
            "INSERT INTO presences (user_id, status, preferred, custom_status, pinned) \
             VALUES ($1, $2, CASE WHEN $2 = 'offline' THEN 'online' ELSE $2 END, $3, TRUE)",
        )
        .bind(user_ids[index])
        .bind(status)
        .bind(custom)
        .execute(&mut *c)
        .await?;
    }
    let (sam, carol, alice, bob, nova) = (user_ids[SAM], user_ids[CAROL], user_ids[ALICE], user_ids[BOB], user_ids[NOVA]);

    // friendships (stored in both directions) and one pending request
    for (a, b) in [(sam, carol), (sam, alice), (sam, bob), (carol, alice)] {
        sqlx::query("INSERT INTO relationships (user_id, other_id, kind, created_at) VALUES ($1, $2, 1, $3), ($2, $1, 1, $3)")
            .bind(a)
            .bind(b)
            .bind(gen_.time(20 * DAY))
            .execute(&mut *c)
            .await?;
    }
    sqlx::query("INSERT INTO relationships (user_id, other_id, kind) VALUES ($1, $2, 4), ($2, $1, 3)").bind(nova).bind(sam).execute(&mut *c).await?;

    // guild
    let guild = ids::at(gen_.base - 14 * DAY, 28, 0);
    let base = gen_.base;
    let ids_of = |n: u64| ids::at(base - 14 * DAY, 28, n);
    let (cat_info, cat_text, cat_voice) = (ids_of(1), ids_of(2), ids_of(3));
    let (welcome, rules, general, dev_talk, memes, mods) = (ids_of(4), ids_of(5), ids_of(6), ids_of(7), ids_of(8), ids_of(9));
    let (lounge, gaming) = (ids_of(10), ids_of(11));
    let moderator = ids_of(12);
    sqlx::query("INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ($1, $2, $3, $4)")
        .bind(guild)
        .bind("Sam's server")
        .bind(sam)
        .bind(general)
        .execute(&mut *c)
        .await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $1, '@everyone', 0, $2)")
        .bind(guild)
        .bind(DEFAULT_EVERYONE as i64)
        .execute(&mut *c)
        .await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES ($1, $2, 'Moderator', $3, TRUE, 1, $4, TRUE)")
        .bind(moderator)
        .bind(guild)
        .bind(0x3498db_i32)
        .bind((DEFAULT_EVERYONE | MANAGE_MESSAGES | MANAGE_CHANNELS | CREATE_INSTANT_INVITE) as i64)
        .execute(&mut *c)
        .await?;
    for (index, user) in [sam, carol, alice, bob, nova].into_iter().enumerate() {
        let nick = (index == BOB).then_some("Bobby");
        sqlx::query("INSERT INTO guild_members (guild_id, user_id, nick, joined_at) VALUES ($1, $2, $3, $4)")
            .bind(guild)
            .bind(user)
            .bind(nick)
            .bind(gen_.time(13 * DAY - index as u64 * HOUR))
            .execute(&mut *c)
            .await?;
    }
    sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)").bind(guild).bind(alice).bind(moderator).execute(&mut *c).await?;

    add_channel(c, guild, cat_info, (4, "Information", None, 0, None)).await?;
    add_channel(c, guild, cat_text, (4, "Text Channels", None, 1, None)).await?;
    add_channel(c, guild, cat_voice, (4, "Voice Channels", None, 2, None)).await?;
    add_channel(c, guild, welcome, (0, "welcome", Some("Start here"), 0, Some(cat_info))).await?;
    add_channel(c, guild, rules, (0, "rules", Some("Be kind"), 1, Some(cat_info))).await?;
    add_channel(c, guild, general, (0, "general", Some("Anything goes"), 0, Some(cat_text))).await?;
    add_channel(c, guild, dev_talk, (0, "dev-talk", Some("Rust, TypeScript and build times"), 1, Some(cat_text))).await?;
    add_channel(c, guild, memes, (0, "memes", None, 2, Some(cat_text))).await?;
    add_channel(c, guild, mods, (0, "mods", Some("Moderators only"), 3, Some(cat_text))).await?;
    add_channel(c, guild, lounge, (2, "Lounge", None, 0, Some(cat_voice))).await?;
    add_channel(c, guild, gaming, (2, "Gaming", None, 1, Some(cat_voice))).await?;
    // #mods: hidden from @everyone, visible to the Moderator role
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, 0, $3), ($1, $4, 0, $3, 0)")
        .bind(mods)
        .bind(guild)
        .bind(VIEW_CHANNEL as i64)
        .bind(moderator)
        .execute(&mut *c)
        .await?;
    sqlx::query("INSERT INTO invites (code, guild_id, channel_id, inviter_id) VALUES ('vokko-dev', $1, $2, $3)")
        .bind(guild)
        .bind(general)
        .bind(sam)
        .execute(&mut *c)
        .await?;

    // guild messages (ages in minutes before the seed ran)
    let m = |channel: i64, author: i64, minutes: u64, content: &'static str| New { channel, author, age_ms: minutes * MINUTE, content, ..New::default() };
    let first = add_message(gen_, c, New { pinned: true, ..m(general, sam, 13 * 24 * 60, "welcome to the server everyone!") }).await?;
    react(c, first, alice, "🎉").await?;
    react(c, first, bob, "🎉").await?;
    react(c, first, carol, "👋").await?;
    add_message(gen_, c, m(general, alice, 13 * 24 * 60 - 5, "hi! thanks for the invite")).await?;
    add_message(gen_, c, m(general, bob, 13 * 24 * 60 - 9, "hello hello")).await?;
    add_message(gen_, c, m(general, nova, 12 * 24 * 60, "o/")).await?;
    add_message(gen_, c, m(general, carol, 10 * 24 * 60, "this is shaping up nicely")).await?;
    let split = add_message(gen_, c, m(general, sam, 6 * 24 * 60, "channels are split into information, text and voice")).await?;
    let ask = add_message(gen_, c, m(general, alice, 6 * 24 * 60 - 3, "can we get a #memes channel?")).await?;
    add_message(gen_, c, New { reply: Some((ask, alice)), ..m(general, sam, 6 * 24 * 60 - 4, "already there, check the text category") }).await?;
    react(c, split, nova, "👍").await?;
    add_message(gen_, c, m(general, bob, 2 * 24 * 60, "does anyone else's build take forever on windows?")).await?;
    add_message(gen_, c, m(general, carol, 2 * 24 * 60 - 6, "use the dev profile with opt-level 1 for deps")).await?;
    add_message(gen_, c, New { edited: true, ..m(general, bob, 2 * 24 * 60 - 10, "that helped a lot, thanks!") }).await?;
    add_message(gen_, c, m(general, nova, 3 * 60, "is the server open source?")).await?;
    let mention = format!("<@{sam}> when is the next build going out?");
    add_message(gen_, c, New { channel: general, author: bob, age_ms: 25 * MINUTE, content: &mention, mentions: vec![sam], ..New::default() }).await?;

    add_message(gen_, c, m(welcome, sam, 13 * 24 * 60, "Welcome to Sam's server. Say hi in #general.")).await?;
    add_message(gen_, c, m(rules, sam, 13 * 24 * 60 - 2, "1. Be kind. 2. No spam. 3. Have fun.")).await?;

    let dev = [
        (carol, 5 * 24 * 60, "does the gateway replay survive a reconnect?"),
        (sam, 5 * 24 * 60 - 2, "yes, up to 1000 events or 5 minutes"),
        (alice, 4 * 24 * 60, "typescript types are generated from the same contract, right?"),
        (carol, 4 * 24 * 60 - 7, "hand-written for now, with a fixture test on both sides"),
        (bob, 90, "cargo test is green on my machine"),
        (sam, 80, "mine too, merging"),
    ];
    for (author, minutes, text) in dev {
        add_message(gen_, c, New { channel: dev_talk, author, age_ms: minutes * MINUTE, content: text, ..New::default() }).await?;
    }
    for (author, minutes, text) in
        [(alice, 24 * 60, "when I said no meetings I meant it"), (bob, 24 * 60 - 3, "relatable"), (nova, 400, "this one is a classic"), (carol, 399, "lmao")]
    {
        add_message(gen_, c, New { channel: memes, author, age_ms: minutes * MINUTE, content: text, ..New::default() }).await?;
    }
    for (author, minutes, text) in [(alice, 3 * 24 * 60, "reminder: new members need a welcome"), (sam, 3 * 24 * 60 - 5, "on it")] {
        add_message(gen_, c, New { channel: mods, author, age_ms: minutes * MINUTE, content: text, ..New::default() }).await?;
    }

    // DM sam <-> carol
    let dm = ids::at(gen_.base - 3 * DAY, 27, 0);
    sqlx::query("INSERT INTO channels (id, kind) VALUES ($1, 1)").bind(dm).execute(&mut *c).await?;
    for user in [sam, carol] {
        sqlx::query("INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2)").bind(dm).bind(user).execute(&mut *c).await?;
    }
    let lines = dm_lines();
    let mut dm_ids: Vec<i64> = Vec::with_capacity(lines.len());
    for (index, l) in lines.iter().enumerate() {
        let chunk = (index / 20) as u64;
        let within = (index % 20) as u64;
        let age_ms = (3 - chunk) * DAY + (20 - within) * 3 * MINUTE + 15 * MINUTE;
        let author = user_ids[l.who];
        let reply = l.reply.map(|target| (dm_ids[target], user_ids[lines[target].who]));
        let id = add_message(gen_, c, New { channel: dm, author, age_ms, content: l.text, reply, edited: l.edited, pinned: l.pin, ..New::default() }).await?;
        for (who, emoji) in l.reactions {
            react(c, id, user_ids[*who], emoji).await?;
        }
        if l.image {
            let attachment = ids::at(gen_.base - age_ms, 26, 0);
            let png = demo_png(256, 144);
            tokio::fs::write(media::file_path(state, attachment), &png).await.map_err(sqlx::Error::Io)?;
            sqlx::query(
                "INSERT INTO attachments (id, channel_id, uploader_id, message_id, filename, content_type, size, width, height, key) \
                 VALUES ($1, $2, $3, $4, 'vokko-shell.png', 'image/png', $5, 256, 144, $6)",
            )
            .bind(attachment)
            .bind(dm)
            .bind(author)
            .bind(id)
            .bind(png.len() as i64)
            .bind(media::new_key())
            .execute(&mut *c)
            .await?;
        }
        dm_ids.push(id);
    }

    // DM alice -> sam, unread for sam
    let dm_alice = ids::at(gen_.base - DAY, 27, 1);
    sqlx::query("INSERT INTO channels (id, kind) VALUES ($1, 1)").bind(dm_alice).execute(&mut *c).await?;
    for user in [alice, sam] {
        sqlx::query("INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2)").bind(dm_alice).bind(user).execute(&mut *c).await?;
    }
    for (minutes, text) in [(120, "hey, are you around?"), (118, "wanted to ask about the mod permissions"), (117, "no rush!")] {
        add_message(gen_, c, New { channel: dm_alice, author: alice, age_ms: minutes * MINUTE, content: text, ..New::default() }).await?;
    }

    // last_message_id per channel
    let last: Vec<(i64, i64)> = gen_.per_channel.iter().filter_map(|(channel, messages)| messages.last().map(|id| (*channel, *id))).collect();
    for (channel, message) in last {
        sqlx::query("UPDATE channels SET last_message_id = $2 WHERE id = $1").bind(channel).bind(message).execute(&mut *c).await?;
    }

    // read states: everyone has read everything except a few demo unreads
    let tail = |gen_: &Gen, channel: i64, from_end: usize| -> Option<i64> {
        let messages = gen_.per_channel.get(&channel)?;
        messages.len().checked_sub(from_end + 1).and_then(|index| messages.get(index)).copied()
    };
    let latest = |gen_: &Gen, channel: i64| tail(gen_, channel, 0);
    for channel in [welcome, rules, general, dev_talk, memes, lounge, gaming] {
        for user in [sam, carol, alice, bob, nova] {
            let (last_read, mentions) = match (user == sam, channel) {
                (true, ch) if ch == general => (tail(gen_, general, 1), 1),
                (true, ch) if ch == dev_talk => (tail(gen_, dev_talk, 2), 0),
                _ => (latest(gen_, channel), 0),
            };
            read_state(c, user, channel, last_read, mentions).await?;
        }
    }
    for user in [sam, alice] {
        read_state(c, user, mods, latest(gen_, mods), 0).await?;
    }
    for user in [sam, carol] {
        read_state(c, user, dm, latest(gen_, dm), 0).await?;
    }
    read_state(c, alice, dm_alice, latest(gen_, dm_alice), 0).await?;
    read_state(c, sam, dm_alice, None, 3).await?;

    Ok(format!("seeded {} users, 1 guild, {} messages (DM sam/carol: {}); log in as sam / {PASSWORD}", USERS.len(), gen_.messages, dm_ids.len()))
}

// ---- demo image ----

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1_u32, 0_u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

/// A small RGB gradient, written with stored (uncompressed) deflate blocks so no codec is needed.
pub fn demo_png(width: u32, height: u32) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width as usize * 3 + 1) * height as usize);
    for y in 0..height {
        raw.push(0);
        for x in 0..width {
            raw.push((x * 255 / (width - 1)) as u8);
            raw.push((y * 255 / (height - 1)) as u8);
            raw.push(160 + ((x + y) % 64) as u8);
        }
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (index, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(index + 1 == blocks.len()));
        zlib.extend_from_slice(&(block.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    png_chunk(&mut png, b"IHDR", &header);
    png_chunk(&mut png, b"IDAT", &zlib);
    png_chunk(&mut png, b"IEND", &[]);
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_png_is_a_png_of_the_requested_size() {
        let png = demo_png(256, 144);
        let sniffed = media::sniff_image(&png).expect("recognised as an image");
        assert_eq!((sniffed.content_type, sniffed.width, sniffed.height), ("image/png", 256, 144));
    }

    #[test]
    fn checksums_match_known_values() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }

    #[test]
    fn dm_script_has_about_sixty_lines_and_valid_replies() {
        let lines = dm_lines();
        assert!(lines.len() >= 60);
        for (index, l) in lines.iter().enumerate() {
            assert!(l.reply.is_none_or(|target| target < index), "line {index} replies to a later line");
        }
    }
}
