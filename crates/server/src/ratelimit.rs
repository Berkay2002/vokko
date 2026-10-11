//! In-memory token-bucket rate limiting for the REST API (`429` + `RateLimitError` + `Retry-After`).
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{MatchedPath, Request, State};
use axum::http::header::{AUTHORIZATION, RETRY_AFTER};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use vokko_protocol::api::RateLimitError;

use crate::config::RateLimit;
use crate::state::AppState;

struct Bucket {
    tokens: f64,
    updated: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(u64, String), Bucket>>,
}

/// How long the caller must wait, and whether the global bucket is the one that ran dry.
pub struct Limited {
    pub retry_after: f64,
    pub global: bool,
}

impl RateLimiter {
    fn take(buckets: &mut HashMap<(u64, String), Bucket>, key: (u64, String), burst: f64, per_second: f64, now: Instant) -> Result<(), f64> {
        let bucket = buckets.entry(key).or_insert(Bucket { tokens: burst, updated: now });
        let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * per_second).min(burst);
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err((1.0 - bucket.tokens) / per_second)
        }
    }

    pub fn check(&self, caller: u64, route: &str, limit: &RateLimit) -> Result<(), Limited> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if buckets.len() > 10_000 {
            buckets.retain(|_, bucket| now.saturating_duration_since(bucket.updated) < Duration::from_secs(60));
        }
        Self::take(&mut buckets, (caller, String::new()), limit.global_burst, limit.global_per_second, now)
            .map_err(|retry_after| Limited { retry_after, global: true })?;
        Self::take(&mut buckets, (caller, route.to_owned()), limit.route_burst, limit.route_per_second, now)
            .map_err(|retry_after| Limited { retry_after, global: false })
    }
}

fn caller_key(request: &Request) -> u64 {
    let mut hasher = DefaultHasher::new();
    request.headers().get(AUTHORIZATION).map(HeaderValue::as_bytes).unwrap_or_default().hash(&mut hasher);
    hasher.finish()
}

pub async fn middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Some(limit) = state.config.rate_limit else { return next.run(request).await };
    let route = request.extensions().get::<MatchedPath>().map(|path| path.as_str().to_owned()).unwrap_or_else(|| request.uri().path().to_owned());
    // Downloads are unauthenticated <img> loads: every anonymous client would share one bucket, so they are not limited.
    if request.method() == axum::http::Method::GET && route.ends_with("/attachments/{id}/{filename}") {
        return next.run(request).await;
    }
    let route = format!("{} {route}", request.method());
    match state.limiter.check(caller_key(&request), &route, &limit) {
        Ok(()) => next.run(request).await,
        Err(limited) => {
            let body = RateLimitError { message: "You are being rate limited.".to_owned(), retry_after: limited.retry_after, global: limited.global };
            let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response();
            let seconds = limited.retry_after.ceil().max(1.0) as u64;
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_empties_then_reports_wait() {
        let limiter = RateLimiter::default();
        let limit = RateLimit { route_burst: 2.0, route_per_second: 1.0, global_burst: 100.0, global_per_second: 100.0 };
        assert!(limiter.check(1, "GET /x", &limit).is_ok());
        assert!(limiter.check(1, "GET /x", &limit).is_ok());
        let limited = limiter.check(1, "GET /x", &limit).err().expect("limited");
        assert!(!limited.global && limited.retry_after > 0.0 && limited.retry_after <= 1.0);
        // other callers and other routes are independent
        assert!(limiter.check(2, "GET /x", &limit).is_ok());
        assert!(limiter.check(1, "GET /y", &limit).is_ok());
    }
}
