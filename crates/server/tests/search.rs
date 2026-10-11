#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Message search: filters, pagination, ordering and permission filtering (REST-001).
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

const VIEW_CHANNEL: u64 = 1 << 10;
const READ_MESSAGE_HISTORY: u64 = 1 << 16;

struct World {
    app: TestApp,
    owner: String,
    member: String,
    outsider: String,
    owner_id: String,
    member_id: String,
    guild: String,
    general: String,
}

async fn world() -> World {
    let app = TestApp::new().await;
    let (owner, owner_user) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (outsider, _) = app.register("bob").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    World {
        owner,
        member,
        outsider,
        owner_id: owner_user["id"].as_str().expect("id").to_owned(),
        member_id: member_user["id"].as_str().expect("id").to_owned(),
        guild,
        general,
        app,
    }
}

impl World {
    async fn say(&self, token: &str, channel: &str, content: &str) -> Value {
        let (status, message) = self.app.post(&format!("/channels/{channel}/messages"), token, json!({"content": content})).await;
        assert_eq!(status, StatusCode::OK, "{message}");
        message
    }

    /// A text channel whose @everyone overwrite denies `deny`.
    async fn locked_channel(&self, name: &str, deny: u64) -> String {
        let body = json!({"name": name, "type": 0, "permission_overwrites": [{"id": self.guild, "type": 0, "allow": "0", "deny": deny.to_string()}]});
        let (status, channel) = self.app.post(&format!("/guilds/{}/channels", self.guild), &self.owner, body).await;
        assert_eq!(status, StatusCode::OK, "{channel}");
        channel["id"].as_str().expect("id").to_owned()
    }

    async fn guild_search(&self, token: &str, query: &str) -> Value {
        let (status, body) = self.app.get(&format!("/guilds/{}/messages/search?{query}", self.guild), token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn channel_search(&self, token: &str, channel: &str, query: &str) -> Value {
        let (status, body) = self.app.get(&format!("/channels/{channel}/messages/search?{query}"), token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
}

fn ids(result: &Value) -> Vec<String> {
    result["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|hit| {
            let hit = hit.as_array().expect("hit array");
            assert_eq!(hit.len(), 1, "each hit is a one-element array");
            hit[0]["id"].as_str().expect("id").to_owned()
        })
        .collect()
}

fn id_of(message: &Value) -> String {
    message["id"].as_str().expect("id").to_owned()
}

#[tokio::test]
async fn words_match_case_insensitively_and_swedish_letters_work() {
    let w = world().await;
    let hello = w.say(&w.owner, &w.general, "Hello wonderful World").await;
    let swedish = w.say(&w.member, &w.general, "Räksmörgås åäö på bordet").await;
    w.say(&w.member, &w.general, "unrelated chatter").await;

    let found = w.guild_search(&w.member, "content=WORLD").await;
    assert_eq!((found["total_results"].as_u64(), ids(&found)), (Some(1), vec![id_of(&hello)]));
    let all_words = w.guild_search(&w.member, "content=hello%20world").await;
    assert_eq!(ids(&all_words), vec![id_of(&hello)]);
    let none = w.guild_search(&w.member, "content=hello%20bordet").await;
    assert_eq!(none["total_results"], 0);
    // Word level, not substring.
    assert_eq!(w.guild_search(&w.member, "content=wonder").await["total_results"], 0);

    let swedish_hit = w.guild_search(&w.member, "content=%C3%A5%C3%A4%C3%B6").await;
    assert_eq!(ids(&swedish_hit), vec![id_of(&swedish)]);
    let upper = w.guild_search(&w.member, "content=R%C3%84KSM%C3%96RG%C3%85S").await;
    assert_eq!(ids(&upper), vec![id_of(&swedish)]);
    // Phrase and exclusion follow websearch syntax.
    assert_eq!(ids(&w.guild_search(&w.member, "content=%22p%C3%A5%20bordet%22").await), vec![id_of(&swedish)]);
    assert_eq!(w.guild_search(&w.member, "content=%22bordet%20p%C3%A5%22").await["total_results"], 0);
    assert_eq!(w.guild_search(&w.member, "content=hello%20-world").await["total_results"], 0);
}

#[tokio::test]
async fn filters_author_mentions_has_pinned_and_id_range() {
    let w = world().await;
    let first = w.say(&w.owner, &w.general, "alpha plain").await;
    let link = w.say(&w.member, &w.general, "alpha see https://example.test/page").await;
    let mention = w.say(&w.owner, &w.general, &format!("alpha hello <@{}>", w.member_id)).await;
    let last = w.say(&w.member, &w.general, "alpha last").await;

    let by_member = w.guild_search(&w.owner, &format!("author_id={}", w.member_id)).await;
    assert_eq!(ids(&by_member), vec![id_of(&last), id_of(&link)]);
    let both = w.guild_search(&w.owner, &format!("author_id={}&author_id={}", w.member_id, w.owner_id)).await;
    assert_eq!(both["total_results"], 4);

    let mentioned = w.guild_search(&w.owner, &format!("mentions={}", w.member_id)).await;
    assert_eq!(ids(&mentioned), vec![id_of(&mention)]);

    assert_eq!(ids(&w.guild_search(&w.owner, "has=link").await), vec![id_of(&link)]);
    assert_eq!(w.guild_search(&w.owner, "has=link&has=image").await["total_results"], 0);
    assert_eq!(w.guild_search(&w.owner, "has=sticker").await["total_results"], 0);

    // Attachments and embeds are inserted directly: uploading needs the multipart flow, which has its own tests.
    let image_message = w.say(&w.owner, &w.general, "alpha picture").await;
    let (message_id, owner_id, channel_id): (i64, i64, i64) = (id_of(&image_message).parse().unwrap(), w.owner_id.parse().unwrap(), w.general.parse().unwrap());
    sqlx::query(
        "INSERT INTO attachments (id, channel_id, uploader_id, message_id, filename, content_type, size, key) VALUES ($1, $2, $3, $4, 'cat.png', 'image/png', 10, 'k')",
    )
    .bind(message_id + 1)
    .bind(channel_id)
    .bind(owner_id)
    .bind(message_id)
    .execute(&w.app.state.db)
    .await
    .unwrap();
    assert_eq!(ids(&w.guild_search(&w.owner, "has=image").await), vec![id_of(&image_message)]);
    assert_eq!(ids(&w.guild_search(&w.owner, "has=file").await), vec![id_of(&image_message)]);
    assert_eq!(w.guild_search(&w.owner, "has=video").await["total_results"], 0);
    sqlx::query("UPDATE messages SET embeds = '[{\"type\": \"video\"}]'::jsonb WHERE id = $1").bind(message_id).execute(&w.app.state.db).await.unwrap();
    assert_eq!(ids(&w.guild_search(&w.owner, "has=embed").await), vec![id_of(&image_message)]);
    assert_eq!(ids(&w.guild_search(&w.owner, "has=video").await), vec![id_of(&image_message)]);

    // Pinning adds a type 6 notice that is not searchable.
    assert_eq!(w.app.put(&format!("/channels/{}/messages/pins/{}", w.general, id_of(&first)), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(ids(&w.guild_search(&w.owner, "pinned=true").await), vec![id_of(&first)]);
    assert_eq!(w.guild_search(&w.owner, "pinned=false").await["total_results"], 4);
    assert_eq!(w.guild_search(&w.owner, &format!("author_id={}", w.owner_id)).await["total_results"], 3, "the pin notice is not a result");

    // min_id / max_id are exclusive.
    let after = w.guild_search(&w.owner, &format!("content=alpha&min_id={}", id_of(&link))).await;
    assert_eq!(ids(&after), vec![id_of(&image_message), id_of(&last), id_of(&mention)]);
    let before = w.guild_search(&w.owner, &format!("content=alpha&max_id={}&sort_order=asc", id_of(&mention))).await;
    assert_eq!(ids(&before), vec![id_of(&first), id_of(&link)]);
}

#[tokio::test]
async fn pagination_order_and_limits() {
    let w = world().await;
    let mut sent = Vec::new();
    for index in 0..30 {
        sent.push(id_of(&w.say(&w.owner, &w.general, &format!("pagetest number {index}")).await));
    }
    let page = w.guild_search(&w.member, "content=pagetest").await;
    assert_eq!(page["total_results"], 30);
    let newest_first: Vec<String> = sent.iter().rev().cloned().collect();
    assert_eq!(ids(&page), newest_first[..25]);

    let rest = w.guild_search(&w.member, "content=pagetest&offset=25").await;
    assert_eq!((rest["total_results"].as_u64(), ids(&rest)), (Some(30), newest_first[25..].to_vec()));
    let oldest = w.guild_search(&w.member, "content=pagetest&sort_order=asc&limit=3").await;
    assert_eq!(ids(&oldest), sent[..3]);
    assert_eq!(w.guild_search(&w.member, "content=pagetest&offset=9975").await["messages"], json!([]));

    // Relevance: the message that repeats the term ranks first.
    let weak = w.say(&w.owner, &w.general, "rankme once with many other words around it here today").await;
    let strong = w.say(&w.owner, &w.general, "rankme rankme rankme").await;
    let ranked = w.guild_search(&w.member, "content=rankme&sort_by=relevance").await;
    assert_eq!(ids(&ranked), vec![id_of(&strong), id_of(&weak)]);

    for bad in ["limit=26", "limit=0", "offset=9976", "has=gif", "min_id=nope"] {
        let (status, error) = w.app.get(&format!("/guilds/{}/messages/search?{bad}", w.guild), &w.member).await;
        assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)), "{bad}");
    }
}

#[tokio::test]
async fn only_readable_channels_are_searched_and_counted() {
    let w = world().await;
    let private = w.locked_channel("private", VIEW_CHANNEL).await;
    let no_history = w.locked_channel("no-history", READ_MESSAGE_HISTORY).await;
    let open = w.say(&w.owner, &w.general, "needle in the open").await;
    let hidden = w.say(&w.owner, &private, "needle in private").await;
    let blind = w.say(&w.owner, &no_history, "needle without history").await;

    let owner = w.guild_search(&w.owner, "content=needle").await;
    assert_eq!(owner["total_results"], 3);
    let member = w.guild_search(&w.member, "content=needle").await;
    assert_eq!((member["total_results"].as_u64(), ids(&member)), (Some(1), vec![id_of(&open)]));
    // Asking for a channel the caller cannot read just finds nothing; counts do not leak it.
    let probe = w.guild_search(&w.member, &format!("content=needle&channel_id={private}&channel_id={no_history}")).await;
    assert_eq!((probe["total_results"].as_u64(), ids(&probe).len()), (Some(0), 0));
    assert!(!ids(&member).contains(&id_of(&hidden)) && !ids(&member).contains(&id_of(&blind)));

    // The channel route: no VIEW_CHANNEL is 403 50001, no READ_MESSAGE_HISTORY is an empty result.
    let (status, error) = w.app.get(&format!("/channels/{private}/messages/search?content=needle"), &w.member).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)));
    assert_eq!(w.channel_search(&w.member, &no_history, "content=needle").await["total_results"], 0);
    assert_eq!(w.channel_search(&w.owner, &no_history, "content=needle").await["total_results"], 1);
    assert_eq!(ids(&w.channel_search(&w.member, &w.general, "content=needle").await), vec![id_of(&open)]);

    // Not a member of the guild.
    let (status, error) = w.app.get(&format!("/guilds/{}/messages/search?content=needle", w.guild), &w.outsider).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)));
    let (status, _) = w.app.get(&format!("/channels/{}/messages/search?content=needle", w.general), &w.outsider).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = w.app.get("/guilds/999/messages/search", &w.member).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn direct_messages_are_searchable_by_participants_only() {
    let w = world().await;
    let (status, dm) = w.app.post("/users/@me/channels", &w.owner, json!({"recipient_id": w.member_id})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = dm["id"].as_str().expect("id").to_owned();
    let secret = w.say(&w.owner, &dm, "midsommar plans").await;
    w.say(&w.owner, &w.general, "midsommar in the guild").await;

    let mine = w.channel_search(&w.member, &dm, "content=midsommar").await;
    assert_eq!(ids(&mine), vec![id_of(&secret)]);
    let (status, error) = w.app.get(&format!("/channels/{dm}/messages/search?content=midsommar"), &w.outsider).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)));
    // Guild search never reaches DMs.
    assert_eq!(w.guild_search(&w.owner, "content=midsommar").await["total_results"], 1);
}

#[tokio::test]
async fn edits_and_deletes_are_reflected() {
    let w = world().await;
    let message = w.say(&w.owner, &w.general, "before edit").await;
    let mid = id_of(&message);
    assert_eq!(w.guild_search(&w.owner, "content=after").await["total_results"], 0);
    let (status, _) = w.app.patch(&format!("/channels/{}/messages/{mid}", w.general), &w.owner, json!({"content": "after edit"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&w.guild_search(&w.owner, "content=after").await), vec![mid.clone()]);
    assert_eq!(w.guild_search(&w.owner, "content=before").await["total_results"], 0);
    assert_eq!(w.app.delete(&format!("/channels/{}/messages/{mid}", w.general), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.guild_search(&w.owner, "content=after").await["total_results"], 0);
}
