//! In-memory token-bucket rate limiting for the REST API (`429` + `RateLimitError` + `Retry-After`).
//!
//! Callers are keyed on what the server knows, never on what the client sends: `/auth/*` and requests without a valid
//! token on the client address, everything else on the resolved user id. A bucket that has refilled completely is
//! indistinguishable from a new one, so a periodic sweep drops those without changing any outcome.
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{MatchedPath, Request, State};
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use vokko_protocol::api::RateLimitError;

use crate::auth::{ResolvedUser, bearer_header, user_for_token};
use crate::config::RateLimit;
use crate::net::client_ip;
use crate::state::AppState;

const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// Requests that carry a token are first counted against the client address with this multiple of the global bucket,
/// so token lookups cannot be used as a free oracle.
const ADDRESS_FLOOR_FACTOR: f64 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Caller {
    User(i64),
    Ip(IpAddr),
}

struct Bucket {
    tokens: f64,
    updated: Instant,
    burst: f64,
    per_second: f64,
}

impl Bucket {
    fn is_full_at(&self, now: Instant) -> bool {
        self.tokens + now.saturating_duration_since(self.updated).as_secs_f64() * self.per_second >= self.burst
    }
}

struct Buckets {
    map: HashMap<(Caller, String), Bucket>,
    swept: Instant,
}

pub struct RateLimiter {
    buckets: Mutex<Buckets>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self { buckets: Mutex::new(Buckets { map: HashMap::new(), swept: Instant::now() }) }
    }
}

/// How long the caller must wait, and whether the global bucket is the one that ran dry.
#[derive(Debug)]
pub struct Limited {
    pub retry_after: f64,
    pub global: bool,
}

fn take(buckets: &mut Buckets, key: (Caller, String), burst: f64, per_second: f64, now: Instant) -> Result<(), f64> {
    let bucket = buckets.map.entry(key).or_insert(Bucket { tokens: burst, updated: now, burst, per_second });
    let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
    bucket.tokens = (bucket.tokens + elapsed * per_second).min(burst);
    bucket.updated = now;
    bucket.burst = burst;
    bucket.per_second = per_second;
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        Ok(())
    } else {
        Err((1.0 - bucket.tokens) / per_second)
    }
}

impl RateLimiter {
    /// Counts one request of `caller` against the caller-wide bucket and the bucket of `route`.
    /// `auth` routes use the stricter `auth_*` route bucket.
    pub fn check(&self, caller: Caller, route: &str, limit: &RateLimit, auth: bool) -> Result<(), Limited> {
        self.check_at(caller, route, limit, auth, Instant::now())
    }

    fn check_at(&self, caller: Caller, route: &str, limit: &RateLimit, auth: bool, now: Instant) -> Result<(), Limited> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if now.saturating_duration_since(buckets.swept) >= SWEEP_EVERY {
            buckets.map.retain(|_, bucket| !bucket.is_full_at(now));
            buckets.swept = now;
        }
        take(&mut buckets, (caller, String::new()), limit.global_burst, limit.global_per_second, now)
            .map_err(|retry_after| Limited { retry_after, global: true })?;
        let (burst, per_second) = if auth { (limit.auth_burst, limit.auth_per_second) } else { (limit.route_burst, limit.route_per_second) };
        take(&mut buckets, (caller, route.to_owned()), burst, per_second, now).map_err(|retry_after| Limited { retry_after, global: false })
    }

    /// The coarse per-address bucket that precedes a token lookup.
    fn check_address(&self, ip: IpAddr, limit: &RateLimit, now: Instant) -> Result<(), Limited> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take(
            &mut buckets,
            (Caller::Ip(ip), "address".to_owned()),
            limit.global_burst * ADDRESS_FLOOR_FACTOR,
            limit.global_per_second * ADDRESS_FLOOR_FACTOR,
            now,
        )
        .map_err(|retry_after| Limited { retry_after, global: true })
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).map.len()
    }
}

fn limited_response(limited: Limited) -> Response {
    let body = RateLimitError { message: "You are being rate limited.".to_owned(), retry_after: limited.retry_after, global: limited.global };
    let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response();
    let seconds = limited.retry_after.ceil().max(1.0) as u64;
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(RETRY_AFTER, value);
    }
    response
}

pub async fn middleware(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let Some(limit) = state.config.rate_limit else { return next.run(request).await };
    let route = request.extensions().get::<MatchedPath>().map(|path| path.as_str().to_owned()).unwrap_or_else(|| request.uri().path().to_owned());
    // Attachment downloads are <img> loads addressed by an unguessable key: every client would share one bucket.
    if request.method() == axum::http::Method::GET && route.contains("/attachments/") && route.ends_with("/{filename}") {
        return next.run(request).await;
    }
    let ip = client_ip(request.extensions(), request.headers(), state.config.trust_proxy);
    let auth = route.contains("/auth/");
    let mut caller = Caller::Ip(ip);
    if !auth && let Some(token) = bearer_header(request.headers()).map(str::to_owned) {
        if let Err(limited) = state.limiter.check_address(ip, &limit, Instant::now()) {
            return limited_response(limited);
        }
        if let Ok(Some(user_id)) = user_for_token(&state, &token).await {
            caller = Caller::User(user_id);
            request.extensions_mut().insert(ResolvedUser(user_id));
        }
    }
    let route = format!("{} {route}", request.method());
    match state.limiter.check(caller, &route, &limit, auth) {
        Ok(()) => next.run(request).await,
        Err(limited) => limited_response(limited),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(route_burst: f64) -> RateLimit {
        RateLimit { route_burst, route_per_second: 1.0, global_burst: 100.0, global_per_second: 100.0, auth_burst: 2.0, auth_per_second: 0.01 }
    }

    #[test]
    fn bucket_empties_then_reports_wait() {
        let limiter = RateLimiter::default();
        let limit = limit(2.0);
        let (one, two) = (Caller::User(1), Caller::User(2));
        assert!(limiter.check(one, "GET /x", &limit, false).is_ok());
        assert!(limiter.check(one, "GET /x", &limit, false).is_ok());
        let limited = limiter.check(one, "GET /x", &limit, false).err().expect("limited");
        assert!(!limited.global && limited.retry_after > 0.0 && limited.retry_after <= 1.0);
        // other callers and other routes are independent
        assert!(limiter.check(two, "GET /x", &limit, false).is_ok());
        assert!(limiter.check(one, "GET /y", &limit, false).is_ok());
    }

    #[test]
    fn auth_routes_use_their_own_stricter_bucket() {
        let limiter = RateLimiter::default();
        let limit = limit(30.0);
        let caller = Caller::Ip("10.0.0.7".parse().expect("ip"));
        assert!(limiter.check(caller, "POST /auth/login", &limit, true).is_ok());
        assert!(limiter.check(caller, "POST /auth/login", &limit, true).is_ok());
        assert!(limiter.check(caller, "POST /auth/login", &limit, true).is_err());
    }

    #[test]
    fn refilled_buckets_are_swept_by_time_and_the_rest_are_kept() {
        let limiter = RateLimiter::default();
        let limit = limit(3.0);
        let start = Instant::now();
        for user in 0..500 {
            limiter.check_at(Caller::User(user), "GET /x", &limit, false, start).expect("allowed");
        }
        // one address drains its auth bucket (burst 2, refills at 0.01/s: not full after the sweep interval)
        let address = Caller::Ip("10.0.0.7".parse().expect("ip"));
        for _ in 0..2 {
            limiter.check_at(address, "POST /auth/login", &limit, true, start).expect("allowed");
        }
        assert_eq!(limiter.len(), 1002);
        // everything else has refilled by then and is dropped, only the drained bucket (and the new caller's two) remain
        let later = start + SWEEP_EVERY + Duration::from_secs(1);
        limiter.check_at(Caller::User(1), "GET /y", &limit, false, later).expect("allowed");
        assert_eq!(limiter.len(), 3);
        assert!(limiter.check_at(address, "POST /auth/login", &limit, true, later).is_err(), "the drained bucket survived the sweep");
        // and a swept caller starts from a full bucket again
        for _ in 0..3 {
            assert!(limiter.check_at(Caller::User(2), "GET /x", &limit, false, later).is_ok());
        }
        assert!(limiter.check_at(Caller::User(2), "GET /x", &limit, false, later).is_err());
    }
}
