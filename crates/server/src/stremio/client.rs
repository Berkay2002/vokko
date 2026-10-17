//! Stremio's account API (`api.strem.io`) and its link service (`link.stremio.com`), docs/design/stremio-bot.md section 1.1.
//! The password of a `login` is used for that one request. Only the returned authKey is kept, and it is a `Secret`.
use serde_json::{Value, json};

use super::addons::Addon;
use super::fetch::{FetchError, Fetcher};
use crate::crypto::Secret;

/// Addons used from an account: more would make every stream listing a fan-out of requests.
const MAX_ADDONS: usize = 25;

#[derive(Debug, PartialEq, Eq)]
pub enum AccountError {
    /// Stremio says the session does not exist (error code 1): the authKey is dead and the user has to link again.
    SessionGone,
    /// Stremio refused the request (wrong password, bad code).
    Rejected,
    /// Stremio could not be reached or answered something unexpected.
    Unavailable,
}

#[derive(Clone)]
pub struct Account {
    fetcher: Fetcher,
    api: String,
    link: String,
}

/// `{result: T}` or `{error: {code, message}}`.
fn result(answer: Result<Value, FetchError>) -> Result<Value, AccountError> {
    let answer = answer.map_err(|error| {
        tracing::info!("stremio: account API call failed: {error:?}");
        AccountError::Unavailable
    })?;
    if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
        return Err(if error["code"].as_i64() == Some(1) { AccountError::SessionGone } else { AccountError::Rejected });
    }
    answer.get("result").cloned().ok_or(AccountError::Unavailable)
}

impl Account {
    pub fn new(fetcher: Fetcher, api: &str, link: &str) -> Self {
        Self { fetcher, api: api.trim_end_matches('/').to_owned(), link: link.trim_end_matches('/').to_owned() }
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value, AccountError> {
        result(self.fetcher.post_json(&format!("{}/api/{method}", self.api), &body).await)
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<Secret, AccountError> {
        let answer = self.call("login", json!({"type": "Login", "email": email, "password": password, "facebook": false})).await?;
        answer["authKey"].as_str().filter(|key| !key.is_empty()).map(Secret::new).ok_or(AccountError::Unavailable)
    }

    /// Whether the key still works.
    pub async fn check(&self, key: &Secret) -> Result<(), AccountError> {
        self.call("getUser", json!({"type": "GetUser", "authKey": key.expose()})).await.map(drop)
    }

    pub async fn logout(&self, key: &Secret) -> Result<(), AccountError> {
        self.call("logout", json!({"type": "Logout", "authKey": key.expose()})).await.map(drop)
    }

    /// The addons installed in the account (`addonCollectionGet`), without the ones this server would never call.
    pub async fn addons(&self, key: &Secret) -> Result<Vec<Addon>, AccountError> {
        let answer = self.call("addonCollectionGet", json!({"type": "AddonCollectionGet", "authKey": key.expose(), "update": true})).await?;
        let entries = answer["addons"].as_array().ok_or(AccountError::Unavailable)?;
        Ok(entries.iter().filter_map(Addon::from_collection).filter(|addon| addon.reachable(&self.fetcher)).take(MAX_ADDONS).collect())
    }

    /// A code to approve at `link` in a browser that is logged in to Stremio.
    pub async fn link_create(&self) -> Result<(String, String), AccountError> {
        let answer = result(self.fetcher.get_json(&format!("{}/api/v2/create?type=Create", self.link)).await)?;
        let code = answer["code"].as_str().filter(|code| (1..=32).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric()));
        let link = answer["link"].as_str().filter(|link| link.starts_with("https://") && link.len() <= 200);
        code.zip(link).map(|(code, link)| (code.to_owned(), link.to_owned())).ok_or(AccountError::Unavailable)
    }

    /// `None` until the code is approved (Stremio answers error 101 meanwhile).
    pub async fn link_read(&self, code: &str) -> Result<Option<Secret>, AccountError> {
        let answer = self.fetcher.get_json(&format!("{}/api/v2/read?type=Read&code={code}", self.link)).await;
        match result(answer) {
            Ok(answer) => Ok(answer["authKey"].as_str().filter(|key| !key.is_empty()).map(Secret::new)),
            Err(AccountError::Rejected | AccountError::SessionGone) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
