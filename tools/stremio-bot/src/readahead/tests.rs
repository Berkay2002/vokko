//! Tests run against a fake source (a local Range-capable HTTP server that can stall, cut a connection and log its requests).

use std::sync::atomic::AtomicBool;

use super::*;

fn init() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vokko-readahead-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp root");
    dir
}

/// Byte `i` of the generated test file.
fn pattern(i: u64) -> u8 {
    (i % 251) as u8
}

fn check(at: u64, bytes: &[u8]) {
    for (i, b) in bytes.iter().enumerate() {
        assert_eq!(*b, pattern(at + i as u64), "byte {} differs", at + i as u64);
    }
}

#[derive(Default)]
struct Fake {
    total: u64,
    /// A real file to serve instead of the generated pattern.
    data: Option<Vec<u8>>,
    /// The first response is cut after this many bytes.
    cut_once_at: Option<u64>,
    /// The first response to cross this offset stops there for a while.
    stall: Option<(u64, Duration)>,
    /// Pause after every 64 KiB.
    throttle: Option<Duration>,
    cut_done: AtomicBool,
    stalled: AtomicBool,
    requests: Mutex<Vec<u64>>,
}

impl Fake {
    fn requests(&self) -> Vec<u64> {
        self.requests.lock().expect("lock").clone()
    }

    fn slice(&self, at: u64, n: usize, cycle: &[u8]) -> Vec<u8> {
        match &self.data {
            Some(data) => data[at as usize..at as usize + n].to_vec(),
            None => cycle[(at % 251) as usize..][..n].to_vec(),
        }
    }
}

async fn start_fake(fake: Fake) -> (Arc<Fake>, String) {
    let fake = Arc::new(Fake { total: fake.data.as_ref().map_or(fake.total, |d| d.len() as u64), ..fake });
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://127.0.0.1:{}/media.mp4", listener.local_addr().expect("addr").port());
    let served = fake.clone();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else { return };
            let fake = served.clone();
            tokio::spawn(async move {
                let _ = fake_connection(fake, socket).await;
            });
        }
    });
    (fake, url)
}

async fn fake_connection(fake: Arc<Fake>, socket: TcpStream) -> io::Result<()> {
    let cycle: Vec<u8> = (0..251 + 65_536).map(|i| (i % 251) as u8).collect();
    let (read, mut write) = socket.into_split();
    let mut reader = BufReader::new(read);
    loop {
        let mut range = None;
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).await? == 0 {
                return Ok(());
            }
            if line.trim().is_empty() {
                break;
            }
            if let Some(spec) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                let (a, b) = spec.trim().split_once('-').expect("range");
                range = Some((a.parse::<u64>().expect("from"), b.parse::<u64>().ok()));
            }
        }
        let (from, to) = range.map_or((0, fake.total - 1), |(a, b)| (a, b.unwrap_or(fake.total - 1).min(fake.total - 1)));
        let first = {
            let mut requests = fake.requests.lock().expect("lock");
            requests.push(from);
            requests.len() == 1
        };
        let head = if range.is_some() {
            format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{to}/{}\r\nContent-Length: {}\r\n\r\n", fake.total, to + 1 - from)
        } else {
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", fake.total)
        };
        write.write_all(head.as_bytes()).await?;
        let mut at = from;
        while at <= to {
            let n = (to + 1 - at).min(65_536);
            if let Some(cut) = fake.cut_once_at.filter(|c| first && at <= *c && at + n > *c)
                && !fake.cut_done.swap(true, Ordering::SeqCst)
            {
                write.write_all(&fake.slice(at, (cut - at) as usize, &cycle)).await?;
                return Ok(());
            }
            if let Some((_, pause)) = fake.stall.filter(|(o, _)| at <= *o && at + n > *o)
                && !fake.stalled.swap(true, Ordering::SeqCst)
            {
                tokio::time::sleep(pause).await;
            }
            write.write_all(&fake.slice(at, n as usize, &cycle)).await?;
            at += n;
            if let Some(pause) = fake.throttle {
                tokio::time::sleep(pause).await;
            }
        }
    }
}

async fn open(url: &str, root: &Path, cap: u64, bit_rate: u64) -> ReadAhead {
    init();
    ReadAhead::start(Opts { url, headers: &BTreeMap::new(), root, session: "42", cap, bit_rate: Some(bit_rate), duration_ms: None }).await.expect("start")
}

fn client() -> reqwest::Client {
    init();
    reqwest::Client::builder().no_proxy().build().expect("client")
}

async fn fetch(ra: &ReadAhead, range: &str) -> (u16, Vec<u8>) {
    let response = client().get(ra.input_url()).header("Range", range).send().await.expect("proxy answers");
    (response.status().as_u16(), response.bytes().await.expect("body").to_vec())
}

async fn until(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while !done() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[test]
fn ranges_merge_split_and_find_runs() {
    let mut r = Ranges::default();
    r.insert(10, 20);
    r.insert(30, 40);
    r.insert(20, 30);
    assert_eq!(r.0.iter().collect::<Vec<_>>(), [(&10, &40)]);
    r.insert(5, 12);
    r.insert(35, 50);
    assert_eq!((r.0.len(), r.bytes(), r.run_end(7), r.run_end(49), r.run_end(50), r.run_end(3)), (1, 45, 50, 50, 50, 3));
    r.remove(20, 30);
    assert_eq!(r.0.iter().collect::<Vec<_>>(), [(&5, &20), (&30, &50)]);
    assert!(r.contains(19) && !r.contains(20) && !r.contains(29) && r.contains(30) && !r.contains(50));
    r.remove(0, 100);
    assert_eq!(r.bytes(), 0);
}

#[test]
fn range_headers() {
    assert_eq!(parse_range(None, 100), Want::Whole);
    assert_eq!(parse_range(Some("bytes=10-"), 100), Want::Part(10, 99));
    assert_eq!(parse_range(Some("bytes=10-19"), 100), Want::Part(10, 19));
    assert_eq!(parse_range(Some("bytes=90-500"), 100), Want::Part(90, 99));
    assert_eq!(parse_range(Some("bytes=-30"), 100), Want::Part(70, 99));
    assert_eq!(parse_range(Some("bytes=100-"), 100), Want::Unsatisfiable);
    assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Want::Whole);
    assert_eq!(parse_range(Some("items=0-1"), 100), Want::Whole);
}

#[tokio::test]
async fn serves_ranges_byte_exact_across_blocks() {
    let root = temp_root("ranges");
    let (_fake, url) = start_fake(Fake { total: 3_000_000, ..Fake::default() }).await;
    let ra = open(&url, &root, MIN_CAP, 8_000_000).await;
    assert!(ra.input_url().starts_with("http://127.0.0.1:"));
    // the 8 MiB cap makes 1 MiB blocks; this range crosses the boundary at 1_048_576
    let (status, body) = fetch(&ra, "bytes=1000000-1100000").await;
    assert_eq!((status, body.len()), (206, 100_001));
    check(1_000_000, &body);
    let (_, body) = fetch(&ra, "bytes=-500").await;
    assert_eq!(body.len(), 500);
    check(3_000_000 - 500, &body);
    let (status, body) = fetch(&ra, "bytes=2999999-").await;
    assert_eq!((status, body.len()), (206, 1));
    let (status, body) = fetch(&ra, "bytes=3000000-").await;
    assert_eq!((status, body.len()), (416, 0));
    let response = client().get(ra.input_url()).send().await.expect("whole file");
    assert_eq!((response.status().as_u16(), response.content_length()), (200, Some(3_000_000)));
    let wrong = client().get(format!("{}x", ra.input_url())).send().await.expect("404");
    assert_eq!(wrong.status().as_u16(), 404);
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn the_cap_holds_while_playing_through_a_file_five_times_its_size() {
    let root = temp_root("cap");
    let cap = MIN_CAP;
    let (fake, url) = start_fake(Fake { total: 40 << 20, ..Fake::default() }).await;
    let ra = open(&url, &root, cap, 8_000_000).await;
    // nobody plays: the fill stops at the cap and stays there
    until("the cap to fill", 10, || ra.stats().cached_bytes + (1 << 20) >= cap).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let idle = ra.stats();
    assert!(idle.cached_bytes <= cap && idle.cached_bytes + (2 << 20) >= cap, "{idle:?}");
    assert_eq!(fake.requests(), [0], "one request, no churn at the cap");
    // playing through: blocks behind the playhead go, the bytes stay right and the cap is never exceeded
    let mut response = client().get(ra.input_url()).header("Range", "bytes=0-").send().await.expect("play");
    let (mut at, mut most) = (0u64, 0u64);
    while let Some(chunk) = response.chunk().await.expect("chunk") {
        check(at, &chunk);
        at += chunk.len() as u64;
        most = most.max(ra.stats().cached_bytes);
    }
    assert_eq!(at, 40 << 20);
    assert!(most <= cap, "{most} > {cap}");
    assert!(std::fs::read_dir(ra.dir()).expect("dir").count() as u64 <= cap / (cap / 8) + 1, "evicted blocks are deleted");
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_seek_back_into_cached_data_refetches_nothing_and_a_seek_outside_fills_there() {
    let root = temp_root("seek");
    // 200 MB at about 64 MB/s
    let (fake, url) = start_fake(Fake { total: 200_000_000, throttle: Some(Duration::from_millis(1)), ..Fake::default() }).await;
    let ra = open(&url, &root, DEFAULT_CAP, 8_000_000).await;
    until("20 MB", 20, || ra.stats().cached_bytes >= 20_000_000).await;
    // inside the run the fill is extending: no new request, and the bytes come from disk
    let (_, body) = fetch(&ra, "bytes=5000000-5999999").await;
    check(5_000_000, &body);
    assert_eq!(body.len(), 1_000_000);
    assert_eq!(fake.requests(), [0], "a seek back inside the cache opens nothing");
    // far outside: a new fill starts at the new offset
    let (_, body) = fetch(&ra, "bytes=150000000-150999999").await;
    check(150_000_000, &body);
    let requests = fake.requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert_eq!(requests[1], 150_000_000);
    // back into the first run, which is not touching the fill any more: its bytes are served from disk; the fill goes on at the gap
    let before = fake.requests().len();
    let (_, body) = fetch(&ra, "bytes=1000000-1999999").await;
    check(1_000_000, &body);
    let requests = fake.requests();
    assert!(requests[before..].iter().all(|r| *r >= 20_000_000), "cached bytes were fetched again: {requests:?}");
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_dropped_source_connection_is_resumed_where_it_broke() {
    let root = temp_root("reconnect");
    let (fake, url) = start_fake(Fake { total: 12_000_000, cut_once_at: Some(5_000_000), ..Fake::default() }).await;
    let ra = open(&url, &root, DEFAULT_CAP, 8_000_000).await;
    let (status, body) = fetch(&ra, "bytes=0-").await;
    assert_eq!((status, body.len()), (206, 12_000_000));
    check(0, &body);
    let requests = fake.requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!((4_000_000..=5_000_000).contains(&requests[1]), "resumed at {}", requests[1]);
    assert!(ra.stats().reconnects >= 1 && !ra.failed());
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_five_second_source_stall_does_not_reach_a_primed_reader() {
    let root = temp_root("stall");
    // 2 MB/s of media; the source hands over 12 MB at once, freezes for 5 s, then delivers the rest
    let (fake, url) = start_fake(Fake { total: 16_000_000, stall: Some((12_000_000, Duration::from_secs(5))), ..Fake::default() }).await;
    let ra = open(&url, &root, DEFAULT_CAP, 16_000_000).await;
    ra.gate().primed().await;
    assert!(ra.stats().ahead_ms >= 5_000, "primed with {} ms", ra.stats().ahead_ms);
    let mut response = client().get(ra.input_url()).header("Range", "bytes=0-").send().await.expect("play");
    let (mut at, mut worst) = (0u64, Duration::ZERO);
    loop {
        let asked = Instant::now();
        let Some(chunk) = response.chunk().await.expect("chunk") else { break };
        worst = worst.max(asked.elapsed());
        check(at, &chunk);
        at += chunk.len() as u64;
        // ffmpeg's pace: 2 MB of media per second
        tokio::time::sleep(Duration::from_micros(chunk.len() as u64 / 2)).await;
    }
    assert_eq!(at, 16_000_000);
    assert!(fake.stalled.load(Ordering::SeqCst), "the source did stall");
    assert!(worst < Duration::from_millis(500), "the reader waited {worst:?} for data");
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_4k_bitrate_source_fills_more_than_a_minute_ahead() {
    let root = temp_root("4k");
    // 80 Mbit/s is 10 MB/s: 650 MB is 65 s of film
    let (_fake, url) = start_fake(Fake { total: 650_000_000, ..Fake::default() }).await;
    let ra = open(&url, &root, DEFAULT_CAP, 80_000_000).await;
    assert!(ra.cap_secs() > 200, "2 GiB hold {} s at 80 Mbit/s", ra.cap_secs());
    until("a minute ahead", 90, || ra.stats().ahead_ms >= 60_000).await;
    let stats = ra.stats();
    assert!(stats.ahead_bytes >= 600_000_000 && stats.cached_bytes <= DEFAULT_CAP, "{stats:?}");
    drop(ra);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn the_session_directory_goes_with_the_session() {
    let root = temp_root("cleanup");
    let (_fake, url) = start_fake(Fake { total: 2_000_000, ..Fake::default() }).await;
    let ra = open(&url, &root, DEFAULT_CAP, 8_000_000).await;
    until("the file", 10, || ra.stats().cached_bytes == 2_000_000).await;
    let dir = ra.dir();
    assert!(dir.starts_with(root.join(SUBDIR)) && std::fs::read_dir(&dir).expect("dir").count() > 0);
    drop(ra);
    until("the directory to go", 5, || !dir.exists()).await;
    assert!(root.join(SUBDIR).exists(), "only the session's own directory goes");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn stale_directories_are_wiped_at_startup_and_nothing_else() {
    let root = temp_root("wipe");
    let base = root.join(SUBDIR);
    let own = base.join("p1-mine-1");
    let dead = base.join("p4000000000-old-1");
    let junk = base.join("junk");
    for dir in [&own, &dead, &junk] {
        std::fs::create_dir_all(dir).expect("dir");
        std::fs::write(dir.join("0.blk"), b"x").expect("file");
    }
    // a running session holds its lock file; a dead one left the file behind unlocked
    std::fs::write(dead.join(LOCK_FILE), b"").expect("file");
    let held = File::options().create(true).write(true).truncate(false).open(own.join(LOCK_FILE)).expect("lock file");
    held.try_lock().expect("lock");
    std::fs::write(base.join("stray"), b"x").expect("file");
    let outside = root.join("other");
    std::fs::create_dir_all(&outside).expect("dir");
    wipe_stale(&root);
    assert!(own.exists() && !dead.exists() && !junk.exists() && !base.join("stray").exists(), "a running bot's directory stays");
    assert!(outside.exists(), "nothing outside vokko-stremio-bot is touched");
    drop(held);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn session_names_are_one_safe_path_component() {
    let name = safe_name("../../etc/passwd\\x:y");
    assert!(!name.contains(['/', '\\', ':', '.']) && name.starts_with('p'), "{name}");
    assert_ne!(safe_name("1"), safe_name("1"), "a counter keeps two runs apart");
}

fn have_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// ffmpeg itself reads real mp4 files (index at the end, and at the front) through the proxy, with the production input flags and a seek.
#[tokio::test]
async fn ffmpeg_reads_mp4_through_the_proxy() {
    if !have_ffmpeg() {
        eprintln!("ffmpeg not installed: skipped");
        return;
    }
    let root = temp_root("ffmpeg");
    for (name, faststart) in [("tail", false), ("front", true)] {
        let file = root.join(format!("{name}.mp4"));
        let mut make = std::process::Command::new("ffmpeg");
        make.args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=duration=4"]);
        make.args(["-c:v", "mpeg4", "-c:a", "aac"]);
        if faststart {
            make.args(["-movflags", "+faststart"]);
        }
        let made = make.arg(&file).output().expect("ffmpeg runs");
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let data = std::fs::read(&file).expect("mp4");
        let (fake, url) = start_fake(Fake { data: Some(data), ..Fake::default() }).await;
        let ra = open(&url, &root, DEFAULT_CAP, 1_000_000).await;
        for seek in [None, Some("1.5")] {
            let mut args = crate::plan::input_args();
            if let Some(seek) = seek {
                args.extend(["-ss".to_owned(), seek.to_owned()]);
            }
            args.extend(["-i".to_owned(), ra.input_url(), "-f".to_owned(), "null".to_owned(), "-".to_owned()]);
            let run = tokio::time::timeout(
                Duration::from_secs(60),
                tokio::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "warning"]).args(&args).kill_on_drop(true).output(),
            )
            .await
            .expect("ffmpeg finishes")
            .expect("ffmpeg runs");
            let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
            assert!(run.status.success() && stderr.trim().is_empty(), "{name} seek {seek:?}: {stderr}");
        }
        eprintln!("{name}: {} source requests", fake.requests().len());
        drop(ra);
    }
    let _ = std::fs::remove_dir_all(&root);
}
