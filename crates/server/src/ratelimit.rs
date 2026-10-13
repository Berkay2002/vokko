//! In-memory token-bucket rate limiting for the REST API (`429` + `RateLimitError` + `Retry-After`).
//!
//! Callers are keyed on what the server knows, never on what the client sends: `/auth/*` and requests without a valid
//! token on the client address, everything else on the resolved user id. A bucket that has refilled completely is
//! indistinguishable from a new one, so a periodic sweep drops those without changing any outcome.
//! IPv6 clients are keyed on their /64 (one subscriber's allocation), and the map is capped (`MAX_BUCKETS`).
use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{MatchedPath, Request, State};
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, Method, StatusCode};
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
/// Importing a picked GIF as an avatar or banner shares one bucket per user.
const GIF_IMPORT_ROUTE: &str = "POST /users/@me/gif-import";
const GIF_BURST: f64 = 10.0;
const GIF_PER_SECOND: f64 = 2.0;
/// At most this many buckets are kept (about 100 bytes each: route keys are bounded, see `method_key`). A new bucket past
/// the cap first drops the refilled ones, then the fullest (the oldest among equals) until half the cap is free, so a flood
/// of fresh callers costs bounded memory and amortised O(1), and a drained bucket is the last to go.
const MAX_BUCKETS: usize = 100_000;
/// Signed-out `/auth/*` calls and invite previews from IPv6 also share one bucket per /48 (a typical site allocation of
/// 65,536 /64s), this many times the per-/64 budget.
const WIDE_FACTOR: f64 = 16.0;
const PREFIX_64: u128 = !((1 << 64) - 1);
const PREFIX_48: u128 = !((1 << 80) - 1);
/// Route keys use the method only when it is a standard one: hyper accepts extension methods of any length.
const STANDARD_METHODS: [Method; 7] = [Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::HEAD, Method::OPTIONS];

/// The address a client is limited on: IPv4 as is, IPv6 by its /64 (an IPv4-mapped IPv6 address counts as the IPv4
/// address). A single host usually controls a whole /64, so keying on the full address would hand it 2^64 fresh buckets.
pub fn address_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(Ipv6Addr::from(v6.to_bits() & PREFIX_64)),
        },
    }
}

/// The IPv6 /48 an address belongs to (`None` for IPv4 and IPv4-mapped addresses).
fn wide_key(ip: IpAddr) -> Option<IpAddr> {
    match address_key(ip) {
        IpAddr::V6(v6) => Some(IpAddr::V6(Ipv6Addr::from(v6.to_bits() & PREFIX_48))),
        IpAddr::V4(_) => None,
    }
}

fn method_key(method: &Method) -> &str {
    if STANDARD_METHODS.contains(method) { method.as_str() } else { "OTHER" }
}
/// Anonymous invite previews (`GET /invites/{code}` without a token) are keyed on the client address and kept slow, so the
/// open route cannot be used to enumerate invite codes: 10 at once, then one every 5 seconds.
const ANON_INVITE_ROUTE: &str = "/invites/{code}";
const ANON_INVITE_BURST: f64 = 10.0;
const ANON_INVITE_PER_SECOND: f64 = 0.2;
/// Importing a GIF as an avatar or banner: 3 at once, then one every 5 s.
const GIF_IMPORT_BURST: f64 = 3.0;
const GIF_IMPORT_PER_SECOND: f64 = 0.2;
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

    fn fill_at(&self, now: Instant) -> f64 {
        ((self.tokens + now.saturating_duration_since(self.updated).as_secs_f64() * self.per_second) / self.burst).min(1.0)
    }
}

struct Buckets {
    map: HashMap<(Caller, String), Bucket>,
    swept: Instant,
    cap: usize,
}

impl Buckets {
    /// Drops the refilled buckets, then (if that was not enough) the fullest down to half the cap, the oldest among equals.
    /// Evicting a nearly full bucket barely changes an outcome; a drained one (an attacker's, or anyone's) is the last to go.
    fn make_room(&mut self, now: Instant) {
        self.map.retain(|_, bucket| !bucket.is_full_at(now));
        self.swept = now;
        let keep = self.cap / 2;
        if self.map.len() <= keep {
            return;
        }
        let mut ranked: Vec<(f64, Instant, (Caller, String))> =
            self.map.iter().map(|(key, bucket)| (bucket.fill_at(now), bucket.updated, key.clone())).collect();
        let evict = ranked.len() - keep;
        ranked.select_nth_unstable_by(evict - 1, |a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for (_, _, key) in ranked.into_iter().take(evict) {
            self.map.remove(&key);
        }
    }
}

pub struct RateLimiter {
    buckets: Mutex<Buckets>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_cap(MAX_BUCKETS)
    }
}

/// How long the caller must wait, and whether the global bucket is the one that ran dry.
#[derive(Debug)]
pub struct Limited {
    pub retry_after: f64,
    pub global: bool,
}

fn take(buckets: &mut Buckets, key: (Caller, String), burst: f64, per_second: f64, now: Instant) -> Result<(), f64> {
    if buckets.map.len() >= buckets.cap && !buckets.map.contains_key(&key) {
        buckets.make_room(now);
    }
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
    fn with_cap(cap: usize) -> Self {
        Self { buckets: Mutex::new(Buckets { map: HashMap::new(), swept: Instant::now(), cap }) }
    }

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
            (Caller::Ip(address_key(ip)), "address".to_owned()),
            limit.global_burst * ADDRESS_FLOOR_FACTOR,
            limit.global_per_second * ADDRESS_FLOOR_FACTOR,
            now,
        )
        .map_err(|retry_after| Limited { retry_after, global: true })
    }

    /// The shared /48 bucket of signed-out IPv6 callers on the strict routes (`WIDE_FACTOR` times the per-/64 bucket).
    fn check_wide(&self, wide: IpAddr, route: &str, burst: f64, per_second: f64, now: Instant) -> Result<(), Limited> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take(&mut buckets, (Caller::Ip(wide), format!("/48 {route}")), burst * WIDE_FACTOR, per_second * WIDE_FACTOR, now)
            .map_err(|retry_after| Limited { retry_after, global: false })
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
    let mut caller = Caller::Ip(address_key(ip));
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
    // Each call makes the server download up to an avatar's or banner's size from the GIF provider; both routes draw on one bucket.
    let is_gif_import = request.method() == axum::http::Method::POST && (route.ends_with("/avatars/gif") || route.ends_with("/banners/gif"));
    let route = if is_gif {
        GIF_ROUTE.to_owned()
    } else if is_gif_import {
        GIF_IMPORT_ROUTE.to_owned()
    } else {
        format!("{} {route}", method_key(request.method()))
    };
    // The limits are never raised above the configured route bucket (tests and operators may set it lower).
    let is_ring = request.method() == axum::http::Method::POST && route.ends_with("/call/ring");
    let bucket = if is_gif {
        Some((GIF_BURST.min(limit.route_burst), GIF_PER_SECOND.min(limit.route_per_second)))
    } else if anon_invite {
        Some((ANON_INVITE_BURST.min(limit.route_burst), ANON_INVITE_PER_SECOND.min(limit.route_per_second)))
    } else if is_gif_import {
        Some((GIF_IMPORT_BURST.min(limit.route_burst), GIF_IMPORT_PER_SECOND.min(limit.route_per_second)))
    } else if is_ring {
        Some((CALL_RING_BURST.min(limit.route_burst), CALL_RING_PER_SECOND.min(limit.route_per_second)))
    } else {
        None
    };
    if let Err(limited) = state.limiter.check_with(caller, &route, &limit, auth, bucket) {
        return limited_response(limited);
    }
    if matches!(caller, Caller::Ip(_))
        && (auth || anon_invite)
        && let Some(wide) = wide_key(ip)
    {
        let (burst, per_second) = bucket.unwrap_or((limit.auth_burst, limit.auth_per_second));
        if let Err(limited) = state.limiter.check_wide(wide, &route, burst, per_second, Instant::now()) {
            return limited_response(limited);
        }
    }
    next.run(request).await
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

    #[test]
    fn ipv6_clients_share_a_bucket_per_64() {
        let key = |text: &str| address_key(text.parse().expect("ip"));
        assert_eq!(key("2001:db8:1:2:aaaa::1"), key("2001:db8:1:2:ffff:ffff:ffff:ffff"));
        assert_eq!(key("2001:db8:1:2:aaaa::1"), key("2001:db8:1:2::"));
        assert_ne!(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"));
        assert_eq!(key("203.0.113.9"), key("::ffff:203.0.113.9"));
        assert_ne!(key("203.0.113.9"), key("203.0.113.10"));
    }

    #[test]
    fn standard_methods_key_routes_and_the_rest_share_one() {
        assert_eq!(method_key(&Method::PATCH), "PATCH");
        assert_eq!(method_key(&Method::from_bytes(b"XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX").expect("method")), "OTHER");
        assert_eq!(method_key(&Method::CONNECT), "OTHER");
    }

    #[test]
    fn a_flood_of_fresh_addresses_evicts_its_own_buckets_before_a_drained_one() {
        let limiter = RateLimiter::with_cap(8);
        let limit = limit(3.0);
        let start = Instant::now();
        let user = Caller::User(1);
        for _ in 0..3 {
            limiter.check_at(user, "GET /x", &limit, false, start).expect("allowed");
        }
        // each address leaves a half-full auth bucket that does not refill during the test
        for index in 0..20u8 {
            let at = start + Duration::from_millis(u64::from(index) * 10);
            limiter.check_at(Caller::Ip(IpAddr::from([10, 0, 0, index])), "POST /auth/login", &limit, true, at).expect("allowed");
            assert!(limiter.len() <= 8, "{} buckets after {index}", limiter.len());
        }
        let now = start + Duration::from_millis(200);
        assert!(limiter.check_at(user, "GET /x", &limit, false, now).is_err(), "the drained bucket was not evicted");
    }

    #[test]
    fn the_map_is_capped_and_evicts_the_oldest_among_equally_full() {
        let limiter = RateLimiter::with_cap(8);
        let limit = limit(3.0);
        let start = Instant::now();
        let drain = |caller: Caller, at: Instant| {
            for _ in 0..2 {
                limiter.check_at(caller, "POST /auth/login", &limit, true, at).expect("allowed");
            }
        };
        let address = |index: u8| Caller::Ip(IpAddr::from([10, 0, 0, index]));
        // Drained auth buckets (0.01/s) never refill in this test, so only the cap can drop them.
        for index in 0..20u8 {
            drain(address(index), start + Duration::from_millis(u64::from(index) * 50));
            assert!(limiter.len() <= 8, "{} buckets after {index}", limiter.len());
        }
        let now = start + Duration::from_secs(1);
        assert!(limiter.check_at(address(19), "POST /auth/login", &limit, true, now).is_err(), "the newest drained bucket is kept");
        assert!(limiter.check_at(address(0), "POST /auth/login", &limit, true, now).is_ok(), "the oldest was evicted");
    }
}
