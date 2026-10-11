//! Error model: HTTP status + `ApiError` body with Discord-like numeric codes.
use axum::Json;
use axum::http::HeaderValue;
use axum::http::StatusCode;
use axum::http::header::RETRY_AFTER;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use vokko_protocol::api::{ApiError, RateLimitError};

#[derive(Debug)]
pub struct ApiErr {
    pub status: StatusCode,
    pub body: ApiError,
    /// Set by [`ApiErr::rate_limited`]: the response is a `RateLimitError` with a `Retry-After` header instead.
    pub retry_after: Option<f64>,
}

pub type ApiResult<T> = Result<T, ApiErr>;

impl ApiErr {
    pub(crate) fn new(status: StatusCode, code: u32, message: &str) -> Self {
        Self { status, body: ApiError { code, message: message.to_owned(), errors: None }, retry_after: None }
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

    /// 400 / 50006: a message edit that would leave neither content nor attachments.
    pub fn empty_message() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 50006, "Cannot send an empty message")
    }

    /// 403 / 40002: `VOKKO_REGISTRATION=closed`; the message tells the client why it cannot sign up.
    pub fn registration_closed() -> Self {
        Self::new(StatusCode::FORBIDDEN, 40002, "Registration is closed on this server")
    }

    pub fn cannot_message_user() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50007, "Cannot send messages to this user")
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

    pub fn unknown_member() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10007, "Unknown Member")
    }

    pub fn unknown_role() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10011, "Unknown Role")
    }

    /// 400 / 50028: the operation does not apply to this role (deleting @everyone).
    pub fn invalid_role() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 50028, "Invalid role")
    }

    pub fn unknown_ban() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10026, "Unknown Ban")
    }

    /// 40007: the user is banned from the guild an invite leads to.
    pub fn banned() -> Self {
        Self::new(StatusCode::FORBIDDEN, 40007, "The user is banned from this guild")
    }

    /// 404 with a specific Discord code (e.g. 10060 unknown sticker).
    pub fn new_unknown(message: &str, code: u32) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn unknown_attachment() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10015, "Unknown Attachment")
    }

    pub fn unknown_scheduled_event() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10065, "Unknown Guild Scheduled Event")
    }

    /// 180000: a completed or canceled scheduled event cannot change any more.
    pub fn finished_event() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 180000, "Cannot update a finished event")
    }

    pub fn unknown_emoji() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10014, "Unknown Emoji")
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, 0, "404: Not Found")
    }

    pub fn conflict(code: u32, message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    /// 400 / 50024: the action does not apply to this channel type.
    pub fn wrong_channel_type() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 50024, "Cannot execute action on this channel type")
    }

    /// 403 / 50083: archived threads are read-only until they are unarchived.
    pub fn thread_archived() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50083, "Thread is archived")
    }

    /// 403 / 160005: only MANAGE_THREADS can act in a locked thread.
    pub fn thread_locked() -> Self {
        Self::new(StatusCode::FORBIDDEN, 160005, "Thread is locked")
    }

    pub fn thread_exists() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 160004, "A thread has already been created for this message")
    }

    pub fn tag_required() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 220003, "A tag is required to create a forum post in this channel")
    }

    pub fn unknown_thread_member() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10065, "Unknown thread member")
    }

    pub fn already_published() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 40033, "This message has already been crossposted")
    }

    /// 403 / 20001: routes only people may use.
    pub fn bots_forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, 20001, "Bots cannot use this endpoint")
    }

    pub fn unknown_application() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10002, "Unknown Application")
    }

    pub fn unknown_webhook() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10015, "Unknown Webhook")
    }

    pub fn invalid_webhook_token() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, 50027, "Invalid Webhook Token")
    }

    pub fn unknown_interaction() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10062, "Unknown interaction")
    }

    pub fn unknown_command() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10063, "Unknown application command")
    }

    pub fn already_acknowledged() -> Self {
        Self::new(StatusCode::BAD_REQUEST, 40060, "Interaction has already been acknowledged")
    }

    /// 429 with a `RateLimitError`-shaped body, for limits enforced inside a handler (webhook execute, running commands).
    pub fn rate_limited(retry_after: f64) -> Self {
        let mut error = Self::new(StatusCode::TOO_MANY_REQUESTS, 0, "You are being rate limited.");
        error.retry_after = Some(retry_after);
        error
    }

    /// 403 / 50009: the guild's verification level is above what the member meets.
    pub fn verification_level() -> Self {
        Self::new(StatusCode::FORBIDDEN, 50009, "Channel verification level is too high for you to gain access")
    }

    /// 400 / 200000: an AutoMod rule blocked the message; `errors.content` carries the rule's custom message when it has one.
    pub fn automod_blocked(custom_message: Option<&str>) -> Self {
        let error = Self::new(StatusCode::BAD_REQUEST, 200000, "Message was blocked by automatic moderation");
        match custom_message {
            Some(message) => error.with_errors(json!({ "content": { "_errors": [{ "code": "AUTOMOD_BLOCKED", "message": message }] } })),
            None => error,
        }
    }

    pub fn unknown_automod_rule() -> Self {
        Self::new(StatusCode::NOT_FOUND, 10066, "Unknown auto moderation rule")
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
        if let Some(retry_after) = self.retry_after {
            let body = RateLimitError { message: self.body.message, retry_after, global: false };
            let mut response = (self.status, Json(body)).into_response();
            if let Ok(value) = HeaderValue::from_str(&(retry_after.ceil().max(1.0) as u64).to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
            return response;
        }
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
