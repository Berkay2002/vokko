//! The download-ahead cache between the media host and ffmpeg (the Stremio app keeps 2 GiB of the film on disk the same way).
//!
//! One `ReadAhead` lives as long as a session plays one media URL, across pauses, seeks and ffmpeg restarts. It holds
//! - a reader task that downloads the file from the playhead onwards as fast as the source allows, up to the byte cap,
//!   reconnecting with backoff when the source drops;
//! - the downloaded bytes, in 32 MiB block files under `<cache root>/vokko-stremio-bot/<session dir>/` and a map of which byte
//!   ranges are present, so a seek back into downloaded data refetches nothing and a seek elsewhere starts a new fill there;
//! - a loopback HTTP server (`127.0.0.1`, a random path) that ffmpeg reads instead of the media URL. It answers `Range` requests
//!   from the cache and waits for the reader when the bytes are not there yet.
//!
//! RAM stays small: the reader holds one network chunk, a connection one 256 KiB read buffer. The playhead is the offset the
//! last response to ffmpeg got to. The reader fills from the end of the cached run that contains the playhead; when the cap is
//! reached it evicts whole blocks that are not in the run ahead of the playhead, farthest first, or pauses until the playhead moves.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// The only directory below the cache root the bot ever creates or deletes things in.
pub const SUBDIR: &str = "vokko-stremio-bot";
pub const DEFAULT_CAP: u64 = 2 << 30;
pub const MIN_CAP: u64 = 8 << 20;
/// The first frame waits for this much media ahead of the playhead.
const PRIME_SECS: u64 = 5;
const PRIME_MAX: Duration = Duration::from_secs(15);
/// Consecutive source failures for this long end the fill; ffmpeg then fails and the session's retry starts a fresh cache.
const GIVE_UP: Duration = Duration::from_secs(30);
const FIRST_RESPONSE_WAIT: Duration = Duration::from_secs(25);
const BACKOFF_MS: [u64; 6] = [250, 500, 1000, 2000, 4000, 5000];
const SERVE_CHUNK: usize = 256 * 1024;
/// A seek this far ahead of the fill is reached by reading through the response instead of opening a new one.
const SKIP_MAX: u64 = 8 << 20;
const MAX_CONNECTIONS: usize = 16;
/// Playheads from the last seconds keep their block and the next one (a badly interleaved file makes ffmpeg alternate between two places).
const LOCK_FILE: &str = ".lock";
const HEAD_KEEP: Duration = Duration::from_secs(10);
const HEADS_MAX: usize = 4;
const FALLBACK_BITRATE: u64 = 16_000_000;

// ---- which byte ranges are present ----

#[derive(Default)]
struct Ranges(BTreeMap<u64, u64>);

impl Ranges {
    fn insert(&mut self, a: u64, b: u64) {
        if a >= b {
            return;
        }
        let (mut lo, mut hi) = (a, b);
        if let Some((&s, &e)) = self.0.range(..=lo).next_back()
            && e >= lo
        {
            lo = s;
            hi = hi.max(e);
        }
        let inside: Vec<u64> = self.0.range(lo..=hi).map(|(&s, _)| s).collect();
        for s in inside {
            if let Some(e) = self.0.remove(&s) {
                hi = hi.max(e);
            }
        }
        self.0.insert(lo, hi);
    }

    fn remove(&mut self, a: u64, b: u64) {
        let touching: Vec<(u64, u64)> = self.0.range(..b).filter(|&(_, &e)| e > a).map(|(&s, &e)| (s, e)).collect();
        for (s, e) in touching {
            self.0.remove(&s);
            if s < a {
                self.0.insert(s, a);
            }
            if e > b {
                self.0.insert(b, e);
            }
        }
    }

    fn contains(&self, at: u64) -> bool {
        self.0.range(..=at).next_back().is_some_and(|(_, &e)| e > at)
    }

    /// The end of the present run that contains `at`, or `at` itself when that byte is missing.
    fn run_end(&self, at: u64) -> u64 {
        self.0.range(..=at).next_back().map_or(at, |(_, &e)| e.max(at))
    }

    fn bytes(&self) -> u64 {
        self.0.iter().map(|(s, e)| e - s).sum()
    }
}

// ---- files ----

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}
#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}
#[cfg(unix)]
fn write_all_at(file: &File, buf: &[u8], offset: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, buf, offset)
}
#[cfg(windows)]
fn write_all_at(file: &File, mut buf: &[u8], mut offset: u64) -> io::Result<()> {
    while !buf.is_empty() {
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, offset)?;
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

fn make_dir(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

// ---- shared state ----

#[derive(Default)]
struct State {
    total: Option<u64>,
    /// ETag or Last-Modified of the first response: a reconnect that sees another one would splice two files.
    validator: Option<String>,
    have: Ranges,
    /// Blocks that have a file.
    blocks: BTreeSet<u64>,
    /// The playhead: where the last response to ffmpeg got to.
    pos: u64,
    /// Where ffmpeg asked for data in the last seconds (newest last).
    heads: VecDeque<(u64, Instant)>,
    fatal: Option<String>,
    /// Blocks evicted so far: a read that straddles one must not trust what it got (a block file rewritten later is sparse).
    evictions: u64,
    requests: u64,
    reconnects: u64,
}

struct Shared {
    url: String,
    headers: BTreeMap<String, String>,
    client: reqwest::Client,
    dir: PathBuf,
    cap: u64,
    block: u64,
    token: String,
    state: Mutex<State>,
    /// Bumped on every change that somebody may be waiting for.
    tx: watch::Sender<u64>,
    read_total: AtomicU64,
    rate: Mutex<(u64, Instant)>,
    connections: AtomicUsize,
    /// Holds the directory's lock file locked while this session lives (see `wipe_stale`).
    lock: Option<File>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // an open file would stop Windows from deleting the directory
        drop(self.lock.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

enum Read {
    Data(usize),
    Wait,
    Failed(String),
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn bump(&self) {
        self.tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn fail(&self, message: String) {
        self.lock().fatal.get_or_insert(message);
        self.bump();
    }

    fn block_path(&self, block: u64) -> PathBuf {
        self.dir.join(format!("{block}.blk"))
    }

    /// Frees room for `[at, end)` by deleting blocks that are not in the run ahead of the playhead, farthest first.
    /// False when nothing may go yet: the reader then waits for the playhead to move.
    fn make_room(&self, st: &mut State, at: u64, end: u64) -> bool {
        let need = end - at;
        if st.have.bytes() + need <= self.cap {
            return true;
        }
        let now = Instant::now();
        let block_of = |offset: u64| offset / self.block;
        let mut keep: BTreeSet<u64> = (block_of(at)..=block_of(end.saturating_sub(1))).collect();
        let run = st.have.run_end(st.pos);
        keep.extend(block_of(st.pos)..=block_of(run.max(st.pos + 1) - 1));
        for &(head, when) in &st.heads {
            if now.duration_since(when) <= HEAD_KEEP {
                keep.extend([block_of(head), block_of(head) + 1]);
            }
        }
        // the file's first and last blocks hold the header and the index that every restart of ffmpeg reads again
        keep.insert(0);
        if let Some(total) = st.total {
            keep.insert(block_of(total.saturating_sub(1)));
        }
        while st.have.bytes() + need > self.cap {
            let pos = st.pos;
            let distance = |b: u64| {
                let (s, e) = (b * self.block, (b + 1) * self.block);
                if pos < s {
                    s - pos
                } else if pos >= e {
                    pos - e + 1
                } else {
                    0
                }
            };
            let Some(victim) = st.blocks.iter().copied().filter(|b| !keep.contains(b)).max_by_key(|b| distance(*b)) else { return false };
            st.have.remove(victim * self.block, (victim + 1) * self.block);
            st.blocks.remove(&victim);
            st.evictions += 1;
            let _ = std::fs::remove_file(self.block_path(victim));
        }
        true
    }

    /// Writes downloaded bytes at `at`. `Ok(false)`: the cap is reached and nothing may be evicted yet.
    fn store(&self, at: u64, data: &[u8]) -> io::Result<bool> {
        let end = at + data.len() as u64;
        if !self.make_room(&mut self.lock(), at, end) {
            return Ok(false);
        }
        let mut offset = at;
        while offset < end {
            let block = offset / self.block;
            let in_block = offset - block * self.block;
            let n = (end - offset).min(self.block - in_block);
            let file = File::options().read(true).write(true).create(true).truncate(false).open(self.block_path(block))?;
            write_all_at(&file, &data[(offset - at) as usize..][..n as usize], in_block)?;
            self.lock().blocks.insert(block);
            offset += n;
        }
        self.lock().have.insert(at, end);
        self.bump();
        Ok(true)
    }

    /// Reads cached bytes at `at` (not past `limit`, the end of the response) into `buf`. Sets the playhead.
    fn read_cached(&self, at: u64, limit: u64, buf: &mut [u8]) -> Read {
        let (block, n, evictions) = {
            let mut st = self.lock();
            if !st.have.contains(at) {
                if let Some(message) = &st.fatal {
                    return Read::Failed(message.clone());
                }
                if st.pos != at {
                    st.pos = at;
                    drop(st);
                    self.bump();
                }
                return Read::Wait;
            }
            let block = at / self.block;
            let n = st.have.run_end(at).min(limit).min((block + 1) * self.block).min(at + buf.len() as u64) - at;
            (block, n as usize, st.evictions)
        };
        let read = File::open(self.block_path(block)).and_then(|file| read_at(&file, &mut buf[..n], at - block * self.block));
        match read {
            Ok(m) if m > 0 => {
                let mut st = self.lock();
                if st.evictions != evictions {
                    // something was evicted while this read ran and the bytes may be gone: ask again
                    drop(st);
                    self.bump();
                    return Read::Wait;
                }
                st.pos = at + m as u64;
                drop(st);
                self.bump();
                Read::Data(m)
            }
            // the block was evicted between the check and the read: the next round waits for the reader to bring it back
            _ => {
                let mut st = self.lock();
                st.have.remove(block * self.block, (block + 1) * self.block);
                st.blocks.remove(&block);
                Read::Wait
            }
        }
    }

    fn note_head(&self, at: u64) {
        let mut st = self.lock();
        let now = Instant::now();
        st.heads.retain(|&(_, when)| now.duration_since(when) <= HEAD_KEEP);
        st.heads.push_back((at, now));
        while st.heads.len() > HEADS_MAX {
            st.heads.pop_front();
        }
    }
}

// ---- the reader ----

struct Opened {
    response: reqwest::Response,
    total: u64,
    validator: Option<String>,
}

impl Shared {
    async fn open(&self, from: u64) -> Result<Opened, String> {
        let mut request = self.client.get(&self.url).header("Range", format!("bytes={from}-")).header("Accept-Encoding", "identity");
        for (name, value) in &self.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request.send().await.map_err(|e| e.without_url().to_string())?;
        let status = response.status();
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let total = match status.as_u16() {
            206 => {
                let range = header("content-range").ok_or("no Content-Range")?;
                let (span, total) = range.strip_prefix("bytes ").and_then(|r| r.split_once('/')).ok_or("bad Content-Range")?;
                let start: u64 = span.split_once('-').and_then(|(a, _)| a.parse().ok()).ok_or("bad Content-Range")?;
                if start != from {
                    return Err("the source answered another range".into());
                }
                total.parse::<u64>().map_err(|_| "the source does not report its size")?
            }
            200 if from == 0 => response.content_length().ok_or("the source does not report its size")?,
            200 => return Err("the source ignores Range".into()),
            other => return Err(format!("the source answered {other}")),
        };
        let validator = header("etag").or_else(|| header("last-modified"));
        Ok(Opened { response, total, validator })
    }

    /// Checks a response against what the first one said. False means the file changed under us.
    fn accept(&self, opened: &Opened) -> bool {
        let mut st = self.lock();
        match st.total {
            None => {
                st.total = Some(opened.total);
                st.validator.clone_from(&opened.validator);
            }
            Some(total) if total != opened.total => return false,
            Some(_) => {
                if st.validator.is_some() && opened.validator.is_some() && st.validator != opened.validator {
                    return false;
                }
            }
        }
        drop(st);
        self.bump();
        true
    }
}

enum Pass {
    /// The fill target moved: open a new request there.
    Restart,
    /// The source ended or failed before the end of the file; the reader reconnects.
    Broken(String),
    /// The cache cannot go on (the file changed under us); no reconnect.
    Fatal(String),
    Done,
}

async fn reader(shared: Arc<Shared>, cancel: CancellationToken) {
    let mut rx = shared.tx.subscribe();
    let mut failing: Option<Instant> = None;
    let mut attempt = 0usize;
    loop {
        // wait for work: the first missing byte at or after the playhead
        let from = loop {
            let todo = {
                let st = shared.lock();
                if st.fatal.is_some() {
                    return;
                }
                let from = st.have.run_end(st.pos);
                (st.total.is_none_or(|t| from < t)).then_some(from)
            };
            if let Some(from) = todo {
                break from;
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = rx.changed() => if changed.is_err() { return },
            }
        };
        {
            let mut st = shared.lock();
            st.requests += 1;
            if failing.is_some() {
                st.reconnects += 1;
            }
        }
        let result = match shared.open(from).await {
            Ok(opened) if shared.accept(&opened) => stream(&shared, &cancel, &mut rx, opened.response, from, &mut failing, &mut attempt).await,
            Ok(_) => Pass::Fatal("the source changed while it played".into()),
            Err(e) => Pass::Broken(e),
        };
        match result {
            Pass::Restart | Pass::Done => {}
            Pass::Fatal(message) => {
                shared.fail(message);
                return;
            }
            Pass::Broken(message) => {
                let since = *failing.get_or_insert_with(Instant::now);
                if since.elapsed() >= GIVE_UP {
                    tracing::warn!(%message, "read-ahead gives up on the source");
                    shared.fail(format!("the source stopped answering: {message}"));
                    return;
                }
                tracing::debug!(%message, attempt, "read-ahead source error, retrying");
                let wait = Duration::from_millis(BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)]);
                attempt += 1;
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(wait) => {}
                }
            }
        }
        if cancel.is_cancelled() {
            return;
        }
    }
}

/// Reads one response into the cache until the fill target moves away from it, the file is complete or the source fails.
async fn stream(
    shared: &Shared,
    cancel: &CancellationToken,
    rx: &mut watch::Receiver<u64>,
    mut response: reqwest::Response,
    from: u64,
    failing: &mut Option<Instant>,
    attempt: &mut usize,
) -> Pass {
    // `cursor` is where `pending` belongs; the response has been read up to cursor + pending.len()
    let mut cursor = from;
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let (target, total) = {
            let st = shared.lock();
            (st.have.run_end(st.pos), st.total.unwrap_or(u64::MAX))
        };
        let read_end = cursor + pending.len() as u64;
        // a seek behind, or far ahead of, what this response can deliver
        if target < cursor || target > read_end.saturating_add(SKIP_MAX) {
            return Pass::Restart;
        }
        if target > cursor {
            let skip = pending.len().min((target - cursor) as usize);
            pending.drain(..skip);
            cursor += skip as u64;
        }
        if !pending.is_empty() {
            match shared.store(cursor, &pending) {
                Ok(true) => {
                    cursor += pending.len() as u64;
                    pending.clear();
                    drop(rx.borrow_and_update());
                }
                Ok(false) => {
                    // the cap is reached: the connection stays open and TCP holds the source back until the playhead moves. The
                    // timeout covers protection that simply expires (a remembered request head), which nobody announces.
                    tokio::select! {
                        () = cancel.cancelled() => return Pass::Done,
                        changed = rx.changed() => if changed.is_err() { return Pass::Done },
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
                Err(e) => {
                    shared.fail(format!("cannot write the cache: {e}"));
                    return Pass::Done;
                }
            }
            continue;
        }
        if cursor >= total {
            return Pass::Done;
        }
        tokio::select! {
            () = cancel.cancelled() => return Pass::Done,
            changed = rx.changed() => if changed.is_err() { return Pass::Done },
            chunk = response.chunk() => match chunk {
                Ok(Some(bytes)) => {
                    shared.read_total.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    *failing = None;
                    *attempt = 0;
                    let take = bytes.len().min((total - cursor) as usize);
                    pending.extend_from_slice(&bytes[..take]);
                }
                Ok(None) => return if cursor >= total { Pass::Done } else { Pass::Broken("the source closed early".into()) },
                Err(e) => return Pass::Broken(e.without_url().to_string()),
            },
        }
        // bytes below the target are already here (or were skipped over): the next round drops them
    }
}

// ---- the loopback server ----

struct Request {
    path: String,
    /// GET or HEAD.
    method_ok: bool,
    head_only: bool,
    range: Option<String>,
    close: bool,
}

async fn read_request(reader: &mut BufReader<OwnedReadHalf>) -> io::Result<Option<Request>> {
    let mut line = String::new();
    let mut head: Vec<String> = Vec::new();
    loop {
        line.clear();
        let n = (&mut *reader).take(8 * 1024).read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        if !line.ends_with('\n') || head.len() > 64 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let text = line.trim_end().to_owned();
        if text.is_empty() {
            if head.is_empty() {
                continue;
            }
            break;
        }
        head.push(text);
    }
    let mut first = head[0].split(' ');
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let field = |name: &str| head[1..].iter().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned()));
    Ok(Some(Request {
        path: path.to_owned(),
        method_ok: method == "GET" || method == "HEAD",
        head_only: method == "HEAD",
        range: field("range"),
        close: field("connection").is_some_and(|v| v.eq_ignore_ascii_case("close")),
    }))
}

#[derive(Debug, PartialEq, Eq)]
enum Want {
    Whole,
    /// First and last byte, inclusive.
    Part(u64, u64),
    Unsatisfiable,
}

fn parse_range(header: Option<&str>, total: u64) -> Want {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Want::Whole };
    // several ranges at once are not served as such
    let Some((a, b)) = spec.split_once('-').filter(|_| !spec.contains(',')) else { return Want::Whole };
    let last = total.saturating_sub(1);
    let (from, to) = match (a.trim().parse::<u64>(), b.trim().parse::<u64>()) {
        (Ok(from), Ok(to)) => (from, to.min(last)),
        (Ok(from), Err(_)) if b.trim().is_empty() => (from, last),
        (Err(_), Ok(n)) if a.trim().is_empty() && n > 0 => (total.saturating_sub(n), last),
        _ => return Want::Whole,
    };
    if from >= total || from > to { Want::Unsatisfiable } else { Want::Part(from, to) }
}

/// True when the peer has closed its side (nothing is expected from it while a response is being served).
async fn peer_closed(read: &OwnedReadHalf) {
    loop {
        if read.readable().await.is_err() {
            return;
        }
        let mut probe = [0u8; 1];
        match read.try_read(&mut probe) {
            Ok(_) => return,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return,
        }
    }
}

async fn serve_connection(shared: Arc<Shared>, socket: TcpStream) -> io::Result<()> {
    let (read, mut write) = socket.into_split();
    let mut reader = BufReader::new(read);
    let mut buf = vec![0u8; SERVE_CHUNK];
    let mut rx = shared.tx.subscribe();
    while let Some(request) = read_request(&mut reader).await? {
        let Some(total) = shared.lock().total else { return Ok(()) };
        if request.path != format!("/{}", shared.token) {
            write.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            return Ok(());
        }
        if !request.method_ok {
            write.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            return Ok(());
        }
        let (status, from, to) = match parse_range(request.range.as_deref(), total) {
            Want::Whole => ("200 OK", 0, total.saturating_sub(1)),
            Want::Part(from, to) => ("206 Partial Content", from, to),
            Want::Unsatisfiable => {
                let head = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\n\r\n");
                write.write_all(head.as_bytes()).await?;
                continue;
            }
        };
        // an empty file has no byte 0 to send
        let len = if total == 0 { 0 } else { to + 1 - from };
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n");
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {from}-{to}/{total}\r\n"));
        }
        head.push_str("\r\n");
        write.write_all(head.as_bytes()).await?;
        if request.head_only {
            continue;
        }
        shared.note_head(from);
        let (mut at, end) = (from, from + len);
        while at < end {
            match shared.read_cached(at, end, &mut buf) {
                Read::Data(n) => {
                    write.write_all(&buf[..n]).await?;
                    at += n as u64;
                }
                Read::Failed(message) => return Err(io::Error::other(message)),
                Read::Wait => {
                    tokio::select! {
                        changed = rx.changed() => if changed.is_err() { return Ok(()) },
                        () = peer_closed(reader.get_ref()) => return Ok(()),
                    }
                }
            }
        }
        if request.close {
            return Ok(());
        }
    }
    Ok(())
}

async fn accept_loop(shared: Arc<Shared>, listener: TcpListener, cancel: CancellationToken) {
    loop {
        let socket = tokio::select! {
            () = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted { Ok((socket, _)) => socket, Err(_) => continue },
        };
        if shared.connections.fetch_add(1, Ordering::Relaxed) >= MAX_CONNECTIONS {
            shared.connections.fetch_sub(1, Ordering::Relaxed);
            continue;
        }
        let (shared, cancel) = (shared.clone(), cancel.clone());
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                result = serve_connection(shared.clone(), socket) => {
                    if let Err(e) = result {
                        tracing::debug!(error = %e, "read-ahead connection ended");
                    }
                }
            }
            shared.connections.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

// ---- the public handle ----

pub struct Opts<'a> {
    pub url: &'a str,
    pub headers: &'a BTreeMap<String, String>,
    /// The cache root; everything lives in `<root>/vokko-stremio-bot/`.
    pub root: &'a Path,
    /// Names the session's directory (reduced to safe characters).
    pub session: &'a str,
    pub cap: u64,
    /// ffprobe's bit rate of the file, else it is worked out from the size and `duration_ms`.
    pub bit_rate: Option<u64>,
    pub duration_ms: Option<u64>,
}

pub struct ReadAhead {
    shared: Arc<Shared>,
    cancel: CancellationToken,
    port: u16,
    bit_rate: u64,
}

impl Drop for ReadAhead {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Stats {
    pub ahead_bytes: u64,
    /// Media ahead of the playhead at the file's bit rate.
    pub ahead_ms: u64,
    pub cached_bytes: u64,
    /// Source download rate since the previous call.
    pub read_mbit: f64,
    pub requests: u64,
    pub reconnects: u64,
}

static SEQ: AtomicU64 = AtomicU64::new(1);

fn safe_name(session: &str) -> String {
    let name: String = session.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
    format!("p{}-{name}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

fn random_token() -> String {
    format!("{:032x}", rand::random::<u128>())
}

impl ReadAhead {
    /// Starts the fill and the loopback server; resolves once the source has answered (so the file's size is known).
    pub async fn start(opts: Opts<'_>) -> Result<Self, String> {
        let cap = opts.cap.max(MIN_CAP);
        let dir = opts.root.join(SUBDIR).join(safe_name(opts.session));
        make_dir(&dir).map_err(|e| format!("cannot create the cache directory: {e}"))?;
        let lock =
            File::options().create(true).write(true).truncate(false).open(dir.join(LOCK_FILE)).map_err(|e| format!("cannot create the cache lock: {e}"))?;
        lock.try_lock().map_err(|e| format!("cannot lock the cache directory: {e}"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("cannot build the download client: {e}"))?;
        let (tx, mut rx) = watch::channel(0u64);
        let shared = Arc::new(Shared {
            url: opts.url.to_owned(),
            headers: opts.headers.clone(),
            client,
            dir,
            cap,
            block: (cap / 8).clamp(64 << 10, 32 << 20),
            token: random_token(),
            state: Mutex::new(State::default()),
            tx,
            read_total: AtomicU64::new(0),
            rate: Mutex::new((0, Instant::now())),
            connections: AtomicUsize::new(0),
            lock: Some(lock),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let cancel = CancellationToken::new();
        tokio::spawn(reader(shared.clone(), cancel.clone()));
        tokio::spawn(accept_loop(shared.clone(), listener, cancel.clone()));
        let mut this = Self { shared: shared.clone(), cancel, port, bit_rate: FALLBACK_BITRATE };
        let deadline = tokio::time::Instant::now() + FIRST_RESPONSE_WAIT;
        let total = loop {
            {
                let st = shared.lock();
                if let Some(message) = &st.fatal {
                    return Err(message.clone());
                }
                if let Some(total) = st.total {
                    break total;
                }
            }
            tokio::select! {
                changed = rx.changed() => if changed.is_err() { return Err("read-ahead stopped".into()) },
                () = tokio::time::sleep_until(deadline) => return Err("the source did not answer".into()),
            }
        };
        this.bit_rate = opts
            .bit_rate
            .filter(|b| *b > 0)
            .or_else(|| opts.duration_ms.filter(|d| *d > 0).map(|d| total.saturating_mul(8000) / d))
            .filter(|b| *b > 0)
            .unwrap_or(FALLBACK_BITRATE);
        Ok(this)
    }

    /// What ffmpeg opens as its input.
    pub fn input_url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.shared.token)
    }

    pub fn cap(&self) -> u64 {
        self.shared.cap
    }

    /// Seconds of media the cap holds at the file's bit rate.
    pub fn cap_secs(&self) -> u64 {
        self.shared.cap * 8 / self.bit_rate
    }

    pub fn bit_rate(&self) -> u64 {
        self.bit_rate
    }

    /// The source stopped answering for good; ffmpeg's exit then is a failure, not the end of the film.
    pub fn failed(&self) -> bool {
        self.shared.lock().fatal.is_some()
    }

    /// A latch for one run of ffmpeg: its first frame waits until a few seconds are buffered.
    pub fn gate(&self) -> Arc<Gate> {
        let need = (self.bit_rate / 8 * PRIME_SECS).min(self.shared.cap / 4);
        Arc::new(Gate { shared: self.shared.clone(), need, done: AtomicBool::new(false) })
    }

    pub fn stats(&self) -> Stats {
        let (ahead, cached, requests, reconnects) = {
            let st = self.shared.lock();
            (st.have.run_end(st.pos) - st.pos, st.have.bytes(), st.requests, st.reconnects)
        };
        let read = self.shared.read_total.load(Ordering::Relaxed);
        let read_mbit = {
            let mut last = self.shared.rate.lock().unwrap_or_else(|e| e.into_inner());
            let secs = last.1.elapsed().as_secs_f64().max(0.001);
            let rate = (read - last.0) as f64 * 8.0 / secs / 1e6;
            *last = (read, Instant::now());
            rate
        };
        Stats { ahead_bytes: ahead, ahead_ms: ahead * 8000 / self.bit_rate, cached_bytes: cached, read_mbit, requests, reconnects }
    }

    #[cfg(test)]
    fn dir(&self) -> PathBuf {
        self.shared.dir.clone()
    }
}

pub struct Gate {
    shared: Arc<Shared>,
    need: u64,
    done: AtomicBool,
}

impl Gate {
    /// Returns when enough is buffered ahead of the playhead, the file ends, the source fails or `PRIME_MAX` has passed; stays open after that.
    pub async fn primed(&self) {
        if self.done.load(Ordering::Relaxed) {
            return;
        }
        let mut rx = self.shared.tx.subscribe();
        let deadline = tokio::time::Instant::now() + PRIME_MAX;
        loop {
            let ready = {
                let st = self.shared.lock();
                let end = st.have.run_end(st.pos);
                end - st.pos >= self.need || st.total.is_some_and(|t| end >= t) || st.fatal.is_some()
            };
            if ready {
                break;
            }
            tokio::select! {
                changed = rx.changed() => if changed.is_err() { break },
                () = tokio::time::sleep_until(deadline) => break,
            }
        }
        self.done.store(true, Ordering::Relaxed);
    }
}

/// Removes what earlier runs of the bot left in `<root>/vokko-stremio-bot/`: every session directory nobody holds. A live session keeps
/// its `.lock` file locked (the OS drops the lock when the process dies, so a reused pid cannot fool this), which is how a bot that
/// still runs (another instance on this machine) keeps its directories.
pub fn wipe_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root.join(SUBDIR)) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        match File::options().write(true).open(path.join(LOCK_FILE)) {
            Ok(lock) => match lock.try_lock() {
                // closed before the delete: Windows cannot delete an open file
                Ok(()) => drop(lock),
                Err(_) => continue,
            },
            // no lock file: the session never got that far
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[cfg(test)]
mod tests;
