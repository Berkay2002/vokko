//! LiveKit access tokens (HS256 JWTs signed with the API secret) and the webhook signature check.
//!
//! Grants come from Vokko permissions (docs/design/voice.md §1.3): the SFU enforces what the token allows, so the token is
//! where SPEAK / STREAM become publish rights.
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use vokko_protocol::api::permissions::{SPEAK, STREAM};

use super::livekit::Permission;

/// How long a minted token stays usable for a first connect (LiveKit refreshes it for connected participants).
pub const TOKEN_TTL_SECS: i64 = 10 * 60;

/// LiveKit's `video` grant, camelCase like LiveKit's claims.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default)]
    pub room_join: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_admin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_list: bool,
    #[serde(default)]
    pub can_subscribe: bool,
    #[serde(default)]
    pub can_publish: bool,
    #[serde(default)]
    pub can_publish_sources: Vec<String>,
    #[serde(default)]
    pub can_publish_data: bool,
    #[serde(default)]
    pub can_update_own_metadata: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub recorder: bool,
}

/// The claims Vokko puts in (and reads back from) a LiveKit token.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sub: String,
    #[serde(default)]
    pub nbf: i64,
    #[serde(default)]
    pub exp: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub metadata: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub attributes: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoGrant>,
    /// Webhooks only: base64 SHA-256 of the request body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// Publish/subscribe rights for a member with `permissions` in the channel: microphone with SPEAK, camera and screen
/// share with STREAM. Self mute/deafen never change the token (client state only).
pub fn media_grant(room: &str, permissions: u64) -> VideoGrant {
    grant(room, &rights(permissions, Moderation::default()))
}

/// Server-side restrictions on top of the channel permissions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moderation {
    /// Server muted: no microphone.
    pub mute: bool,
    /// Server deafened: no microphone and no subscribing.
    pub deaf: bool,
    /// Stage audience: nothing to publish, and hidden from the room.
    pub audience: bool,
}

/// What the SFU lets the participant do (token grant and `UpdateParticipant`).
pub fn rights(permissions: u64, moderation: Moderation) -> Permission {
    let mut sources = Vec::new();
    if permissions & SPEAK != 0 && !moderation.mute && !moderation.deaf && !moderation.audience {
        sources.push("microphone".to_owned());
    }
    if permissions & STREAM != 0 && !moderation.audience {
        sources.extend(["camera", "screen_share", "screen_share_audio"].map(str::to_owned));
    }
    Permission { can_subscribe: !moderation.deaf, sources, hidden: moderation.audience }
}

pub fn grant(room: &str, rights: &Permission) -> VideoGrant {
    VideoGrant {
        room: Some(room.to_owned()),
        room_join: true,
        can_subscribe: rights.can_subscribe,
        can_publish: !rights.sources.is_empty(),
        can_publish_sources: rights.sources.clone(),
        hidden: rights.hidden,
        ..VideoGrant::default()
    }
}

type HmacSha256 = Hmac<Sha256>;

fn signature(secret: &str, signing_input: &str) -> Option<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(signing_input.as_bytes());
    Some(mac.finalize().into_bytes().to_vec())
}

/// Signs `claims` as an HS256 JWT.
pub fn sign(secret: &str, claims: &Claims) -> Option<String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).ok()?);
    let input = format!("{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signature(secret, &input)?);
    Some(format!("{input}.{signature}"))
}

/// Verifies an HS256 JWT signed with `secret` (constant-time MAC check) and its `nbf`/`exp` against `now` (unix seconds).
pub fn verify(secret: &str, token: &str, now: i64) -> Option<Claims> {
    verify_signature(secret, token).filter(|claims| in_window(claims, now))
}

fn in_window(claims: &Claims, now: i64) -> bool {
    !((claims.exp != 0 && claims.exp < now) || claims.nbf > now + 60)
}

/// The signature and structure check of `verify`, without the time window.
fn verify_signature(secret: &str, token: &str) -> Option<Claims> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    if header.get("alg").and_then(Value::as_str) != Some("HS256") {
        return None;
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{}.{payload}", token.split('.').next()?).as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?).ok()?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

/// Reads the claims without checking the signature (tests and diagnostics only).
pub fn decode_unverified(token: &str) -> Option<Claims> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

/// `base64(sha256(body))` as LiveKit puts it in the webhook token's `sha256` claim.
pub fn body_hash(body: &[u8]) -> String {
    STANDARD.encode(Sha256::digest(body))
}

/// Why a webhook was refused (the handler logs the category, never the token).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebhookRefusal {
    /// No `Authorization` header (or an empty one).
    MissingHeader,
    /// Not a JWT, not HS256, or not signed with our API secret.
    BadSignature,
    /// Signed by us but outside its `nbf`/`exp` window (or the server clock is off).
    Expired,
    /// Signed with our secret but issued for another API key.
    WrongKey,
    /// The `sha256` claim is missing or is not the hash of the body.
    BodyHashMismatch,
}

impl WebhookRefusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::MissingHeader => "missing Authorization header",
            Self::BadSignature => "bad signature",
            Self::Expired => "expired token",
            Self::WrongKey => "token issued for another API key",
            Self::BodyHashMismatch => "body hash mismatch",
        }
    }
}

/// A webhook is genuine when its `Authorization` token is signed by `secret`, issued for `api_key`, and hashes `body`.
pub fn verify_webhook(api_key: &str, secret: &str, authorization: &str, body: &[u8], now: i64) -> Result<(), WebhookRefusal> {
    let token = authorization.strip_prefix("Bearer ").unwrap_or(authorization).trim();
    if token.is_empty() {
        return Err(WebhookRefusal::MissingHeader);
    }
    let claims = verify_signature(secret, token).ok_or(WebhookRefusal::BadSignature)?;
    if !in_window(&claims, now) {
        return Err(WebhookRefusal::Expired);
    }
    if claims.iss != api_key {
        return Err(WebhookRefusal::WrongKey);
    }
    if claims.sha256.as_deref() != Some(body_hash(body).as_str()) {
        return Err(WebhookRefusal::BodyHashMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vokko_protocol::api::permissions::{CONNECT, VIEW_CHANNEL};

    #[test]
    fn grants_follow_speak_and_stream() {
        let grant = media_grant("v1", VIEW_CHANNEL | CONNECT | SPEAK | STREAM);
        assert_eq!(grant.can_publish_sources, ["microphone", "camera", "screen_share", "screen_share_audio"]);
        assert!(grant.room_join && grant.can_subscribe && grant.can_publish && !grant.can_publish_data && !grant.can_update_own_metadata);
        let listener = media_grant("v1", VIEW_CHANNEL | CONNECT);
        assert!(listener.can_publish_sources.is_empty() && !listener.can_publish && listener.can_subscribe);
        assert_eq!(media_grant("v1", CONNECT | STREAM).can_publish_sources.first().map(String::as_str), Some("camera"));
    }

    #[test]
    fn server_mute_deafen_and_stage_audience_narrow_the_grant() {
        let all = SPEAK | STREAM;
        let muted = rights(all, Moderation { mute: true, ..Moderation::default() });
        assert_eq!((muted.sources.len(), muted.can_subscribe), (3, true), "camera/screen stay");
        assert!(!muted.sources.contains(&"microphone".to_owned()));
        let deaf = rights(all, Moderation { deaf: true, ..Moderation::default() });
        assert!(!deaf.can_subscribe && !deaf.sources.contains(&"microphone".to_owned()));
        let audience = grant("v1", &rights(all, Moderation { audience: true, ..Moderation::default() }));
        assert!(audience.can_publish_sources.is_empty() && !audience.can_publish && audience.hidden && audience.can_subscribe);
    }

    #[test]
    fn tokens_round_trip_and_reject_tampering() {
        let claims = Claims { iss: "key".into(), sub: "42".into(), exp: 2_000, video: Some(media_grant("v7", SPEAK)), ..Claims::default() };
        let token = sign("secret", &claims).expect("sign");
        assert_eq!(verify("secret", &token, 1_000), Some(claims.clone()));
        assert_eq!(verify("other", &token, 1_000), None, "wrong secret");
        assert_eq!(verify("secret", &token, 2_001), None, "expired");
        let mut forged = claims;
        forged.video = Some(media_grant("v7", SPEAK | STREAM));
        let forged_payload = sign("attacker", &forged).expect("sign").split('.').nth(1).expect("payload").to_owned();
        let mut parts: Vec<&str> = token.split('.').collect();
        parts[1] = &forged_payload;
        assert_eq!(verify("secret", &parts.join("."), 1_000), None, "payload swapped under the old signature");
        assert_eq!(decode_unverified(&token).map(|claims| claims.sub), Some("42".to_owned()));
        // LiveKit's claim names
        let raw: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1).expect("payload")).expect("b64")).expect("json");
        assert_eq!(raw["video"]["roomJoin"], true);
        assert_eq!(raw["video"]["canPublishSources"][0], "microphone");
    }

    #[test]
    fn webhook_signature_covers_the_body() {
        let body = br#"{"event":"participant_joined"}"#;
        let claims = Claims { iss: "key".into(), exp: 2_000, sha256: Some(body_hash(body)), ..Claims::default() };
        let token = sign("secret", &claims).expect("sign");
        assert_eq!(verify_webhook("key", "secret", &token, body, 1_000), Ok(()));
        assert_eq!(verify_webhook("key", "secret", &format!("Bearer {token}"), body, 1_000), Ok(()));
        assert_eq!(verify_webhook("key", "secret", &token, br#"{"event":"participant_left"}"#, 1_000), Err(WebhookRefusal::BodyHashMismatch), "other body");
        assert_eq!(verify_webhook("other", "secret", &token, body, 1_000), Err(WebhookRefusal::WrongKey), "other key");
        assert_eq!(verify_webhook("key", "nope", &token, body, 1_000), Err(WebhookRefusal::BadSignature), "other secret");
        assert_eq!(verify_webhook("key", "secret", "garbage", body, 1_000), Err(WebhookRefusal::BadSignature));
        assert_eq!(verify_webhook("key", "secret", "", body, 1_000), Err(WebhookRefusal::MissingHeader));
        assert_eq!(verify_webhook("key", "secret", "Bearer ", body, 1_000), Err(WebhookRefusal::MissingHeader));
        assert_eq!(verify_webhook("key", "secret", &token, body, 2_001), Err(WebhookRefusal::Expired));
        let unhashed = sign("secret", &Claims { iss: "key".into(), exp: 2_000, ..Claims::default() }).expect("sign");
        assert_eq!(verify_webhook("key", "secret", &unhashed, body, 1_000), Err(WebhookRefusal::BodyHashMismatch), "no sha256 claim");
    }
}
