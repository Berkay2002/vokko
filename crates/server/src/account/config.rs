//! Account settings from the environment: age limit, terms, link base and outgoing mail.
use crate::config::DotEnv;

pub const DEFAULT_MIN_AGE: u8 = 13;

#[derive(Clone, Debug)]
pub struct AccountsConfig {
    /// `VOKKO_MIN_AGE` (default 13).
    pub min_age: u8,
    /// `VOKKO_TERMS_TEXT` / `VOKKO_TERMS_URL`: either one turns on the consent checkbox.
    pub terms_text: Option<String>,
    pub terms_url: Option<String>,
    /// Origin of the web client, used in emailed links (`VOKKO_WEB_URL`, default the public URL).
    pub web_url: String,
    pub mail: MailConfig,
    /// Sign-in providers whose variables are set (`VOKKO_OAUTH_GITHUB_*`, `VOKKO_OAUTH_GOOGLE_*`, `VOKKO_OIDC_<NAME>_*`).
    pub providers: Vec<ProviderConfig>,
}

#[derive(Clone)]
pub struct ProviderConfig {
    /// Stable id used in URLs and stored identities.
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub client_id: String,
    pub client_secret: String,
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never print the secret
        f.debug_struct("ProviderConfig").field("id", &self.id).field("kind", &self.kind).finish()
    }
}

#[derive(Clone, Debug)]
pub enum ProviderKind {
    /// GitHub OAuth app; the URLs are configurable for tests.
    Github {
        auth_url: String,
        token_url: String,
        api_url: String,
    },
    Google {
        issuer: String,
    },
    Oidc {
        issuer: String,
    },
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Github { .. } => "github",
            Self::Google { .. } => "google",
            Self::Oidc { .. } => "oidc",
        }
    }

    pub fn github() -> Self {
        Self::Github {
            auth_url: "https://github.com/login/oauth/authorize".to_owned(),
            token_url: "https://github.com/login/oauth/access_token".to_owned(),
            api_url: "https://api.github.com".to_owned(),
        }
    }
}

#[derive(Clone, Debug)]
pub enum MailConfig {
    /// No SMTP configured: mails (with their links) go to the log for self-hosters.
    Log,
    /// Kept in memory for tests.
    Memory,
    /// In memory, each send blocking for this long (tests: proves a route does not wait on mail).
    SlowMemory(std::time::Duration),
    Smtp(SmtpConfig),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SmtpSecurity {
    StartTls,
    Tls,
    None,
}

#[derive(Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub username: Option<String>,
    pub password: Option<String>,
    pub from: String,
}

impl std::fmt::Debug for SmtpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never print the password
        f.debug_struct("SmtpConfig").field("host", &self.host).field("port", &self.port).field("security", &self.security).field("from", &self.from).finish()
    }
}

impl AccountsConfig {
    pub fn new(public_url: &str) -> Self {
        Self { min_age: DEFAULT_MIN_AGE, terms_text: None, terms_url: None, web_url: public_url.to_owned(), mail: MailConfig::Log, providers: Vec::new() }
    }

    pub fn from_env(env: &DotEnv, public_url: &str) -> Result<Self, String> {
        let mut config = Self::new(public_url);
        if let Some(value) = env.get("VOKKO_MIN_AGE") {
            config.min_age = value.trim().parse().map_err(|_| format!("VOKKO_MIN_AGE must be a whole number of years, got {value}"))?;
        }
        config.terms_text = env.get("VOKKO_TERMS_TEXT").map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        config.terms_url = env.get("VOKKO_TERMS_URL").map(|url| url.trim().to_owned()).filter(|url| !url.is_empty());
        if let Some(url) = env.get("VOKKO_WEB_URL") {
            config.web_url = url.trim().trim_end_matches('/').to_owned();
        }
        let smtp_keys: Vec<String> = env.keys().into_iter().filter(|key| key.starts_with("VOKKO_SMTP_") && env.get(key).is_some()).collect();
        if env.get("VOKKO_SMTP_HOST").is_none() && !smtp_keys.is_empty() {
            // half an SMTP setup is a mistake, not a wish to log links
            return Err(format!("{} set without VOKKO_SMTP_HOST", smtp_keys.join(", ")));
        }
        if let Some(host) = env.get("VOKKO_SMTP_HOST") {
            let security = match env.get("VOKKO_SMTP_SECURITY").map(|value| value.to_ascii_lowercase()).as_deref() {
                None | Some("starttls") => SmtpSecurity::StartTls,
                Some("tls") => SmtpSecurity::Tls,
                Some("none") => SmtpSecurity::None,
                Some(other) => return Err(format!("VOKKO_SMTP_SECURITY must be starttls, tls or none, got {other}")),
            };
            let default_port = match security {
                SmtpSecurity::StartTls => 587,
                SmtpSecurity::Tls => 465,
                SmtpSecurity::None => 25,
            };
            let port = match env.get("VOKKO_SMTP_PORT") {
                Some(value) => value.trim().parse().map_err(|_| format!("VOKKO_SMTP_PORT must be a port number, got {value}"))?,
                None => default_port,
            };
            let from = env.get("VOKKO_SMTP_FROM").ok_or("VOKKO_SMTP_FROM is required when VOKKO_SMTP_HOST is set")?;
            let smtp = SmtpConfig {
                host: host.trim().to_owned(),
                port,
                security,
                username: env.get("VOKKO_SMTP_USERNAME"),
                password: env.get("VOKKO_SMTP_PASSWORD"),
                from,
            };
            if smtp.username.is_some() != smtp.password.is_some() {
                return Err("VOKKO_SMTP_USERNAME and VOKKO_SMTP_PASSWORD must be set together".to_owned());
            }
            super::mail::check_smtp(&smtp).map_err(|error| format!("invalid VOKKO_SMTP_* settings: {error}"))?;
            config.mail = MailConfig::Smtp(smtp);
        }
        config.providers = providers_from_env(env)?;
        Ok(config)
    }

    /// Label of the consent checkbox, if the instance has terms.
    pub fn terms(&self) -> Option<String> {
        match (&self.terms_text, &self.terms_url) {
            (Some(text), _) => Some(text.clone()),
            (None, Some(_)) => Some("I have read and agree to the Terms of Service.".to_owned()),
            (None, None) => None,
        }
    }
}

fn pair(env: &DotEnv, prefix: &str) -> Result<Option<(String, String)>, String> {
    match (env.get(&format!("{prefix}_CLIENT_ID")), env.get(&format!("{prefix}_CLIENT_SECRET"))) {
        (Some(id), Some(secret)) => Ok(Some((id, secret))),
        (None, None) => Ok(None),
        _ => Err(format!("{prefix}_CLIENT_ID and {prefix}_CLIENT_SECRET must be set together")),
    }
}

fn providers_from_env(env: &DotEnv) -> Result<Vec<ProviderConfig>, String> {
    let mut providers = Vec::new();
    if let Some((client_id, client_secret)) = pair(env, "VOKKO_OAUTH_GITHUB")? {
        providers.push(ProviderConfig { id: "github".to_owned(), name: "GitHub".to_owned(), kind: ProviderKind::github(), client_id, client_secret });
    }
    if let Some((client_id, client_secret)) = pair(env, "VOKKO_OAUTH_GOOGLE")? {
        let kind = ProviderKind::Google { issuer: "https://accounts.google.com".to_owned() };
        providers.push(ProviderConfig { id: "google".to_owned(), name: "Google".to_owned(), kind, client_id, client_secret });
    }
    let mut names: Vec<String> =
        env.keys().into_iter().filter_map(|key| key.strip_prefix("VOKKO_OIDC_").and_then(|rest| rest.strip_suffix("_ISSUER")).map(str::to_owned)).collect();
    names.sort();
    names.dedup();
    for name in names {
        let id = name.to_ascii_lowercase();
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') || id == "github" || id == "google" {
            return Err(format!("VOKKO_OIDC_{name}_*: the name must be letters, digits or _ and not GITHUB or GOOGLE"));
        }
        let prefix = format!("VOKKO_OIDC_{name}");
        let issuer = env.get(&format!("{prefix}_ISSUER")).unwrap_or_default();
        let (client_id, client_secret) =
            pair(env, &prefix)?.ok_or_else(|| format!("{prefix}_CLIENT_ID and {prefix}_CLIENT_SECRET are required with {prefix}_ISSUER"))?;
        let display = env.get(&format!("{prefix}_DISPLAY_NAME")).unwrap_or_else(|| {
            let mut chars = id.chars();
            chars.next().map(|first| first.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
        });
        providers.push(ProviderConfig {
            id,
            name: display,
            kind: ProviderKind::Oidc { issuer: issuer.trim_end_matches('/').to_owned() },
            client_id,
            client_secret,
        });
    }
    Ok(providers)
}
