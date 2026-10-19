#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Polls: creating, voting (single choice moves, multiselect), voters, permissions, editing, End Poll Now, the expiry sweep and its races.
mod common;
mod support_threads;

use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support_threads::{Client, Member, World, code, world};
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, READ_MESSAGE_HISTORY, SEND_POLLS};

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

fn poll_body(answers: &[&str], multiselect: bool) -> Value {
    json!({"poll": {
        "question": {"text": "Lunch?"},
        "answers": answers.iter().map(|text| json!({"poll_media": {"text": text}})).collect::<Vec<_>>(),
        "duration": 4,
        "allow_multiselect": multiselect
    }})
}

fn counts(message: &Value) -> Vec<(u64, bool)> {
    message["poll"]["results"]["answer_counts"]
        .as_array()
        .expect("answer_counts")
        .iter()
        .map(|count| (count["count"].as_u64().expect("count"), count["me_voted"].as_bool().expect("me_voted")))
        .collect()
}

fn field<'a>(embed: &'a Value, name: &str) -> Option<&'a str> {
    embed["fields"].as_array()?.iter().find(|field| field["name"] == name)?["value"].as_str()
}

impl World {
    async fn poll(&self, user: &Member, answers: &[&str], multiselect: bool) -> Value {
        let (status, message) = self.app.post(&format!("/channels/{}/messages", self.general), &user.token, poll_body(answers, multiselect)).await;
        assert_eq!(status, StatusCode::OK, "create poll: {message}");
        message
    }

    fn answer_path(&self, poll: &str, answer: u32) -> String {
        format!("/channels/{}/polls/{poll}/answers/{answer}/@me", self.general)
    }

    async fn vote(&self, user: &Member, poll: &str, answer: u32) -> (StatusCode, Value) {
        self.app.put(&self.answer_path(poll, answer), &user.token).await
    }

    async fn unvote(&self, user: &Member, poll: &str, answer: u32) -> (StatusCode, Value) {
        self.app.delete(&self.answer_path(poll, answer), &user.token).await
    }

    async fn expire(&self, user: &Member, poll: &str) -> (StatusCode, Value) {
        self.app.post(&format!("/channels/{}/polls/{poll}/expire", self.general), &user.token, json!({})).await
    }

    async fn message(&self, user: &Member, mid: &str) -> Value {
        self.messages(&self.general, user).await.into_iter().find(|message| message["id"] == mid).expect("message listed")
    }

    async fn results(&self, mid: &str) -> Vec<Value> {
        self.messages(&self.general, &self.owner)
            .await
            .into_iter()
            .filter(|message| message["type"] == 46 && message["message_reference"]["message_id"] == mid)
            .collect()
    }

    async fn backdate(&self, poll: &str) {
        sqlx::query("UPDATE polls SET expiry = now() - interval '1 second' WHERE message_id = $1")
            .bind(poll.parse::<i64>().expect("poll id"))
            .execute(&self.app.state.db)
            .await
            .expect("backdate");
    }

    /// A fresh member of the guild.
    async fn joiner(&self, name: &str) -> Member {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.general), &self.owner.token, json!({})).await;
        let invite = invite["code"].as_str().expect("code");
        assert_eq!(self.app.post(&format!("/invites/{invite}"), &token, json!({})).await.0, StatusCode::OK);
        Member { token, id: user["id"].as_str().expect("id").to_owned() }
    }
}

#[tokio::test]
async fn a_poll_is_created_voted_on_and_counted_per_viewer() {
    let w = world().await;
    let mut alice_gw = Client::connect(&w.address, &w.alice.token).await;
    let mut owner_gw = Client::connect(&w.address, &w.owner.token).await;

    let created = w.poll(&w.owner, &["Pizza", "Sushi"], false).await;
    let mid = id(&created);
    let poll = &created["poll"];
    assert_eq!(poll["question"]["text"], "Lunch?");
    assert_eq!((poll["answers"][0]["answer_id"].as_u64(), poll["answers"][1]["poll_media"]["text"].as_str()), (Some(1), Some("Sushi")));
    assert_eq!(
        (poll["allow_multiselect"].as_bool(), poll["layout_type"].as_u64(), poll["results"]["is_finalized"].as_bool()),
        (Some(false), Some(1), Some(false))
    );
    assert_eq!(created["content"], "", "content is optional next to a poll");
    let expiry = time::OffsetDateTime::parse(poll["expiry"].as_str().expect("expiry"), &time::format_description::well_known::Rfc3339).expect("iso");
    let hours = (expiry - time::OffsetDateTime::now_utc()).whole_minutes();
    assert!((235..=240).contains(&hours), "4 hour duration, got {hours} minutes");
    let pushed = alice_gw.wait_id("MESSAGE_CREATE", &mid).await;
    assert_eq!(counts(&pushed), vec![(0, false), (0, false)]);

    assert_eq!(w.vote(&w.alice, &mid, 1).await.0, StatusCode::NO_CONTENT);
    let event = owner_gw.wait_match("MESSAGE_POLL_VOTE_ADD", |data| data["message_id"] == mid.as_str()).await;
    assert_eq!(
        (event["user_id"].as_str(), event["answer_id"].as_u64(), event["channel_id"].as_str(), event["guild_id"].as_str()),
        (Some(w.alice.id.as_str()), Some(1), Some(w.general.as_str()), Some(w.guild.as_str()))
    );
    assert_eq!(counts(&w.message(&w.alice, &mid).await), vec![(1, true), (0, false)]);
    assert_eq!(counts(&w.message(&w.owner, &mid).await), vec![(1, false), (0, false)]);

    let (status, voters) = w.app.get(&format!("/channels/{}/polls/{mid}/answers/1", w.general), &w.carol.token).await;
    assert_eq!(status, StatusCode::OK, "{voters}");
    let voter_ids: Vec<&str> = voters["users"].as_array().expect("users").iter().map(|user| user["id"].as_str().expect("id")).collect();
    assert_eq!(voter_ids, vec![w.alice.id.as_str()]);
    let (_, empty) = w.app.get(&format!("/channels/{}/polls/{mid}/answers/2", w.general), &w.carol.token).await;
    assert_eq!(empty["users"], json!([]));

    // bad answers and bad polls
    let (status, error) = w.vote(&w.alice, &mid, 3).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let plain = w.say(&w.general, &w.owner, "not a poll").await;
    assert_eq!(w.vote(&w.alice, &id(&plain), 1).await.0, StatusCode::NOT_FOUND);
    for body in [
        poll_body(&[], false),
        poll_body(&["a"; 11], false),
        poll_body(&[&"x".repeat(56)], false),
        json!({"poll": {"question": {"text": ""}, "answers": [{"poll_media": {"text": "a"}}]}}),
        json!({"poll": {"question": {"text": "q"}, "answers": [{"poll_media": {"text": "a"}}], "duration": 769}}),
    ] {
        let (status, error) = w.app.post(&format!("/channels/{}/messages", w.general), &w.owner.token, body).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");
    }
    let upload = w.upload_png(&w.general, &w.owner, "a.png").await;
    let mut with_file = poll_body(&["a"], false);
    with_file["attachment_ids"] = json!([upload]);
    assert_eq!(w.app.post(&format!("/channels/{}/messages", w.general), &w.owner.token, with_file).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn single_choice_moves_the_vote_and_multiselect_keeps_both() {
    let w = world().await;
    let mut gw = Client::connect(&w.address, &w.owner.token).await;
    let single = id(&w.poll(&w.owner, &["A", "B", "C"], false).await);

    assert_eq!(w.vote(&w.alice, &single, 1).await.0, StatusCode::NO_CONTENT);
    gw.wait_match("MESSAGE_POLL_VOTE_ADD", |data| data["answer_id"] == 1).await;
    assert_eq!(w.vote(&w.alice, &single, 2).await.0, StatusCode::NO_CONTENT);
    let removed = gw.wait_match("MESSAGE_POLL_VOTE_REMOVE", |data| data["message_id"] == single.as_str()).await;
    assert_eq!(removed["answer_id"], 1);
    let added = gw.wait_match("MESSAGE_POLL_VOTE_ADD", |data| data["message_id"] == single.as_str()).await;
    assert_eq!(added["answer_id"], 2);
    assert_eq!(counts(&w.message(&w.alice, &single).await), vec![(0, false), (1, true), (0, false)]);

    // repeating a vote changes nothing and sends nothing
    assert_eq!(w.vote(&w.alice, &single, 2).await.0, StatusCode::NO_CONTENT);
    assert!(gw.silent_for("MESSAGE_POLL_VOTE_ADD", Duration::from_millis(300), |_| true).await);

    // removing it
    assert_eq!(w.unvote(&w.alice, &single, 2).await.0, StatusCode::NO_CONTENT);
    gw.wait_match("MESSAGE_POLL_VOTE_REMOVE", |data| data["answer_id"] == 2).await;
    assert_eq!(w.unvote(&w.alice, &single, 2).await.0, StatusCode::NO_CONTENT, "removing a missing vote is a no-op");
    assert_eq!(counts(&w.message(&w.alice, &single).await), vec![(0, false), (0, false), (0, false)]);

    let multi = id(&w.poll(&w.owner, &["A", "B", "C"], true).await);
    for answer in [1, 3] {
        assert_eq!(w.vote(&w.alice, &multi, answer).await.0, StatusCode::NO_CONTENT);
    }
    assert_eq!(w.vote(&w.carol, &multi, 3).await.0, StatusCode::NO_CONTENT);
    assert_eq!(counts(&w.message(&w.alice, &multi).await), vec![(1, true), (0, false), (2, true)]);
    assert_eq!(counts(&w.message(&w.carol, &multi).await), vec![(1, false), (0, false), (2, true)]);
}

#[tokio::test]
async fn permissions_gate_creating_voting_and_ending() {
    let w = world().await;
    let mid = id(&w.poll(&w.owner, &["A", "B"], false).await);

    // SEND_POLLS is needed in guild channels; plain messages still go through
    w.set_everyone(DEFAULT_EVERYONE & !SEND_POLLS).await;
    let (status, error) = w.app.post(&format!("/channels/{}/messages", w.general), &w.alice.token, poll_body(&["a"], false)).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    w.say(&w.general, &w.alice, "still talking").await;

    // votes need READ_MESSAGE_HISTORY, and so does the voter list
    w.set_everyone(DEFAULT_EVERYONE & !READ_MESSAGE_HISTORY).await;
    assert_eq!(w.vote(&w.alice, &mid, 1).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.get(&format!("/channels/{}/polls/{mid}/answers/1", w.general), &w.alice.token).await.0, StatusCode::FORBIDDEN);
    w.set_everyone(DEFAULT_EVERYONE).await;

    // outsiders can't see the channel at all
    assert_eq!(w.vote(&w.bob, &mid, 1).await.0, StatusCode::FORBIDDEN);

    // a timed-out member can't vote (or take a vote back), like they can't send
    assert_eq!(w.vote(&w.carol, &mid, 1).await.0, StatusCode::NO_CONTENT);
    let until = (time::OffsetDateTime::now_utc() + time::Duration::days(1)).format(&time::format_description::well_known::Rfc3339).expect("fmt");
    let (status, member) =
        w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.carol.id), &w.owner.token, json!({"communication_disabled_until": until})).await;
    assert_eq!(status, StatusCode::OK, "timeout: {member}");
    for (status, error) in [w.vote(&w.carol, &mid, 2).await, w.unvote(&w.carol, &mid, 1).await] {
        assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    }
    assert_eq!(w.app.post(&format!("/channels/{}/messages", w.general), &w.carol.token, json!({"content": "hi"})).await.0, StatusCode::FORBIDDEN);
    let (status, _) = w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.carol.id), &w.owner.token, json!({"communication_disabled_until": null})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(w.unvote(&w.carol, &mid, 1).await.0, StatusCode::NO_CONTENT, "the timeout is over");

    // polls can't be edited, and only the author ends one
    let (status, error) = w.app.patch(&format!("/channels/{}/messages/{mid}", w.general), &w.owner.token, json!({"content": "edited"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(520003)));
    let (status, error) = w.expire(&w.alice, &mid).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50005)));
    let plain = w.say(&w.general, &w.owner, "plain").await;
    let (status, error) = w.expire(&w.owner, &id(&plain)).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(520006)));

    // DMs need no extra permission
    let (status, dm) = w.app.post("/users/@me/channels", &w.alice.token, json!({"recipient_id": w.carol.id})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let (status, message) = w.app.post(&format!("/channels/{}/messages", id(&dm)), &w.alice.token, poll_body(&["yes", "no"], false)).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let (status, _) = w.app.put(&format!("/channels/{}/polls/{}/answers/2/@me", id(&dm), id(&message)), &w.carol.token).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn end_poll_now_finalises_once_and_posts_the_result() {
    let w = world().await;
    let mut gw = Client::connect(&w.address, &w.alice.token).await;
    let created = w.poll(&w.owner, &["Pizza", "Sushi"], false).await;
    let mid = id(&created);
    w.vote(&w.alice, &mid, 2).await;
    w.vote(&w.carol, &mid, 2).await;
    w.vote(&w.owner, &mid, 1).await;

    let (status, ended) = w.expire(&w.owner, &mid).await;
    assert_eq!(status, StatusCode::OK, "{ended}");
    assert_eq!(ended["poll"]["results"]["is_finalized"], true);
    assert_eq!(counts(&ended), vec![(1, true), (2, false)]);
    let update = gw.wait_match("MESSAGE_UPDATE", |data| data["id"] == mid.as_str()).await;
    assert_eq!((update["poll"]["results"]["is_finalized"].as_bool(), counts(&update)), (Some(true), vec![(1, false), (2, true)]));
    let result = gw.wait_match("MESSAGE_CREATE", |data| data["type"] == 46).await;
    assert_eq!((result["author"]["id"].as_str(), result["message_reference"]["message_id"].as_str()), (Some(w.owner.id.as_str()), Some(mid.as_str())));
    let embed = &result["embeds"][0];
    assert_eq!(embed["type"], "poll_result");
    assert_eq!(
        (field(embed, "poll_question_text"), field(embed, "total_votes"), field(embed, "victor_answer_id"), field(embed, "victor_answer_text")),
        (Some("Lunch?"), Some("3"), Some("2"), Some("Sushi"))
    );
    assert_eq!(field(embed, "victor_answer_votes"), Some("2"));

    // ended: no more votes, no second end, and the sweep has nothing to do
    let (status, error) = w.vote(&w.alice, &mid, 1).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(520001)));
    let (status, error) = w.unvote(&w.alice, &mid, 2).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(520001)));
    assert_eq!(code(&w.expire(&w.owner, &mid).await.1), Some(520001));
    assert_eq!(vokko_server::polls::sweep_expired(&w.app.state).await.expect("sweep"), 0);
    assert_eq!(w.results(&mid).await.len(), 1, "exactly one result message");
    assert_eq!(counts(&w.message(&w.alice, &mid).await), vec![(1, false), (2, true)]);
}

#[tokio::test]
async fn the_sweep_ends_expired_polls_once_and_ties_have_no_winner() {
    let w = world().await;
    let mid = id(&w.poll(&w.owner, &["A", "B"], false).await);
    let open = id(&w.poll(&w.owner, &["A", "B"], false).await);
    w.vote(&w.alice, &mid, 1).await;
    w.vote(&w.carol, &mid, 2).await;
    w.backdate(&mid).await;

    // past expiry, before the sweep: votes are already refused
    let (status, error) = w.vote(&w.owner, &mid, 1).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(520001)));
    assert_eq!(w.message(&w.owner, &mid).await["poll"]["results"]["is_finalized"], false);

    assert_eq!(vokko_server::polls::sweep_expired(&w.app.state).await.expect("sweep"), 1);
    assert_eq!(vokko_server::polls::sweep_expired(&w.app.state).await.expect("sweep"), 0);
    let results = w.results(&mid).await;
    assert_eq!(results.len(), 1);
    let embed = &results[0]["embeds"][0];
    assert_eq!((field(embed, "total_votes"), field(embed, "victor_answer_id")), (Some("2"), None), "a tie names no winner");
    assert_eq!(w.message(&w.owner, &mid).await["poll"]["results"]["is_finalized"], true);
    assert_eq!(w.message(&w.owner, &open).await["poll"]["results"]["is_finalized"], false, "unexpired polls stay open");
    assert!(w.results(&open).await.is_empty());

    // a deleted poll leaves nothing for the sweep
    let gone = id(&w.poll(&w.owner, &["A"], false).await);
    w.backdate(&gone).await;
    assert_eq!(w.app.delete(&format!("/channels/{}/messages/{gone}", w.general), &w.owner.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(vokko_server::polls::sweep_expired(&w.app.state).await.expect("sweep"), 0);
}

#[tokio::test]
async fn votes_racing_the_end_are_either_counted_or_refused() {
    let w = world().await;
    let mut voters = Vec::new();
    for index in 0..12 {
        voters.push(w.joiner(&format!("voter{index}")).await);
    }
    let mid = id(&w.poll(&w.owner, &["A", "B"], true).await);

    let votes = futures_util::future::join_all(voters.iter().enumerate().map(|(index, voter)| w.vote(voter, &mid, 1 + (index % 2) as u32)));
    let (votes, (status, ended)) = tokio::join!(votes, w.expire(&w.owner, &mid));
    assert_eq!(status, StatusCode::OK, "{ended}");
    let mut accepted = 0;
    for (status, body) in &votes {
        match *status {
            StatusCode::NO_CONTENT => accepted += 1,
            StatusCode::BAD_REQUEST => assert_eq!(code(body), Some(520001)),
            other => panic!("unexpected vote status {other}: {body}"),
        }
    }
    let final_counts: u64 = counts(&w.message(&w.owner, &mid).await).iter().map(|(count, _)| count).sum();
    assert_eq!(final_counts, accepted, "every accepted vote is counted, refused ones are not");
    let results = w.results(&mid).await;
    assert_eq!(results.len(), 1);
    assert_eq!(field(&results[0]["embeds"][0], "total_votes"), Some(accepted.to_string().as_str()), "the result message saw the same votes");

    // the sweep and End Poll Now racing on an expired poll still post one result
    let other = id(&w.poll(&w.owner, &["A"], false).await);
    w.backdate(&other).await;
    let state = &w.app.state;
    let (a, b, c, (status, _)) = tokio::join!(
        vokko_server::polls::sweep_expired(state),
        vokko_server::polls::sweep_expired(state),
        vokko_server::polls::sweep_expired(state),
        w.expire(&w.owner, &other)
    );
    let swept = a.expect("sweep") + b.expect("sweep") + c.expect("sweep");
    assert_eq!(swept + usize::from(status == StatusCode::OK), 1, "exactly one caller ended it");
    assert_eq!(w.results(&other).await.len(), 1);
}

#[tokio::test]
async fn a_poll_cannot_carry_stickers_or_be_a_forward_and_cannot_be_forwarded() {
    let w = world().await;
    let url = format!("/channels/{}/messages", w.general);

    // a poll and stickers do not mix
    let mut body = poll_body(&["a", "b"], false);
    body["sticker_ids"] = json!(["1"]);
    let (status, error) = w.app.post(&url, &w.owner.token, body).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");

    // a poll cannot be a forward
    let source = w.say(&w.general, &w.owner, "plain").await;
    let mut body = poll_body(&["a", "b"], false);
    body["message_reference"] = json!({"type": 1, "message_id": id(&source), "channel_id": w.general});
    let (status, error) = w.app.post(&url, &w.owner.token, body).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");

    // an existing poll message cannot be forwarded
    let mid = id(&w.poll(&w.owner, &["a", "b"], false).await);
    let second = id(&w.channel(json!({"name": "second", "type": 0})).await);
    let reference = json!({"type": 1, "message_id": mid, "channel_id": w.general});
    let (status, error) = w.app.post(&format!("/channels/{second}/messages"), &w.owner.token, json!({"message_reference": reference})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");
}

/// Creates a "party" emoji in the guild (as the owner), restricted to `roles`; returns its id.
async fn guild_emoji(w: &World, roles: Value) -> String {
    let attachment = w.upload_png(&w.general, &w.owner, "e.png").await;
    let body = json!({"name": "party", "image_attachment_id": attachment, "roles": roles});
    let (status, emoji) = w.app.post(&format!("/guilds/{}/emojis", w.guild), &w.owner.token, body).await;
    assert_eq!(status, StatusCode::OK, "create emoji: {emoji}");
    id(&emoji)
}

async fn poll_with_emoji(w: &World, user: &Member, emoji_id: &str) -> (StatusCode, Value) {
    let answer = json!({"poll_media": {"text": "A", "emoji": {"id": emoji_id, "name": "fake_name"}}});
    w.app.post(&format!("/channels/{}/messages", w.general), &user.token, json!({"poll": {"question": {"text": "Lunch?"}, "answers": [answer]}})).await
}

#[tokio::test]
async fn custom_answer_emoji_must_exist_and_be_usable_by_the_author() {
    let w = world().await;

    // an id that is no emoji at all
    let (status, error) = poll_with_emoji(&w, &w.alice, "123456789").await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(10014)), "{error}");

    // role-restricted: alice lacks the role
    let role = w.role_for(&w.carol, 0).await;
    let locked = guild_emoji(&w, json!([role])).await;
    let (status, error) = poll_with_emoji(&w, &w.alice, &locked).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)), "{error}");

    // the guild's own unrestricted emoji goes through, under its stored name
    let open = guild_emoji(&w, json!([])).await;
    let (status, message) = poll_with_emoji(&w, &w.alice, &open).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!(message["poll"]["answers"][0]["poll_media"]["emoji"]["name"], "party");
}
