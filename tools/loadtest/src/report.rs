//! Console and JSON output.
use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;

use crate::Args;
use crate::stats::Snapshot;
use crate::sys::{QueryStat, Resources};

#[derive(Serialize)]
pub struct Report {
    pub name: String,
    pub seconds: f64,
    #[serde(flatten)]
    pub snapshot: Snapshot,
    pub derived: BTreeMap<String, f64>,
    pub resources: Resources,
    /// Top statements by total execution time in this window (`--pg-url`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub queries: Vec<QueryStat>,
}

impl Report {
    pub fn new(name: &str, elapsed: Duration, snapshot: &Snapshot, resources: Resources) -> Self {
        Self { name: name.to_owned(), seconds: elapsed.as_secs_f64(), snapshot: snapshot.clone(), derived: BTreeMap::new(), resources, queries: Vec::new() }
    }

    pub fn derive(&mut self, name: &str, value: f64) {
        self.derived.insert(name.to_owned(), value);
    }

    fn counter(&self, name: &str) -> f64 {
        self.snapshot.counters.get(name).copied().unwrap_or(0) as f64
    }

    /// Ratios and rates that follow from the raw counters.
    pub fn finish(&mut self) {
        for kind in ["message", "typing", "dm", "reaction", "voice_state"] {
            let expected = self.counter(&format!("expected:{kind}"));
            if expected > 0.0 {
                self.derive(&format!("delivered_ratio:{kind}"), self.counter(&format!("recv:{kind}")) / expected);
            }
        }
        let expected = self.counter("expected:presence");
        if expected > 0.0 {
            self.derive("delivered_ratio:presence", self.counter("recv:presence_stamped") / expected);
        }
        let sent = self.counter("sent:message");
        if sent > 0.0 && self.seconds > 0.0 {
            self.derive("sent_per_second:message", sent / self.seconds);
            self.derive("deliveries_per_second:message", self.counter("recv:message") / self.seconds);
        }
        let limit_hits: u64 = self.snapshot.counters.iter().filter(|(name, _)| name.starts_with("limit_hits:")).map(|(_, count)| *count).sum();
        self.derive("limit_hits", limit_hits as f64);
    }

    pub fn print(&self) {
        println!("\n== {} ({:.1}s)", self.name, self.seconds);
        if !self.snapshot.histograms.is_empty() {
            println!("  {:<24} {:>8} {:>10} {:>10} {:>10} {:>10} {:>10}", "latency (ms) / size (bytes)", "count", "p50", "p95", "p99", "max", "mean");
        }
        for (name, summary) in &self.snapshot.histograms {
            let scale = if name.starts_with("size:") { 1.0 } else { 1000.0 };
            let show = |value: u64| format!("{:.1}", value as f64 / scale);
            println!(
                "  {:<24} {:>8} {:>10} {:>10} {:>10} {:>10} {:>10}",
                name,
                summary.count,
                show(summary.p50),
                show(summary.p95),
                show(summary.p99),
                show(summary.max),
                show(summary.mean)
            );
        }
        for (name, count) in &self.snapshot.counters {
            println!("  {name}: {count}");
        }
        for (name, value) in &self.derived {
            println!("  {name}: {value:.3}");
        }
        for (error, count) in &self.snapshot.errors {
            println!("  ERROR {error}: {count}");
        }
        let line = |label: &str, usage: &Option<crate::sys::Usage>| {
            if let Some(usage) = usage {
                println!("  {label}: cpu avg {:.0}% max {:.0}% (100% = one core), rss max {:.0} MiB", usage.cpu_avg, usage.cpu_max, usage.rss_max_mib);
            }
        };
        line("server", &self.resources.server);
        line("postgres", &self.resources.postgres);
        line("loadgen", &self.resources.loadgen);
        if !self.queries.is_empty() {
            println!("  {:>8} {:>10} {:>8} {:>8}  top queries (total / mean ms)", "calls", "total", "mean", "rows");
        }
        for query in self.queries.iter().take(12) {
            println!("  {:>8} {:>10.1} {:>8.3} {:>8}  {}", query.calls, query.total_ms, query.mean_ms, query.rows, query.query);
        }
    }
}

/// One line per scenario that hit a documented limit: those numbers measure the limiter, not the server.
pub fn summary(reports: &[Report]) {
    let hits: Vec<&Report> = reports.iter().filter(|report| report.derived.get("limit_hits").copied().unwrap_or(0.0) > 0.0).collect();
    println!();
    if hits.is_empty() {
        println!("limit hits: none (no 429, no gateway 4008)");
    }
    for report in hits {
        println!(
            "LIMIT HITS in {}: {} (the harness exceeded a documented limit; do not read this scenario's latencies as server capacity)",
            report.name, report.derived["limit_hits"]
        );
    }
}

#[derive(Serialize)]
struct Document<'a> {
    meta: &'a BTreeMap<&'static str, String>,
    config: Config<'a>,
    scenarios: &'a [Report],
}

#[derive(Serialize)]
struct Config<'a> {
    connections: usize,
    guild_size: usize,
    duration: u64,
    send_rate: f64,
    sender_fraction: f64,
    everyone_share: f64,
    typing_fraction: f64,
    presence_fraction: f64,
    history_fraction: f64,
    history_pages: usize,
    dm_fraction: f64,
    reaction_fraction: f64,
    voice_fraction: f64,
    storm_fraction: f64,
    storm_offline_ms: u64,
    spoof: bool,
    scenarios: &'a [String],
}

pub fn write_json(path: &str, meta: &BTreeMap<&'static str, String>, args: &Args, reports: &[Report]) -> Result<(), String> {
    let config = Config {
        connections: args.connections,
        guild_size: args.guild_size,
        duration: args.duration,
        send_rate: args.send_rate,
        sender_fraction: args.sender_fraction,
        everyone_share: args.everyone_share,
        typing_fraction: args.typing_fraction,
        presence_fraction: args.presence_fraction,
        history_fraction: args.history_fraction,
        history_pages: args.history_pages,
        dm_fraction: args.dm_fraction,
        reaction_fraction: args.reaction_fraction,
        voice_fraction: args.voice_fraction,
        storm_fraction: args.storm_fraction,
        storm_offline_ms: args.storm_offline_ms,
        spoof: args.spoof,
        scenarios: &args.scenarios,
    };
    let text = serde_json::to_string_pretty(&Document { meta, config, scenarios: reports }).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("cannot write {path}: {error}"))
}
