//! REST client: every call is timed under its label and failures are tallied by status and API error code.
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::Value;

use crate::stats::Shared;

#[derive(Clone, Debug)]
pub struct User {
    pub index: usize,
    pub token: String,
    /// Simulated client address (`X-Forwarded-For`, honoured by the server only with `VOKKO_TRUST_PROXY=on`).
    pub addr: Option<String>,
}

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: u64,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {} (code {})", self.status, self.code)
    }
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    pub base: String,
    shared: Arc<Shared>,
}

/// A distinct private address per simulated client.
pub fn simulated_addr(index: usize) -> String {
    let n = index + 1;
    format!("10.{}.{}.{}", (n >> 16) & 255, (n >> 8) & 255, n & 255)
}

impl Api {
    pub fn new(base: &str, shared: Arc<Shared>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(4096)
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| format!("cannot build the HTTP client: {error}"))?;
        Ok(Self { client, base: base.trim_end_matches('/').to_owned(), shared })
    }

    /// `label` names the route in the report (`send_message`, not the URL with ids in it).
    pub async fn call(&self, label: &str, method: Method, path: &str, user: Option<&User>, body: Option<Value>) -> Result<Value, Failure> {
        let mut request = self.client.request(method, format!("{}/api/v1{path}", self.base));
        if let Some(user) = user {
            request = request.header("authorization", &user.token);
            if let Some(addr) = &user.addr {
                request = request.header("x-forwarded-for", addr);
            }
        }
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let metrics = self.shared.m();
        let started = Instant::now();
        let response = request.send().await;
        let outcome = match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let bytes = response.bytes().await.unwrap_or_default();
                let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                if (200..300).contains(&status) { Ok(value) } else { Err(Failure { status, code: value.get("code").and_then(Value::as_u64).unwrap_or(0) }) }
            }
            Err(_) => Err(Failure { status: 0, code: 0 }),
        };
        metrics.time(&format!("rest:{label}"), started.elapsed());
        if let Err(failure) = &outcome {
            metrics.error(&format!("{label} {} code {}", if failure.status == 0 { "transport".to_owned() } else { failure.status.to_string() }, failure.code));
            if failure.status == 429 {
                metrics.add("limit_hits:rest_429", 1);
            }
        }
        outcome
    }

    pub async fn register(&self, name: &str, password: &str, addr: Option<String>, index: usize) -> Result<User, Failure> {
        let mut request = self.client.post(format!("{}/api/v1/auth/register", self.base));
        if let Some(addr) = &addr {
            request = request.header("x-forwarded-for", addr);
        }
        let body = serde_json::json!({"email": format!("{name}@loadtest.invalid"), "username": name, "password": password, "date_of_birth": "1990-01-01", "consent": true});
        let metrics = self.shared.m();
        let started = Instant::now();
        let response = request.header("content-type", "application/json").body(body.to_string()).send().await;
        let result = match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let value: Value = serde_json::from_slice(&response.bytes().await.unwrap_or_default()).unwrap_or(Value::Null);
                match (status, value.get("token").and_then(Value::as_str)) {
                    (200, Some(token)) => Ok(User { index, token: token.to_owned(), addr }),
                    _ => Err(Failure { status, code: value.get("code").and_then(Value::as_u64).unwrap_or(0) }),
                }
            }
            Err(_) => Err(Failure { status: 0, code: 0 }),
        };
        metrics.time("rest:register", started.elapsed());
        if let Err(failure) = &result {
            metrics.error(&format!("register {} code {}", failure.status, failure.code));
            if failure.status == 429 {
                metrics.add("limit_hits:rest_429", 1);
            }
        }
        result
    }
}
