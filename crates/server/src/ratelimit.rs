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
/// `/gifs/*` is proxied to a provider with a quota: search, trending and categories share one bucket per user.
const GIF_ROUTE: &str = "GET /gifs";
const GIF_BURST: f64 = 10.0;
const GIF_PER_SECOND: f64 = 2.0;
/// Anonymous invite previews (`GET /invites/{code}` without a token) are keyed on the client address and kept slow, so the
/// open route cannot be used to enumerate invite codes: 10 at once, then one every 5 seconds.
const ANON_INVITE_ROUTE: &str = "/invites/{code}";
const ANON_INVITE_BURST: f64 = 10.0;
const ANON_INVITE_PER_SECOND: f64 = 0.2;
/// `POST /channels/{id}/call/ring` re-rings the other people of a DM: a few rings, then one every 5 s.
const CALL_RING_BURST: f64 = 5.0;
const CALL_RING_PER_SECOND: f64 = 0.2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Caller {
    User(i64),
    Ip(IpAddr),
    /// A shared resource (e.g. a channel) limited across all callers.
    Resource(i64),
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
        self.check_with(caller, route, limit, auth, None)
    }

    /// Like `check`, with the route bucket's `(burst, per_second)` replaced (routes that cost the server more than they look).
    pub fn check_with(&self, caller: Caller, route: &str, limit: &RateLimit, auth: bool, route_bucket: Option<(f64, f64)>) -> Result<(), Limited> {
        self.check_bucket_at(caller, route, limit, auth, route_bucket, Instant::now())
    }

    #[cfg(test)]
    fn check_at(&self, caller: Caller, route: &str, limit: &RateLimit, auth: bool, now: Instant) -> Result<(), Limited> {
        self.check_bucket_at(caller, route, limit, auth, None, now)
    }

    fn check_bucket_at(
        &self,
        caller: Caller,
        route: &str,
        limit: &RateLimit,
        auth: bool,
        route_bucket: Option<(f64, f64)>,
        now: Instant,
    ) -> Result<(), Limited> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if now.saturating_duration_since(buckets.swept) >= SWEEP_EVERY {
            buckets.map.retain(|_, bucket| !bucket.is_full_at(now));
            buckets.swept = now;
        }
        take(&mut buckets, (caller, String::new()), limit.global_burst, limit.global_per_second, now)
            .map_err(|retry_after| Limited { retry_after, global: true })?;
        let (burst, per_second) =
            route_bucket.unwrap_or(if auth { (limit.auth_burst, limit.auth_per_second) } else { (limit.route_burst, limit.route_per_second) });
        take(&mut buckets, (caller, route.to_owned()), burst, per_second, now).map_err(|retry_after| Limited { retry_after, global: false })
    }

    /// A limit enforced by a handler on a key of its own (a webhook, a channel, a user running commands), independent of the
    /// configurable REST limits: `burst` requests, refilled at `per_second`. Returns the wait in seconds when it is used up.
    pub fn check_key(&self, key: &str, id: i64, burst: f64, per_second: f64) -> Result<(), f64> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take(&mut buckets, (Caller::User(id), format!("key:{key}")), burst, per_second, Instant::now())
    }

    /// One bucket per `(resource, kind)` shared by every caller (on top of the per-user route buckets).
    pub fn check_resource(&self, resource: i64, kind: &str, burst: f64, per_second: f64) -> Result<(), Limited> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take(&mut buckets, (Caller::Resource(resource), kind.to_owned()), burst, per_second, Instant::now())
            .map_err(|retry_after| Limited { retry_after, global: false })
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

pub fn limited_response(limited: Limited) -> Response {
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
    let is_gif = request.method() == axum::http::Method::GET && route.contains("/gifs/");
    let anon_invite = request.method() == axum::http::Method::GET && matches!(caller, Caller::Ip(_)) && route.ends_with(ANON_INVITE_ROUTE);
    let route = if is_gif { GIF_ROUTE.to_owned() } else { format!("{} {route}", request.method()) };
    // The limits are never raised above the configured route bucket (tests and operators may set it lower).
    let is_ring = request.method() == axum::http::Method::POST && route.ends_with("/call/ring");
    let bucket = if is_gif {
        Some((GIF_BURST.min(limit.route_burst), GIF_PER_SECOND.min(limit.route_per_second)))
    } else if anon_invite {
        Some((ANON_INVITE_BURST.min(limit.route_burst), ANON_INVITE_PER_SECOND.min(limit.route_per_second)))
    } else if is_ring {
        Some((CALL_RING_BURST.min(limit.route_burst), CALL_RING_PER_SECOND.min(limit.route_per_second)))
    } else {
        None
    };
    match state.limiter.check_with(caller, &route, &limit, auth, bucket) {
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
        let limited = limiter.check(one, "GET /x", &limit, false).expect_err("limited");
        assert!(!limited.global && limited.retry_after > 0.0 && limited.retry_after <= 1.0);
        // other callers and other routes are independent
        assert!(limiter.check(two, "GET /x", &limit, false).is_ok());
        assert!(limiter.check(one, "GET /y", &limit, false).is_ok());
    }

    #[test]
    fn a_replaced_route_bucket_is_shared_by_the_routes_that_use_it() {
        let limiter = RateLimiter::default();
        let limit = limit(30.0);
        let caller = Caller::User(1);
        for _ in 0..3 {
            assert!(limiter.check_with(caller, "GET /gifs", &limit, false, Some((3.0, 0.01))).is_ok());
        }
        assert!(limiter.check_with(caller, "GET /gifs", &limit, false, Some((3.0, 0.01))).is_err());
        assert!(limiter.check_with(Caller::User(2), "GET /gifs", &limit, false, Some((3.0, 0.01))).is_ok(), "per user");
        assert!(limiter.check(caller, "GET /other", &limit, false).is_ok(), "other routes are untouched");
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
