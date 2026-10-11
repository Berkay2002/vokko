#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Forum channels: creation with tags, posts (id == first message id), tag rules, the search / sort / filter behind the post list.
mod common;
mod support_threads;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support_threads::{Client, Member, World, code, world};
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, SEND_MESSAGES};

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

fn names(response: &Value) -> Vec<String> {
    response["threads"].as_array().expect("threads").iter().map(|thread| thread["name"].as_str().expect("name").to_owned()).collect()
}

fn tag_id(forum: &Value, name: &str) -> String {
    forum["available_tags"].as_array().expect("tags").iter().find(|tag| tag["name"] == name).map(id).expect("tag")
}

impl World {
    async fn forum(&self, extra: Value) -> Value {
        let mut body = json!({
            "type": 15, "name": "Help Desk",
            "available_tags": [{"name": "bug"}, {"name": "idea", "emoji_name": "💡"}, {"name": "staff", "moderated": true}]
        });
        for (key, value) in extra.as_object().expect("object") {
            body[key] = value.clone();
        }
        self.channel(body).await
    }

    async fn post(&self, forum: &str, user: &Member, name: &str, content: &str, tags: &[&str]) -> (StatusCode, Value) {
        self.thread(forum, user, json!({"name": name, "applied_tags": tags, "message": {"content": content}})).await
    }

    async fn search(&self, forum: &str, user: &Member, query: &str) -> Value {
        let (status, response) = self.app.get(&format!("/channels/{forum}/threads/search?{query}"), &user.token).await;
        assert_eq!(status, StatusCode::OK, "search {query}: {response}");
        response
    }
}

#[tokio::test]
async fn a_forum_has_tags_defaults_and_only_takes_posts() {
    let w = world().await;
    let forum = w
        .forum(json!({"topic": "Ask here", "default_reaction_emoji": {"emoji_name": "👍"}, "default_sort_order": 1, "default_forum_layout": 2, "default_auto_archive_duration": 4320, "flags": 16}))
        .await;
    assert_eq!(forum["type"], 15);
    assert_eq!(forum["name"], "help-desk", "forum names are lowercased like text channel names");
    let tags = forum["available_tags"].as_array().expect("tags");
    assert_eq!(tags.len(), 3);
    assert!(tags.iter().all(|tag| tag["id"].as_str().is_some_and(|id| id.parse::<u64>().is_ok())), "ids are assigned by the server");
    assert_eq!((tags[1]["emoji_name"].clone(), tags[1]["moderated"].clone(), tags[2]["moderated"].clone()), (json!("💡"), json!(false), json!(true)));
    assert_eq!(
        (
            forum["default_reaction_emoji"]["emoji_name"].clone(),
            forum["default_sort_order"].clone(),
            forum["default_forum_layout"].clone(),
            forum["flags"].clone()
        ),
        (json!("👍"), json!(1), json!(2), json!(16))
    );
    assert_eq!(forum["default_auto_archive_duration"], 4320);

    // it shows up in the channel list with its fields
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.alice.token).await;
    assert_eq!(
        channels.as_array().expect("channels").iter().find(|channel| channel["id"] == forum["id"]).expect("listed")["available_tags"].as_array().unwrap().len(),
        3
    );

    // plain messages are not a thing in a forum
    let (status, error) = w.app.post(&format!("/channels/{}/messages", id(&forum)), &w.alice.token, json!({"content": "hi"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));

    // creating needs MANAGE_CHANNELS and valid tags
    let (status, _) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.alice.token, json!({"type": 15, "name": "nope"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let many: Vec<Value> = (0..21).map(|n| json!({"name": format!("t{n}")})).collect();
    let (status, error) =
        w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner.token, json!({"type": 15, "name": "many", "available_tags": many})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, _) = w
        .app
        .post(&format!("/guilds/{}/channels", w.guild), &w.owner.token, json!({"type": 15, "name": "long", "available_tags": [{"name": "x".repeat(21)}]}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, error) =
        w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner.token, json!({"type": 15, "name": "bad", "default_sort_order": 7})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));

    // announcement and stage channels can be created too
    let news = w.channel(json!({"type": 5, "name": "News", "default_auto_archive_duration": 60})).await;
    assert_eq!((news["type"].clone(), news["name"].clone(), news["default_auto_archive_duration"].clone()), (json!(5), json!("news"), json!(60)));
    assert_eq!(w.channel(json!({"type": 13, "name": "Stage"})).await["type"], 13);
}

#[tokio::test]
async fn a_post_is_a_thread_with_the_id_of_its_first_message() {
    let w = world().await;
    let forum = w.forum(json!({})).await;
    let fid = id(&forum);
    let bug = tag_id(&forum, "bug");
    let mut owner = Client::connect(&w.address, &w.owner.token).await;

    let (status, post) = w.post(&fid, &w.alice, "Crash on start", "It crashes", &[&bug]).await;
    assert_eq!(status, StatusCode::OK, "{post}");
    let pid = id(&post);
    assert_eq!(post["message"]["id"], pid.as_str(), "the thread id is the first message id");
    assert_eq!((post["type"].clone(), post["parent_id"].clone(), post["owner_id"].clone()), (json!(11), json!(fid), json!(w.alice.id)));
    assert_eq!((post["applied_tags"].clone(), post["newly_created"].clone()), (json!([bug]), json!(true)));
    assert_eq!(
        (post["message"]["content"].clone(), post["message"]["channel_id"].clone(), post["message"]["type"].clone()),
        (json!("It crashes"), json!(pid), json!(0))
    );
    assert_eq!(post["message_count"], 0, "the first message does not count");

    let created = owner.wait_id("THREAD_CREATE", &pid).await;
    assert_eq!(created["applied_tags"], json!([bug]));
    owner.wait_match("MESSAGE_CREATE", |data| data["id"] == pid.as_str()).await;

    // the thread holds exactly that message; replies join the post
    assert_eq!(w.messages(&pid, &w.carol).await.len(), 1);
    w.say(&pid, &w.carol, "same here").await;
    let (_, found) = w.app.get(&format!("/guilds/{}/threads/active", w.guild), &w.carol.token).await;
    let listed = &found["threads"][0];
    assert_eq!((listed["message_count"].clone(), listed["member_count"].clone(), listed["applied_tags"].clone()), (json!(1), json!(2), json!([bug])));
    assert_eq!(listed["member"]["user_id"], w.carol.id.as_str());
    // the forum itself is not a thread and has no parent_id; posts are not channels of the guild
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.carol.token).await;
    assert!(channels.as_array().unwrap().iter().all(|channel| channel["id"] != pid.as_str()));

    // validation: empty first message, unknown tag, too many tags, posting needs SEND_MESSAGES
    let (status, error) = w.post(&fid, &w.alice, "empty", "  ", &[]).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, error) = w.post(&fid, &w.alice, "unknown", "x", &["12345"]).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, error) = w.thread(&fid, &w.alice, json!({"name": "no message"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, post) = w.post(&fid, &w.alice, "missing", "x", &[]).await;
    assert_eq!(status, StatusCode::OK, "tags are optional: {post}");
    assert_eq!(post["applied_tags"], json!([]));
    let (status, _) = w.post(&fid, &w.bob, "outsider", "x", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    w.set_everyone(DEFAULT_EVERYONE & !SEND_MESSAGES).await;
    let (status, error) = w.post(&fid, &w.carol, "muted", "x", &[]).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
}

#[tokio::test]
async fn required_and_moderated_tags() {
    let w = world().await;
    let forum = w.forum(json!({"flags": 16})).await;
    let fid = id(&forum);
    let (bug, staff) = (tag_id(&forum, "bug"), tag_id(&forum, "staff"));

    let (status, error) = w.post(&fid, &w.alice, "no tag", "x", &[]).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(220003)));
    let (status, error) = w.post(&fid, &w.alice, "staff tag", "x", &[&staff]).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)), "moderated tags need MANAGE_THREADS");
    let (status, post) = w.post(&fid, &w.owner, "staff post", "x", &[&staff, &bug]).await;
    assert_eq!(status, StatusCode::OK, "{post}");
    let (status, mine) = w.post(&fid, &w.alice, "ok", "x", &[&bug]).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    let mid = id(&mine);

    // editing tags: the owner of the post may change normal tags but not touch moderated ones; the last tag cannot go when required
    let idea = tag_id(&forum, "idea");
    let (status, edited) = w.patch(&mid, &w.alice, json!({"applied_tags": [bug, idea]})).await;
    assert_eq!((status, edited["applied_tags"].clone()), (StatusCode::OK, json!([bug, idea])));
    let (status, error) = w.patch(&mid, &w.alice, json!({"applied_tags": [bug, staff]})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.patch(&mid, &w.alice, json!({"applied_tags": []})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(220003)));
    let (status, _) = w.patch(&mid, &w.owner, json!({"applied_tags": [bug, staff]})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = w.patch(&mid, &w.alice, json!({"applied_tags": [bug]})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)), "removing a moderated tag needs MANAGE_THREADS too");
    let too_many: Vec<String> = (0..6).map(|n| format!("{}", 1000 + n)).collect();
    let (status, error) = w.patch(&mid, &w.owner, json!({"applied_tags": too_many})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
}

#[tokio::test]
async fn search_filters_sorts_and_pins() {
    let w = world().await;
    let forum = w.forum(json!({})).await;
    let fid = id(&forum);
    let (bug, idea) = (tag_id(&forum, "bug"), tag_id(&forum, "idea"));
    let (_, a) = w.post(&fid, &w.alice, "Alpha crash", "first", &[&bug]).await;
    let (_, b) = w.post(&fid, &w.carol, "Beta feature", "second", &[&idea]).await;
    let (_, c) = w.post(&fid, &w.alice, "Gamma both", "third", &[&bug, &idea]).await;
    w.post(&fid, &w.carol, "Delta 100% done", "fourth", &[]).await;
    let (a, b, c) = (id(&a), id(&b), id(&c));

    // default order: latest activity first; talking in an old post brings it up
    assert_eq!(names(&w.search(&fid, &w.alice, "").await), ["Delta 100% done", "Gamma both", "Beta feature", "Alpha crash"]);
    w.say(&a, &w.carol, "bump").await;
    assert_eq!(names(&w.search(&fid, &w.alice, "").await), ["Alpha crash", "Delta 100% done", "Gamma both", "Beta feature"]);
    // creation order, either direction
    assert_eq!(names(&w.search(&fid, &w.alice, "sort_by=creation_time").await), ["Delta 100% done", "Gamma both", "Beta feature", "Alpha crash"]);
    assert_eq!(
        names(&w.search(&fid, &w.alice, "sort_by=creation_time&sort_order=asc").await),
        ["Alpha crash", "Beta feature", "Gamma both", "Delta 100% done"]
    );

    // tags: any of, or all of
    assert_eq!(names(&w.search(&fid, &w.alice, &format!("tag={bug}&sort_by=creation_time")).await), ["Gamma both", "Alpha crash"]);
    assert_eq!(names(&w.search(&fid, &w.alice, &format!("tag={bug}&tag={idea}&sort_by=creation_time")).await), ["Gamma both", "Beta feature", "Alpha crash"]);
    assert_eq!(names(&w.search(&fid, &w.alice, &format!("tag={bug}&tag={idea}&tag_setting=match_all")).await), ["Gamma both"]);
    // name: case-insensitive substring, wildcards are literal
    assert_eq!(names(&w.search(&fid, &w.alice, "name=BETA").await), ["Beta feature"]);
    assert_eq!(names(&w.search(&fid, &w.alice, "name=100%25").await), ["Delta 100% done"]);
    assert!(w.search(&fid, &w.alice, "name=%25x").await["threads"].as_array().unwrap().is_empty());

    // first messages and memberships come with the page
    let page = w.search(&fid, &w.carol, "sort_by=creation_time&limit=2").await;
    assert_eq!((page["total_results"].clone(), page["has_more"].clone()), (json!(4), json!(true)));
    let contents: Vec<&str> = page["first_messages"].as_array().unwrap().iter().map(|message| message["content"].as_str().unwrap()).collect();
    assert_eq!(contents, ["fourth", "third"]);
    assert_eq!(page["members"].as_array().unwrap().len(), 1, "carol wrote one of the two posts on the page");
    assert_eq!(page["members"][0]["id"], page["threads"][0]["id"]);
    let second = w.search(&fid, &w.carol, "sort_by=creation_time&limit=2&offset=2").await;
    assert_eq!((names(&second), second["has_more"].clone()), (vec!["Beta feature".to_owned(), "Alpha crash".to_owned()], json!(false)));

    // pinning needs MANAGE_THREADS and puts the post first whatever the sort
    let (status, error) = w.patch(&a, &w.alice, json!({"flags": 2})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, pinned) = w.patch(&b, &w.owner, json!({"flags": 2})).await;
    assert_eq!((status, pinned["flags"].clone()), (StatusCode::OK, json!(2)));
    assert_eq!(names(&w.search(&fid, &w.alice, "sort_by=creation_time").await)[0], "Beta feature");
    assert_eq!(names(&w.search(&fid, &w.alice, "sort_by=creation_time&sort_order=asc").await)[0], "Beta feature");

    // archived filter
    assert_eq!(w.patch(&c, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    assert_eq!(names(&w.search(&fid, &w.alice, "archived=true").await), ["Gamma both"]);
    assert_eq!(w.search(&fid, &w.alice, "archived=false").await["total_results"], 3);
    assert_eq!(w.search(&fid, &w.alice, "").await["total_results"], 4, "active and archived");

    // bad queries
    for query in ["limit=0", "limit=26", "sort_by=best", "tag=abc", "archived=maybe", "tag_setting=some", "offset=99999"] {
        let (status, error) = w.app.get(&format!("/channels/{fid}/threads/search?{query}"), &w.alice.token).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{query}");
    }
    // the forum's default sort order is used when none is given
    let by_creation = w.forum(json!({"name": "By Creation", "default_sort_order": 1})).await;
    let cid = id(&by_creation);
    w.post(&cid, &w.alice, "older", "x", &[]).await;
    w.post(&cid, &w.alice, "newer", "x", &[]).await;
    let older_id = id(&w.search(&cid, &w.alice, "sort_order=asc").await["threads"][0]);
    w.say(&older_id, &w.carol, "activity does not matter here").await;
    assert_eq!(names(&w.search(&cid, &w.alice, "").await), ["newer", "older"]);
    // search also works in a text channel's threads
    w.thread(&w.general, &w.alice, json!({"name": "side chat"})).await;
    assert_eq!(names(&w.search(&w.general, &w.alice, "").await), ["side chat"]);
    // outsiders see nothing
    assert_eq!(w.app.get(&format!("/channels/{fid}/threads/search"), &w.bob.token).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn editing_a_forum_replaces_tags_and_clears_them_from_posts() {
    let w = world().await;
    let forum = w.forum(json!({"default_reaction_emoji": {"emoji_name": "👍"}})).await;
    let fid = id(&forum);
    let (bug, idea) = (tag_id(&forum, "bug"), tag_id(&forum, "idea"));
    let (_, post) = w.post(&fid, &w.alice, "tagged", "x", &[&bug, &idea]).await;
    let pid = id(&post);
    let mut alice = Client::connect(&w.address, &w.alice.token).await;

    // keep `bug` (renamed, now moderated), drop `idea` and `staff`, add `question`
    let (status, edited) = w
        .patch(
            &fid,
            &w.owner,
            json!({"available_tags": [{"id": bug, "name": "defect", "moderated": true}, {"name": "question"}], "default_reaction_emoji": null, "default_sort_order": 1, "default_forum_layout": 1}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    let tags = edited["available_tags"].as_array().unwrap();
    assert_eq!(tags.iter().map(|tag| tag["name"].as_str().unwrap()).collect::<Vec<_>>(), ["defect", "question"]);
    assert_eq!((tags[0]["id"].clone(), tags[0]["moderated"].clone()), (json!(bug), json!(true)));
    assert!(edited.get("default_reaction_emoji").is_none_or(Value::is_null), "null clears the default reaction");
    assert_eq!((edited["default_sort_order"].clone(), edited["default_forum_layout"].clone()), (json!(1), json!(1)));

    // the post lost the removed tag and was announced
    alice.wait_id("CHANNEL_UPDATE", &fid).await;
    let update = alice.wait_id("THREAD_UPDATE", &pid).await;
    assert_eq!(update["applied_tags"], json!([bug]));

    // unknown tag ids are rejected and nothing changes; MANAGE_CHANNELS is required
    let (status, error) = w.patch(&fid, &w.owner, json!({"available_tags": [{"id": "424242", "name": "ghost"}]})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, _) = w.patch(&fid, &w.alice, json!({"available_tags": []})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, error) = w.patch(&fid, &w.owner, json!({"default_forum_layout": 9})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.alice.token).await;
    let current = channels.as_array().unwrap().iter().find(|channel| channel["id"] == fid.as_str()).unwrap();
    assert_eq!(current["available_tags"].as_array().unwrap().len(), 2);

    // an empty list removes every tag; deleting the forum removes its posts
    let (_, cleared) = w.patch(&fid, &w.owner, json!({"available_tags": []})).await;
    assert_eq!(cleared["available_tags"], json!([]));
    assert_eq!(w.app.delete(&format!("/channels/{fid}"), &w.owner.token).await.0, StatusCode::OK);
    alice.wait_id("THREAD_DELETE", &pid).await;
    alice.wait_id("CHANNEL_DELETE", &fid).await;
}

#[tokio::test]
async fn a_post_can_carry_an_attachment_uploaded_to_the_forum() {
    let w = world().await;
    let forum = w.forum(json!({})).await;
    let fid = id(&forum);
    let attachment = w.upload_png(&fid, &w.alice, "diagram.png").await;
    // somebody else's upload cannot be used
    let stolen = w.upload_png(&fid, &w.carol, "stolen.png").await;
    let (status, error) = w.thread(&fid, &w.alice, json!({"name": "stolen", "message": {"content": "x", "attachment_ids": [stolen]}})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    assert!(w.search(&fid, &w.alice, "").await["threads"].as_array().unwrap().is_empty(), "a refused post leaves no thread behind");

    let (status, post) = w.thread(&fid, &w.alice, json!({"name": "With picture", "message": {"content": "see", "attachment_ids": [attachment]}})).await;
    assert_eq!(status, StatusCode::OK, "{post}");
    assert_eq!(post["message"]["attachments"][0]["filename"], "diagram.png");
    assert_eq!(post["message"]["attachments"][0]["id"], attachment.as_str());
    let listed = w.messages(&id(&post), &w.carol).await;
    assert_eq!(listed[0]["attachments"][0]["id"], attachment.as_str());
    // deleting the post removes the file row with it
    assert_eq!(w.app.delete(&format!("/channels/{}", id(&post)), &w.alice.token).await.0, StatusCode::OK);
    let (left,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM attachments WHERE id = $1").bind(attachment.parse::<i64>().unwrap()).fetch_one(&w.app.state.db).await.unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_custom_emoji_default_reaction_is_kept() {
    let w = world().await;
    let forum = w.forum(json!({"default_reaction_emoji": {"emoji_id": "424242", "emoji_name": null}})).await;
    assert_eq!((forum["default_reaction_emoji"]["emoji_id"].clone(), forum["default_reaction_emoji"]["emoji_name"].clone()), (json!("424242"), Value::Null));
    let fid = id(&forum);
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.alice.token).await;
    let listed = channels.as_array().unwrap().iter().find(|channel| channel["id"] == fid.as_str()).unwrap();
    assert_eq!(listed["default_reaction_emoji"]["emoji_id"], "424242");
    // switching to a unicode one replaces it, null clears it
    let (_, edited) = w.patch(&fid, &w.owner, json!({"default_reaction_emoji": {"emoji_name": "🔥"}})).await;
    assert_eq!((edited["default_reaction_emoji"]["emoji_id"].clone(), edited["default_reaction_emoji"]["emoji_name"].clone()), (Value::Null, json!("🔥")));
    let (_, cleared) = w.patch(&fid, &w.owner, json!({"default_reaction_emoji": null})).await;
    assert!(cleared.get("default_reaction_emoji").is_none_or(Value::is_null));
}
