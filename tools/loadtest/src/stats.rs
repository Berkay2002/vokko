//! Latency histograms (log buckets, ~3% resolution), counters and error tallies.
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const GROWTH: f64 = 1.03;
const BUCKETS: usize = 700;

/// Records `u64` values (microseconds for latencies, bytes for sizes). Percentiles are bucket upper bounds, so they
/// overstate by at most ~3%; the maximum is exact.
pub struct Histogram {
    buckets: Vec<AtomicU64>,
    step: f64,
    count: AtomicU64,
    sum: AtomicU64,
    max: AtomicU64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Summary {
    pub count: u64,
    pub mean: u64,
    pub p50: u64,
    pub p95: u64,
    pub p99: u64,
    pub max: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: (0..BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            step: GROWTH.ln(),
            count: AtomicU64::new(0),
            sum: AtomicU64::new(0),
            max: AtomicU64::new(0),
        }
    }
}

impl Histogram {
    pub fn record(&self, value: u64) {
        let bucket = if value <= 1 { 0 } else { ((value as f64).ln() / self.step) as usize }.min(BUCKETS - 1);
        self.buckets[bucket].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(value, Ordering::Relaxed);
        self.max.fetch_max(value, Ordering::Relaxed);
    }

    fn quantile(&self, q: f64) -> u64 {
        let count = self.count.load(Ordering::Relaxed);
        if count == 0 {
            return 0;
        }
        let target = ((q * count as f64).ceil() as u64).clamp(1, count);
        let mut seen = 0;
        for (index, bucket) in self.buckets.iter().enumerate() {
            seen += bucket.load(Ordering::Relaxed);
            if seen >= target {
                return (((index + 1) as f64 * self.step).exp() as u64).min(self.max.load(Ordering::Relaxed));
            }
        }
        self.max.load(Ordering::Relaxed)
    }

    pub fn summary(&self) -> Summary {
        let count = self.count.load(Ordering::Relaxed);
        Summary {
            count,
            mean: self.sum.load(Ordering::Relaxed).checked_div(count).unwrap_or(0),
            p50: self.quantile(0.50),
            p95: self.quantile(0.95),
            p99: self.quantile(0.99),
            max: self.max.load(Ordering::Relaxed),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Everything one scenario measures.
#[derive(Default)]
pub struct Metrics {
    hists: Mutex<HashMap<String, Arc<Histogram>>>,
    counters: Mutex<HashMap<String, Arc<AtomicU64>>>,
    errors: Mutex<BTreeMap<String, u64>>,
}

impl Metrics {
    pub fn hist(&self, name: &str) -> Arc<Histogram> {
        let mut map = lock(&self.hists);
        match map.get(name) {
            Some(hist) => hist.clone(),
            None => map.entry(name.to_owned()).or_default().clone(),
        }
    }

    /// Latency in microseconds.
    pub fn time(&self, name: &str, elapsed: Duration) {
        self.hist(name).record(elapsed.as_micros().min(u128::from(u64::MAX)) as u64);
    }

    pub fn add(&self, name: &str, n: u64) {
        let mut map = lock(&self.counters);
        match map.get(name) {
            Some(counter) => counter.fetch_add(n, Ordering::Relaxed),
            None => map.entry(name.to_owned()).or_default().fetch_add(n, Ordering::Relaxed),
        };
    }

    pub fn error(&self, key: &str) {
        *lock(&self.errors).entry(key.to_owned()).or_default() += 1;
    }

    pub fn counter(&self, name: &str) -> u64 {
        lock(&self.counters).get(name).map(|counter| counter.load(Ordering::Relaxed)).unwrap_or(0)
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            histograms: lock(&self.hists).iter().map(|(name, hist)| (name.clone(), hist.summary())).collect(),
            counters: lock(&self.counters).iter().map(|(name, counter)| (name.clone(), counter.load(Ordering::Relaxed))).collect(),
            errors: lock(&self.errors).clone(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Snapshot {
    pub histograms: BTreeMap<String, Summary>,
    pub counters: BTreeMap<String, u64>,
    pub errors: BTreeMap<String, u64>,
}

/// The metrics sink every task writes to; the runner swaps in a fresh one per scenario.
pub struct Shared {
    pub epoch: Instant,
    current: RwLock<Arc<Metrics>>,
    /// Send times of events whose payload cannot carry a stamp (reactions, voice states), keyed by what the receiver sees.
    stamps: Mutex<HashMap<String, u64>>,
}

impl Shared {
    pub fn new() -> Self {
        Self { epoch: Instant::now(), current: RwLock::new(Arc::new(Metrics::default())), stamps: Mutex::new(HashMap::new()) }
    }

    pub fn m(&self) -> Arc<Metrics> {
        self.current.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Starts a new measurement window and returns the one that just ended.
    pub fn swap(&self) -> Arc<Metrics> {
        let mut current = self.current.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::replace(&mut *current, Arc::new(Metrics::default()))
    }

    pub fn now_us(&self) -> u64 {
        self.epoch.elapsed().as_micros() as u64
    }

    /// Remembers that the event identified by `key` was sent now (a later stamp of the same key replaces it).
    pub fn stamp(&self, key: String) {
        let now = self.now_us();
        lock(&self.stamps).insert(key, now);
    }

    /// Time since `key` was stamped.
    pub fn since(&self, key: &str) -> Option<Duration> {
        let sent = *lock(&self.stamps).get(key)?;
        Some(Duration::from_micros(self.now_us().saturating_sub(sent)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_land_within_bucket_resolution() {
        let hist = Histogram::default();
        for value in 1..=1000_u64 {
            hist.record(value * 100);
        }
        let summary = hist.summary();
        assert_eq!(summary.count, 1000);
        assert_eq!(summary.max, 100_000);
        for (got, want) in [(summary.p50, 50_000_f64), (summary.p95, 95_000.0), (summary.p99, 99_000.0)] {
            let ratio = got as f64 / want;
            assert!((0.97..=1.07).contains(&ratio), "{got} vs {want}");
        }
        assert_eq!(Histogram::default().summary().p99, 0);
    }

    #[test]
    fn metrics_swap_starts_a_clean_window() {
        let shared = Shared::new();
        shared.m().add("x", 2);
        shared.m().error("429");
        let old = shared.swap();
        assert_eq!(old.counter("x"), 2);
        assert_eq!(shared.m().counter("x"), 0);
        assert_eq!(old.snapshot().errors.get("429"), Some(&1));
    }

    #[test]
    fn stamps_measure_time_since_the_send() {
        let shared = Shared::new();
        assert!(shared.since("r:1").is_none());
        shared.stamp("r:1".to_owned());
        assert!(shared.since("r:1").is_some_and(|elapsed| elapsed < Duration::from_secs(5)));
    }
}
