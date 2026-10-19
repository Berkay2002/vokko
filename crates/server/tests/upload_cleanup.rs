#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Upload limits and cleanup over HTTP: the per-user concurrency and pending-bytes caps under concurrent uploads, and that an upload
//! whose storage write fails, or whose client goes away, leaves no attachments row (or staged file) counting against the quota.
mod common;

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use common::TestApp;
use futures_util::future::BoxFuture;
use tokio::sync::Semaphore;
use tower::ServiceExt;
use vokko_server::storage::{MemoryStorage, Object, Storage};

/// In-memory storage whose `put_file` can be made to fail, or to wait until the test releases it (an upload held mid-transfer).
struct ControlledStorage {
    files: MemoryStorage,
    fail: AtomicBool,
    hold: AtomicBool,
    /// One permit per `put_file` call that has started.
    entered: Semaphore,
    /// Held calls wait for a permit here.
    release: Semaphore,
    /// `copy` writes its target and then waits for `release` (a forward held mid-copy).
    hold_copy: AtomicBool,
    /// One permit per held `copy` call.
    copying: Semaphore,
}

impl Default for ControlledStorage {
    fn default() -> Self {
        Self {
            files: MemoryStorage::default(),
            fail: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            hold_copy: AtomicBool::new(false),
            copying: Semaphore::new(0),
        }
    }
}

impl ControlledStorage {
    async fn wait_entered(&self, calls: u32) {
        let permits = tokio::time::timeout(Duration::from_secs(10), self.entered.acquire_many(calls)).await.expect("uploads reached storage");
        permits.expect("semaphore open").forget();
    }
}

impl Storage for ControlledStorage {
    fn put(&self, id: i64, bytes: Bytes) -> BoxFuture<'_, io::Result<()>> {
        self.files.put(id, bytes)
    }

    fn put_file<'a>(&'a self, id: i64, path: &'a Path) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            self.entered.add_permits(1);
            if self.hold.load(Ordering::SeqCst) {
                self.release.acquire().await.expect("semaphore open").forget();
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(io::Error::other("injected storage failure"));
            }
            let bytes = tokio::fs::read(path).await?;
            self.files.put(id, Bytes::from(bytes)).await
        })
    }

    fn open(&self, id: i64) -> BoxFuture<'_, io::Result<Object>> {
        self.files.open(id)
    }

    fn read(&self, id: i64) -> BoxFuture<'_, io::Result<Bytes>> {
        self.files.read(id)
    }

    fn copy(&self, from: i64, to: i64) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            self.files.copy(from, to).await?;
            if self.hold_copy.load(Ordering::SeqCst) {
                self.copying.add_permits(1);
                self.release.acquire().await.expect("semaphore open").forget();
            }
            Ok(())
        })
    }

    fn delete(&self, id: i64) -> BoxFuture<'_, io::Result<()>> {
        self.files.delete(id)
    }

    fn deletes_inline(&self) -> bool {
        true
    }
}

struct Setup {
    app: TestApp,
    storage: Arc<ControlledStorage>,
    token: String,
    user_id: i64,
    channel: String,
}

async fn setup() -> Setup {
    let storage = Arc::new(ControlledStorage::default());
    let app = TestApp::with_storage(|_| {}, storage.clone()).await;
    let (token, user) = app.register("sam").await;
    let user_id = user["id"].as_str().expect("user id").parse().expect("id");
    let (_, channel) = app.guild_with_channel(&token).await;
    Setup { app, storage, token, user_id, channel }
}

const BOUNDARY: &str = "vokkoboundary7MA4YWxkTrZu0gW";

fn multipart_head() -> Vec<u8> {
    format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\n").into_bytes()
}

fn upload_request(token: &str, channel: &str, body: Body) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", token)
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(body)
        .expect("request")
}

/// Uploads `size` bytes as a plain file; the status of the response.
async fn upload(app: &TestApp, token: &str, channel: &str, size: usize) -> StatusCode {
    let mut body = multipart_head();
    body.extend(vec![b'a'; size]);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    app.router.clone().oneshot(upload_request(token, channel, Body::from(body))).await.expect("response").status()
}

fn spawn_upload(setup: &Setup, size: usize) -> tokio::task::JoinHandle<StatusCode> {
    let (router, token, channel) = (setup.app.router.clone(), setup.token.clone(), setup.channel.clone());
    tokio::spawn(async move {
        let mut body = multipart_head();
        body.extend(vec![b'a'; size]);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        router.oneshot(upload_request(&token, &channel, Body::from(body))).await.expect("response").status()
    })
}

/// The pending-bytes quota the route enforces (`routes::attachments::pending_quota`).
fn quota(app: &TestApp) -> i64 {
    vokko_server::config::MAX_PENDING_BYTES_PER_USER.max(i64::try_from(app.state.config.max_upload_bytes).expect("fits"))
}

/// A pending upload of `size` bytes recorded straight in the database, to bring the user close to the quota without sending it.
async fn fill_quota(setup: &Setup, size: i64) {
    sqlx::query("INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, key) VALUES ($1, $2, $3, 'filler.bin', 'application/octet-stream', $4, 'filler')")
        .bind(1_i64)
        .bind(setup.channel.parse::<i64>().expect("channel id"))
        .bind(setup.user_id)
        .bind(size)
        .execute(&setup.app.state.db)
        .await
        .expect("filler row");
}

/// The user's attachments rows other than the filler.
async fn uploads_in_db(setup: &Setup) -> i64 {
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE uploader_id = $1 AND id <> 1")
        .bind(setup.user_id)
        .fetch_one(&setup.app.state.db)
        .await
        .expect("count");
    count
}

/// Waits (the cleanup of a dropped request runs as a spawned task) until `check` holds; false after `common::WAIT`.
async fn eventually<F: std::future::Future<Output = bool>>(mut check: impl FnMut() -> F) -> bool {
    let deadline = tokio::time::Instant::now() + common::WAIT;
    while tokio::time::Instant::now() < deadline {
        if check().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn staged_files(app: &TestApp) -> usize {
    std::fs::read_dir(app.state.incoming_dir()).map(|entries| entries.count()).unwrap_or(0)
}

#[tokio::test]
async fn concurrent_uploads_beyond_the_per_user_limits_are_refused() {
    let setup = setup().await;
    let storage = &setup.storage;

    // At most `MAX_CONCURRENT_UPLOADS` in flight per user: one more while they are all mid-transfer is 429, and they all finish.
    storage.hold.store(true, Ordering::SeqCst);
    let in_flight: Vec<_> = (0..vokko_server::media::MAX_CONCURRENT_UPLOADS).map(|_| spawn_upload(&setup, 64)).collect();
    storage.wait_entered(in_flight.len() as u32).await;
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 64).await, StatusCode::TOO_MANY_REQUESTS);
    storage.release.add_permits(in_flight.len());
    for handle in in_flight {
        assert_eq!(handle.await.expect("join"), StatusCode::OK);
    }
    assert_eq!(uploads_in_db(&setup).await, 3);
    sqlx::query("DELETE FROM attachments").execute(&setup.app.state.db).await.expect("reset");

    // Pending bytes: an upload still being stored already counts, so a concurrent one that would pass the quota is 413.
    let quota = quota(&setup.app);
    fill_quota(&setup, quota - 150).await;
    let first = spawn_upload(&setup, 100);
    storage.wait_entered(1).await;
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 100).await, StatusCode::PAYLOAD_TOO_LARGE);
    // one that still fits next to it goes through
    storage.hold.store(false, Ordering::SeqCst);
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 50).await, StatusCode::OK);
    storage.release.add_permits(1);
    assert_eq!(first.await.expect("join"), StatusCode::OK);
    assert_eq!(uploads_in_db(&setup).await, 2);
}

#[tokio::test]
async fn a_failed_storage_write_leaves_no_row_and_frees_the_quota() {
    let setup = setup().await;
    let quota = quota(&setup.app);
    // Room for one 80-byte upload only: a row left behind by the failed one would refuse the retry.
    fill_quota(&setup, quota - 100).await;
    setup.storage.fail.store(true, Ordering::SeqCst);
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 80).await, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(uploads_in_db(&setup).await, 0, "the failed upload's row is gone by the time the error is sent");
    assert!(eventually(|| async { staged_files(&setup.app) == 0 }).await, "the staged file is removed");

    setup.storage.fail.store(false, Ordering::SeqCst);
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 80).await, StatusCode::OK);
    assert_eq!(uploads_in_db(&setup).await, 1);
}

#[tokio::test]
async fn a_client_that_disconnects_during_the_storage_write_leaves_no_row() {
    let setup = setup().await;
    let quota = quota(&setup.app);
    fill_quota(&setup, quota - 100).await;
    setup.storage.hold.store(true, Ordering::SeqCst);
    let upload_task = spawn_upload(&setup, 80);
    setup.storage.wait_entered(1).await;
    assert_eq!(uploads_in_db(&setup).await, 1, "the row exists while the bytes are being stored");
    // Dropping the request future is what hyper does when the connection goes away.
    upload_task.abort();
    assert!(upload_task.await.expect_err("aborted").is_cancelled());
    assert!(eventually(|| async { uploads_in_db(&setup).await == 0 }).await, "the aborted upload's row is removed");
    assert!(eventually(|| async { staged_files(&setup.app) == 0 }).await, "the staged file is removed");
    assert!(setup.storage.files.is_empty());

    setup.storage.hold.store(false, Ordering::SeqCst);
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 80).await, StatusCode::OK, "the quota was freed");
}

#[tokio::test]
async fn the_cleanup_leaves_a_row_that_was_claimed_meanwhile() {
    let setup = setup().await;
    setup.storage.hold.store(true, Ordering::SeqCst);
    let upload_task = spawn_upload(&setup, 80);
    setup.storage.wait_entered(1).await;
    // The row exists while the bytes are being stored, so something can claim it (an avatar, an icon, ...) before the abort.
    sqlx::query("UPDATE attachments SET claimed_at = now() WHERE uploader_id = $1").bind(setup.user_id).execute(&setup.app.state.db).await.expect("claim");
    upload_task.abort();
    assert!(upload_task.await.expect_err("aborted").is_cancelled());
    assert!(eventually(|| async { staged_files(&setup.app) == 0 }).await, "the staged file is removed");
    // the spawned cleanup has had time to run, and matched nothing
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(uploads_in_db(&setup).await, 1, "a claimed row is not the guard's to delete");
}

#[tokio::test]
async fn a_client_that_disconnects_mid_body_leaves_nothing_behind() {
    let setup = setup().await;
    let (sender, receiver) = tokio::sync::mpsc::channel::<Bytes>(4);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move { receiver.recv().await.map(|chunk| (Ok::<_, io::Error>(chunk), receiver)) });
    let request = upload_request(&setup.token, &setup.channel, Body::from_stream(stream));
    let router = setup.app.router.clone();
    let upload_task = tokio::spawn(async move { router.oneshot(request).await.expect("response").status() });
    sender.send(Bytes::from(multipart_head())).await.expect("send head");
    sender.send(Bytes::from(vec![b'a'; 4096])).await.expect("send part of the file");
    assert!(eventually(|| async { staged_files(&setup.app) == 1 }).await, "the file started streaming to the staging dir");
    upload_task.abort();
    assert!(upload_task.await.expect_err("aborted").is_cancelled());
    drop(sender);
    assert!(eventually(|| async { staged_files(&setup.app) == 0 }).await, "the partial staged file is removed");
    assert_eq!(uploads_in_db(&setup).await, 0);
    assert!(setup.storage.files.is_empty());
}

#[tokio::test]
async fn a_forward_dropped_mid_copy_leaves_no_copies() {
    let setup = setup().await;
    assert_eq!(upload(&setup.app, &setup.token, &setup.channel, 80).await, StatusCode::OK);
    let (id,): (i64,) =
        sqlx::query_as("SELECT id FROM attachments WHERE uploader_id = $1").bind(setup.user_id).fetch_one(&setup.app.state.db).await.expect("upload");
    let path = format!("/channels/{}/messages", setup.channel);
    let (status, source) = setup.app.post(&path, &setup.token, serde_json::json!({"content": "look", "attachments": [{"id": id.to_string()}]})).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(setup.storage.files.len(), 1);

    setup.storage.hold_copy.store(true, Ordering::SeqCst);
    let body = serde_json::json!({"message_reference": {"type": 1, "message_id": source["id"], "channel_id": setup.channel}});
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1{path}"))
        .header("authorization", &setup.token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request");
    let router = setup.app.router.clone();
    let forward = tokio::spawn(async move { router.oneshot(request).await.expect("response").status() });
    tokio::time::timeout(Duration::from_secs(10), setup.storage.copying.acquire()).await.expect("the forward reached its copy").expect("open").forget();
    assert_eq!(setup.storage.files.len(), 2, "the copy is written");
    forward.abort();
    assert!(forward.await.expect_err("aborted").is_cancelled());
    assert!(eventually(|| async { setup.storage.files.len() == 1 }).await, "the dropped forward's copy is removed");
}

#[tokio::test]
async fn a_dropped_forward_keeps_the_copies_of_a_commit_in_flight() {
    let setup = setup().await;
    let channel: i64 = setup.channel.parse().expect("channel id");
    setup.storage.put(77, Bytes::from_static(b"copy")).await.expect("put");
    // A send dropped at its COMMIT: the transaction holds the channel row and has stored the copy's row, not yet committed.
    let mut tx = setup.app.state.db.begin().await.expect("begin");
    sqlx::query("UPDATE channels SET last_activity_at = now() WHERE id = $1").bind(channel).execute(&mut *tx).await.expect("channel row");
    sqlx::query("INSERT INTO attachments (id, channel_id, uploader_id, filename, size, key) VALUES (77, $1, $2, 'copy.png', 4, 'k')")
        .bind(channel)
        .bind(setup.user_id)
        .execute(&mut *tx)
        .await
        .expect("copy row");
    let mut guard = vokko_server::forward::CopyGuard::new(&setup.app.state, channel);
    guard.track(77);
    drop(guard);
    tokio::time::sleep(Duration::from_millis(300)).await;
    tx.commit().await.expect("commit");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(setup.storage.read(77).await.is_ok(), "a copy the committed row references stays");
}
