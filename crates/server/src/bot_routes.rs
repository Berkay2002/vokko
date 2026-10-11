//! What a bot token may call. Bots are denied by default: a request with a `Bot ` token reaches only the routes listed here,
//! everything else (accounts, sessions, MFA, OAuth, friends, invites, guild creation, settings, ...) answers 403 20001.
//! A route added later stays closed to bots until it is listed.
use axum::extract::{MatchedPath, Request};
use axum::http::Method;
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiErr;

const GET: u8 = 1;
const POST: u8 = 2;
const PUT: u8 = 4;
const PATCH: u8 = 8;
const DELETE: u8 = 16;

/// Route pattern (as registered under `/api/v1`) and the methods a bot may use on it.
const ALLOWED: &[(&str, u8)] = &[
    // itself
    ("/users/@me", GET | PATCH),
    ("/users/@me/guilds", GET),
    ("/users/@me/guilds/{id}", DELETE),
    // one-to-one DMs with people it shares a guild with (checked in the handler and in channel access)
    ("/users/@me/channels", POST),
    ("/users/{id}", GET),
    // guilds it was added to
    ("/guilds/{id}", GET | PATCH),
    ("/guilds/{id}/bans", GET),
    ("/guilds/{id}/bans/{uid}", PUT | DELETE),
    ("/guilds/{id}/channels", GET | POST),
    ("/guilds/{id}/integrations", GET),
    ("/guilds/{id}/integrations/{app}", DELETE),
    ("/guilds/{id}/members", GET),
    ("/guilds/{id}/members/@me", PATCH),
    ("/guilds/{id}/members/{uid}", PATCH | DELETE),
    ("/guilds/{id}/onboarding", GET | PUT),
    ("/guilds/{id}/roles", POST | PATCH),
    ("/guilds/{id}/roles/{rid}", PATCH | DELETE),
    ("/guilds/{id}/scheduled-events", GET | POST),
    ("/guilds/{id}/scheduled-events/{eid}", GET | PATCH | DELETE),
    ("/guilds/{id}/scheduled-events/{eid}/users", GET),
    ("/guilds/{id}/stickers", GET | POST),
    ("/guilds/{id}/stickers/{sid}", GET | PATCH | DELETE),
    ("/guilds/{id}/threads/active", GET),
    ("/guilds/{id}/webhooks", GET),
    // channels and messages
    ("/channels/{id}", PATCH | DELETE),
    ("/channels/{id}/attachments", POST),
    ("/channels/{id}/followers", GET | POST),
    ("/channels/{id}/followers/{follow_id}", DELETE),
    ("/channels/{id}/invites", POST),
    ("/channels/{id}/messages", GET | POST),
    ("/channels/{id}/messages/{mid}", PATCH | DELETE),
    ("/channels/{id}/messages/{mid}/crosspost", POST),
    ("/channels/{id}/messages/{mid}/reactions/{emoji}", GET),
    ("/channels/{id}/messages/{mid}/reactions/{emoji}/@me", PUT | DELETE),
    ("/channels/{id}/messages/{mid}/threads", POST),
    ("/channels/{id}/messages/pins", GET),
    ("/channels/{id}/messages/pins/{mid}", PUT | DELETE),
    ("/channels/{id}/permissions/{oid}", PUT | DELETE),
    ("/channels/{id}/thread-members", GET),
    ("/channels/{id}/thread-members/{uid}", GET | PUT | DELETE),
    ("/channels/{id}/threads", POST),
    ("/channels/{id}/threads/archived/private", GET),
    ("/channels/{id}/threads/archived/public", GET),
    ("/channels/{id}/users/@me/threads/archived/private", GET),
    ("/channels/{id}/typing", POST),
    ("/channels/{id}/webhooks", GET | POST),
    ("/invites/{code}", GET),
    ("/attachments/{id}/{key}/{filename}", GET),
    // its application: commands, interaction responses, webhooks
    ("/applications/{id}/commands", GET | PUT | POST),
    ("/applications/{id}/commands/{cmd}", GET | PATCH | DELETE),
    ("/applications/{id}/guilds/{gid}/commands", GET | PUT | POST),
    ("/applications/{id}/guilds/{gid}/commands/{cmd}", GET | PATCH | DELETE),
    ("/interactions/{id}/{token}/callback", POST),
    ("/webhooks/{id}", GET | PATCH | DELETE),
    ("/webhooks/{id}/{token}", GET | PATCH | DELETE | POST),
    ("/webhooks/{id}/{token}/messages/{mid}", GET | PATCH | DELETE),
];

fn method_bit(method: &Method) -> u8 {
    match *method {
        Method::GET | Method::HEAD => GET,
        Method::POST => POST,
        Method::PUT => PUT,
        Method::PATCH => PATCH,
        Method::DELETE => DELETE,
        _ => 0,
    }
}

/// Whether a bot may call `method` on the route registered as `route` (with or without the `/api/v1` prefix).
pub fn bot_may_call(method: &Method, route: &str) -> bool {
    let route = route.strip_prefix("/api/v1").unwrap_or(route);
    let bit = method_bit(method);
    ALLOWED.iter().any(|(pattern, methods)| *pattern == route && methods & bit != 0)
}

/// Middleware on the API router: a `Bot ` token on an unlisted route is refused before the handler runs.
pub async fn middleware(request: Request, next: Next) -> Response {
    let bot = request.headers().get(AUTHORIZATION).and_then(|value| value.to_str().ok()).is_some_and(|value| value.trim_start().starts_with("Bot "));
    if bot && !request.method().eq(&Method::OPTIONS) {
        let allowed = request.extensions().get::<MatchedPath>().is_some_and(|route| bot_may_call(request.method(), route.as_str()));
        if !allowed {
            return ApiErr::bots_forbidden().into_response();
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listed_routes_and_methods_only() {
        assert!(bot_may_call(&Method::POST, "/api/v1/channels/{id}/messages"));
        assert!(bot_may_call(&Method::POST, "/interactions/{id}/{token}/callback"));
        assert!(!bot_may_call(&Method::POST, "/invites/{code}"));
        assert!(bot_may_call(&Method::GET, "/invites/{code}"));
        assert!(!bot_may_call(&Method::POST, "/guilds"));
        assert!(!bot_may_call(&Method::POST, "/users/@me/relationships"));
        assert!(!bot_may_call(&Method::GET, "/auth/sessions"));
        assert!(!bot_may_call(&Method::POST, "/users/@me/delete"));
        assert!(!bot_may_call(&Method::DELETE, "/guilds/{id}"));
    }
}
