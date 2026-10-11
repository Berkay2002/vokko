//! JSON/query extractors whose rejections use the `ApiError` body (50035) instead of axum's plain text.
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::error::ApiErr;

pub struct ApiJson<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiErr;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(request, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(match rejection {
                JsonRejection::BytesRejection(_) => ApiErr::payload_too_large(),
                other => ApiErr::invalid("body", &other.body_text()),
            }),
        }
    }
}

pub struct ApiQuery<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match axum::extract::Query::<T>::from_request_parts(parts, state).await {
            Ok(axum::extract::Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiErr::invalid("query", &rejection.body_text())),
        }
    }
}

/// Parses a snowflake path segment; malformed ids are reported as the resource-specific "unknown" error by the caller.
pub fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<u64>().ok().filter(|value| *value > 0 && *value <= i64::MAX as u64).map(|value| value as i64)
}
