//! Process CPU / RSS sampling from `/proc` (Linux only; everything is `None` elsewhere).
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

/// Assumes the usual Linux USER_HZ of 100 (what `sysconf(_SC_CLK_TCK)` returns on x86-64 and arm64); `/proc/<pid>/stat` times are in these
/// ticks. A kernel built with another USER_HZ would scale every CPU figure by the ratio.
const CLOCK_TICKS_PER_SECOND: f64 = 100.0;

#[derive(Clone, Copy, Default)]
struct Reading {
    ticks: u64,
    rss_kb: u64,
}

struct Sample {
    at: Instant,
    server: Option<Reading>,
    postgres: Option<Reading>,
    loadgen: Option<Reading>,
}

/// CPU in percent of one core (100 = one core fully busy); RSS in MiB.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Usage {
    pub cpu_avg: f64,
    pub cpu_max: f64,
    pub rss_max_mib: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Resources {
    pub server: Option<Usage>,
    pub postgres: Option<Usage>,
    pub loadgen: Option<Usage>,
}

pub struct Sampler {
    samples: Arc<Mutex<Vec<Sample>>>,
    server_pid: Option<u32>,
    postgres: bool,
}

fn sample_now(server_pid: Option<u32>, postgres: bool) -> Sample {
    Sample {
        at: Instant::now(),
        server: server_pid.and_then(read_process),
        postgres: if postgres { read_postgres() } else { None },
        loadgen: read_process(std::process::id()),
    }
}

/// utime + stime in clock ticks and the resident set of one process.
fn read_process(pid: u32) -> Option<Reading> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks = parse_stat_ticks(&stat)?;
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
    let rss_kb =
        status.lines().find_map(|line| line.strip_prefix("VmRSS:")).and_then(|rest| rest.split_whitespace().next()).and_then(|v| v.parse().ok()).unwrap_or(0);
    Some(Reading { ticks, rss_kb })
}

fn parse_stat_ticks(stat: &str) -> Option<u64> {
    // The command name is parenthesised and may contain spaces; the numeric fields follow the last ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // state(0) ... utime(11) stime(12)
    Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
}

/// Sum over every process whose command is `postgres` (postmaster, backends, background workers).
fn read_postgres() -> Option<Reading> {
    let mut total = Reading::default();
    let mut found = false;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) else { continue };
        if comm.trim() == "postgres"
            && let Some(reading) = read_process(pid)
        {
            total.ticks += reading.ticks;
            total.rss_kb += reading.rss_kb;
            found = true;
        }
    }
    found.then_some(total)
}

fn usage(samples: &[Sample], pick: impl Fn(&Sample) -> Option<Reading>) -> Option<Usage> {
    let readings: Vec<(Instant, Reading)> = samples.iter().filter_map(|sample| pick(sample).map(|reading| (sample.at, reading))).collect();
    let (first, last) = (readings.first()?, readings.last()?);
    let wall = last.0.saturating_duration_since(first.0).as_secs_f64();
    let cpu = |a: &(Instant, Reading), b: &(Instant, Reading)| {
        let seconds = b.0.saturating_duration_since(a.0).as_secs_f64();
        if seconds <= 0.0 { 0.0 } else { b.1.ticks.saturating_sub(a.1.ticks) as f64 / CLOCK_TICKS_PER_SECOND / seconds * 100.0 }
    };
    Some(Usage {
        cpu_avg: if wall > 0.0 { cpu(first, last) } else { 0.0 },
        cpu_max: readings.windows(2).map(|pair| cpu(&pair[0], &pair[1])).fold(0.0, f64::max),
        rss_max_mib: readings.iter().map(|(_, reading)| reading.rss_kb).max().unwrap_or(0) as f64 / 1024.0,
    })
}

impl Sampler {
    pub fn start(server_pid: Option<u32>, postgres: bool) -> Self {
        let samples = Arc::new(Mutex::new(Vec::new()));
        let sink = samples.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                ticker.tick().await;
                let sample = sample_now(server_pid, postgres);
                sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sample);
            }
        });
        let sampler = Self { samples, server_pid, postgres };
        // the first window starts here
        sampler.samples.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sample_now(server_pid, postgres));
        sampler
    }

    /// Usage since the previous call. Both ends of the window are sampled exactly, so short windows work too.
    pub fn take(&self) -> Resources {
        let end = sample_now(self.server_pid, self.postgres);
        let mut guard = self.samples.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut samples = std::mem::take(&mut *guard);
        // the end sample doubles as the next window's baseline
        guard.push(Sample { at: end.at, server: end.server, postgres: end.postgres, loadgen: end.loadgen });
        drop(guard);
        samples.push(end);
        Resources { server: usage(&samples, |s| s.server), postgres: usage(&samples, |s| s.postgres), loadgen: usage(&samples, |s| s.loadgen) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_line_with_spaces_in_the_command_name_parses() {
        let line = "1234 (my (odd) cmd) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0 1000 1000 100 18446744073709551615";
        assert_eq!(parse_stat_ticks(line), Some(300));
        assert_eq!(parse_stat_ticks("garbage"), None);
    }

    #[test]
    fn own_process_can_be_read() {
        let reading = read_process(std::process::id());
        if cfg!(target_os = "linux") {
            assert!(reading.is_some_and(|reading| reading.rss_kb > 0));
        }
    }
}
