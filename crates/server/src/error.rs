//! Error model: HTTP status + `ApiError` body with Discord-like numeric codes.
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use vokko_protocol::api::ApiError;

#[derive(Debug)]
pub struct ApiErr {
    pub status: StatusCode,
    pub body: ApiError,
}

pub type ApiResult<T> = Result<T, ApiErr>;

impl ApiErr {
    fn new(status: StatusCode, code: u32, message: &str) -> Self {
        Self { status, body: ApiError { code, message: message.to_owned(), errors: None } }
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, 0, "401: Unauthorized")
    }

    pub fn missing_access() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50001, "Missing Access")
    }

    pub fn missing_permissions() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50013, "You lack permissions to perform that action")
    }

    pub fn not_author() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50005, "Cannot edit a message authored by another user")
    }

    pub fn unknown_channel() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10003, "Unknown Channel")
    }

    pub fn unknown_message() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10008, "Unknown Message")
    }

    pub fn unknown_guild() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10004, "Unknown Guild")
    }

    pub fn unknown_user() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10013, "Unknown User")
    }

    pub fn unknown_invite() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10006, "Unknown Invite")
    }

    pub fn unknown_attachment() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10015, "Unknown Attachment")
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, 0, "404: Not Found")
    }

    pub fn conflict(code: u32, message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn payload_too_large() -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, 40005, "Request entity too large")
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, 0, "Internal Server Error")
    }

    /// 400 / 50035 with `errors.<field>._errors[0]` like Discord.
    pub fn invalid(field: &str, message: &str) -> Self {
        let mut error = Self::new(StatusCode::BAD_REQUEST, 50035, "Invalid Form Body");
        error.body.errors = Some(json!({ field: { "_errors": [{ "code": "INVALID", "message": message }] } }));
        error
    }

    pub fn with_errors(mut self, errors: Value) -> Self {
        self.body.errors = Some(errors);
        self
    }
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

impl From<sqlx::Error> for ApiErr {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!("database error: {error}");
        Self::internal()
    }
}

impl From<std::io::Error> for ApiErr {
    fn from(error: std::io::Error) -> Self {
        tracing::error!("io error: {error}");
        Self::internal()
    }
}
