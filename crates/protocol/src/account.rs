//! Wire types of the account routes (`docs/api.md` "Accounts"), mirroring the accounts section of `types.ts`.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InstanceInfo {
    /// `open` or `closed`.
    pub registration: String,
    pub min_age: u8,
    /// Plain-text label of the consent checkbox; `None` = no checkbox.
    pub terms: Option<String>,
    pub terms_url: Option<String>,
    /// The instance sends mail (SMTP): verification level Low and up need a verified email, new accounts are asked to verify.
    pub email_verification: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UsernameAttemptRequest {
    pub username: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsernameAttemptResponse {
    pub taken: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VerifyEmailRequest {
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountInfo {
    pub email: String,
    pub pending_email: Option<String>,
    pub verified: bool,
    pub has_password: bool,
    pub mfa_enabled: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditAccountRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditAccountResponse {
    pub user: crate::api::User,
    pub account: AccountInfo,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PasswordConfirmRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Login answer while two-factor is on (`token` is always `null`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MfaRequiredResponse {
    pub token: Option<String>,
    pub mfa: bool,
    pub ticket: String,
    pub totp: bool,
    pub backup: bool,
}

/// `POST /auth/login` and `/auth/reset`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LoginResponse {
    Session(Box<crate::api::AuthResponse>),
    Mfa(MfaRequiredResponse),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MfaLoginRequest {
    pub ticket: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnableTotpRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub secret: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CodeRequest {
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackupCode {
    pub code: Option<String>,
    pub consumed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackupCodesResponse {
    pub backup_codes: Vec<BackupCode>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupCodesRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default)]
    pub regenerate: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub os: Option<String>,
    pub platform: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserSession {
    pub id_hash: String,
    pub approx_last_used_time: String,
    pub client_info: ClientInfo,
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserSessions {
    pub user_sessions: Vec<UserSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogoutSessionsRequest {
    pub session_id_hashes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForgotPasswordRequest {
    pub login: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub password: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthProvider {
    pub id: String,
    pub name: String,
    /// `github`, `google` or `oidc`.
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuthAuthorizeRequest {
    /// `web` or `desktop`.
    pub target: String,
    pub client_challenge: String,
    #[serde(default)]
    pub link: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OAuthAuthorizeResponse {
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuthCompleteRequest {
    pub code: String,
    pub client_verifier: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OAuthRegistration {
    pub ticket: String,
    pub provider: String,
    pub email: Option<String>,
    pub suggested_username: Option<String>,
    pub global_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OAuthCompleteResponse {
    Login { login: LoginResponse },
    Register { registration: OAuthRegistration },
    Linked { provider: String },
    Reauthenticated { provider: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuthRegisterRequest {
    pub ticket: String,
    pub username: String,
    #[serde(default)]
    pub date_of_birth: Option<String>,
    #[serde(default)]
    pub consent: Option<bool>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkedProvider {
    pub provider: String,
    pub name: String,
    pub email: Option<String>,
    pub linked_at: String,
}
