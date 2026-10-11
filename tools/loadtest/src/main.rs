//! `vokko-loadtest`: load generator for vokko-server (REST + gateway), see `docs/audits/load-2026-10.md`.
//!
//! ```text
//! vokko-loadtest --url http://127.0.0.1:8710 --connections 200 --server-pid $(pgrep -f target/release/vokko-server) --sample-postgres
//! ```
//! Needs a server started with `VOKKO_TRUST_PROXY=on` (the default `--spoof` gives every simulated client its own address
//! through `X-Forwarded-For`; without it all clients share 127.0.0.1 and the per-address limits cap the run).
mod api;
mod gateway;
mod report;
mod scenarios;
mod stats;
mod sys;
mod world;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::api::Api;
use crate::report::Report;
use crate::stats::Shared;
use crate::sys::Sampler;
use crate::world::World;

pub struct Args {
    pub url: String,
    pub connections: usize,
    pub guild_size: usize,
    pub duration: u64,
    pub scenarios: Vec<String>,
    pub send_rate: f64,
    pub sender_fraction: f64,
    pub typing_fraction: f64,
    pub presence_fraction: f64,
    pub history_fraction: f64,
    pub history_pages: usize,
    pub storm_fraction: f64,
    pub storm_offline_ms: u64,
    pub ramp: usize,
    pub server_pid: Option<u32>,
    pub sample_postgres: bool,
    pub spoof: bool,
    pub out: Option<String>,
    pub label: String,
}

const ALL_SCENARIOS: [&str; 6] = ["connect", "send", "typing", "presence", "history", "reconnect"];

const HELP: &str = "vokko-loadtest [options]
  --url URL                 server base URL (default http://127.0.0.1:8710)
  --connections N           simulated users = gateway connections (default 50)
  --guild-size N            members per guild (default 100); every guild has 3 text channels
  --duration SECS           length of the send/typing/presence scenarios (default 30)
  --scenarios LIST          comma separated: connect,send,typing,presence,history,reconnect (default all)
  --send-rate R             messages/s per sender, capped at 5 (default 1)
  --sender-fraction F       share of each guild that sends (default 0.2)
  --typing-fraction F       share of each guild firing typing bursts (default 0.3)
  --presence-fraction F     share of users changing presence, <= 4 times each (default 0.5)
  --history-fraction F      share of users paginating history (default 0.2)
  --history-pages N         pages of 100 per reader (default 10)
  --storm-fraction F        share of connections cut in the reconnect storm (default 0.5)
  --storm-offline-ms MS     time the cut connections stay away (default 2000)
  --ramp N                  concurrent gateway handshakes while connecting (default 100)
  --server-pid PID          sample this process' CPU and RSS
  --sample-postgres         sample the CPU and RSS of all postgres processes
  --no-spoof                do not send X-Forwarded-For (all clients share one address)
  --out FILE                write the full report as JSON
  --label TEXT              free text stored in the report";

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from(arguments: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut args = Args {
        url: "http://127.0.0.1:8710".to_owned(),
        connections: 50,
        guild_size: 100,
        duration: 30,
        scenarios: ALL_SCENARIOS.iter().map(|name| (*name).to_owned()).collect(),
        send_rate: 1.0,
        sender_fraction: 0.2,
        typing_fraction: 0.3,
        presence_fraction: 0.5,
        history_fraction: 0.2,
        history_pages: 10,
        storm_fraction: 0.5,
        storm_offline_ms: 2000,
        ramp: 100,
        server_pid: None,
        sample_postgres: false,
        spoof: true,
        out: None,
        label: String::new(),
    };
    let mut iter = arguments.into_iter();
    while let Some(flag) = iter.next() {
        let mut value = |name: &str| iter.next().ok_or_else(|| format!("{name} needs a value"));
        fn number<T: std::str::FromStr>(name: &str, text: String) -> Result<T, String> {
            text.parse().map_err(|_| format!("{name}: cannot parse {text}"))
        }
        match flag.as_str() {
            "--url" => args.url = value(&flag)?,
            "--connections" => args.connections = number(&flag, value(&flag)?)?,
            "--guild-size" => args.guild_size = number(&flag, value(&flag)?)?,
            "--duration" => args.duration = number(&flag, value(&flag)?)?,
            "--scenarios" => args.scenarios = value(&flag)?.split(',').map(|name| name.trim().to_owned()).collect(),
            "--send-rate" => args.send_rate = number(&flag, value(&flag)?)?,
            "--sender-fraction" => args.sender_fraction = number(&flag, value(&flag)?)?,
            "--typing-fraction" => args.typing_fraction = number(&flag, value(&flag)?)?,
            "--presence-fraction" => args.presence_fraction = number(&flag, value(&flag)?)?,
            "--history-fraction" => args.history_fraction = number(&flag, value(&flag)?)?,
            "--history-pages" => args.history_pages = number(&flag, value(&flag)?)?,
            "--storm-fraction" => args.storm_fraction = number(&flag, value(&flag)?)?,
            "--storm-offline-ms" => args.storm_offline_ms = number(&flag, value(&flag)?)?,
            "--ramp" => args.ramp = number(&flag, value(&flag)?)?,
            "--server-pid" => args.server_pid = Some(number(&flag, value(&flag)?)?),
            "--sample-postgres" => args.sample_postgres = true,
            "--no-spoof" => args.spoof = false,
            "--out" => args.out = Some(value(&flag)?),
            "--label" => args.label = value(&flag)?,
            "--help" | "-h" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown option {other}\n{HELP}")),
        }
    }
    if !args.url.starts_with("http://") {
        return Err(format!("--url must start with http:// (TLS is not supported), got {}", args.url));
    }
    if args.connections == 0 {
        return Err("--connections must be at least 1".to_owned());
    }
    if let Some(unknown) = args.scenarios.iter().find(|name| !ALL_SCENARIOS.contains(&name.as_str())) {
        return Err(format!("unknown scenario {unknown}"));
    }
    Ok(args)
}

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("vokko-loadtest: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    // reqwest is built without a bundled TLS provider; the load test only speaks plain HTTP but the client wants one installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let shared = Arc::new(Shared::new());
    let api = Api::new(&args.url, shared.clone())?;
    let sampler = Sampler::start(args.server_pid, args.sample_postgres);
    let run_id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0) % 0xff_ffff);
    let duration = Duration::from_secs(args.duration);
    let mut reports: Vec<Report> = Vec::new();

    println!("vokko-loadtest: {} connections, guilds of {}, run {run_id}, server {}", args.connections, args.guild_size, args.url);
    let window =
        |name: &str, started: Instant, shared: &Shared, sampler: &Sampler| Report::new(name, started.elapsed(), &shared.swap().snapshot(), sampler.take());

    // Setup: users and guilds (REST only).
    let started = Instant::now();
    sampler.take();
    let mut world = World::register_users(api, shared.clone(), &args, &run_id).await?;
    reports.push(window("setup:register", started, &shared, &sampler));
    let started = Instant::now();
    world.build_guilds(args.guild_size).await?;
    reports.push(window("setup:guilds", started, &shared, &sampler));

    // Connect: every user opens a gateway connection and identifies.
    let started = Instant::now();
    let up = world.connect_all(args.ramp, &args.url).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut connect = window("connect", started, &shared, &sampler);
    connect.derive("connected", up as f64);
    connect.derive("requested", args.connections as f64);
    reports.push(connect);
    if up == 0 {
        return Err("no gateway connection could be established".to_owned());
    }

    for name in args.scenarios.iter().filter(|name| name.as_str() != "connect") {
        println!("running {name} ...");
        let started = Instant::now();
        sampler.take();
        match name.as_str() {
            "send" => scenarios::send(&world, args.sender_fraction, args.send_rate, duration).await,
            "typing" => scenarios::typing(&world, args.typing_fraction, duration).await,
            "presence" => scenarios::presence(&world, args.presence_fraction, duration).await,
            "history" => scenarios::history(&world, args.history_fraction, args.history_pages).await,
            "reconnect" => scenarios::reconnect(&world, &args).await,
            _ => {}
        }
        reports.push(window(name, started, &shared, &sampler));
    }
    world.disconnect_all().await;

    for report in &mut reports {
        report.finish();
        report.print();
    }
    report::summary(&reports);
    if let Some(path) = &args.out {
        let meta = BTreeMap::from([("label", args.label.clone()), ("url", args.url.clone()), ("run", run_id)]);
        report::write_json(path, &meta, &args, &reports)?;
        println!("wrote {path}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> Result<Args, String> {
        parse_args_from(arguments.iter().map(|argument| (*argument).to_owned()))
    }

    #[test]
    fn accepts_http_urls() {
        assert_eq!(parse(&[]).expect("defaults").url, "http://127.0.0.1:8710");
        assert_eq!(parse(&["--url", "http://example.test:9000"]).expect("http").url, "http://example.test:9000");
    }

    #[test]
    fn rejects_urls_that_are_not_http() {
        for url in ["https://example.test", "ws://example.test", "example.test:8710"] {
            let error = parse(&["--url", url]).err().unwrap_or_default();
            assert!(error.contains("--url must start with http://") && error.contains(url), "{url}: {error}");
        }
    }
}
