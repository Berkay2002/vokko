//! Environment configuration. The names match the server's `VOKKO_SPOTIFY_*` family.

use std::net::SocketAddr;

#[derive(Clone)]
pub struct Config {
    pub secret: String,
    pub listen: SocketAddr,
    /// Base URL of vokko-server, where `POST /internal/spotify/bot` lives.
    pub server_url: String,
    /// Country for catalog reads when the request names none (the house account's, like the server's `VOKKO_SPOTIFY_MARKET`).
    pub market: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let or = |key: &str, default: &str| get(key).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_owned());
        let secret = get("VOKKO_SPOTIFY_BOT_SECRET").unwrap_or_default();
        if secret.len() < 16 {
            return Err("VOKKO_SPOTIFY_BOT_SECRET must be set (at least 16 characters)".into());
        }
        let listen = or("VOKKO_SPOTIFY_BOT_LISTEN", "127.0.0.1:8721");
        let market = or("VOKKO_SPOTIFY_MARKET", "SE");
        if !crate::catalog::valid_market(&market) {
            return Err(format!("VOKKO_SPOTIFY_MARKET must be two capital letters, not {market}"));
        }
        Ok(Self {
            secret,
            listen: listen.parse().map_err(|_| format!("VOKKO_SPOTIFY_BOT_LISTEN is not host:port: {listen}"))?,
            server_url: or("VOKKO_SPOTIFY_SERVER_URL", "http://127.0.0.1:8710").trim_end_matches('/').to_owned(),
            market,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(pairs: &'static [(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(name, _)| *name == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn defaults_and_overrides() {
        let c = Config::from_lookup(lookup(&[("VOKKO_SPOTIFY_BOT_SECRET", "0123456789abcdef")])).expect("config");
        assert_eq!((c.listen.to_string().as_str(), c.server_url.as_str(), c.market.as_str()), ("127.0.0.1:8721", "http://127.0.0.1:8710", "SE"));
        let c = Config::from_lookup(lookup(&[
            ("VOKKO_SPOTIFY_BOT_SECRET", "0123456789abcdef"),
            ("VOKKO_SPOTIFY_SERVER_URL", "http://s:1/"),
            ("VOKKO_SPOTIFY_MARKET", "DE"),
        ]))
        .expect("config");
        assert_eq!((c.server_url.as_str(), c.market.as_str()), ("http://s:1", "DE"));
    }

    #[test]
    fn rejects_missing_secret_and_bad_values() {
        assert!(Config::from_lookup(lookup(&[])).is_err());
        assert!(Config::from_lookup(lookup(&[("VOKKO_SPOTIFY_BOT_SECRET", "short")])).is_err());
        assert!(Config::from_lookup(lookup(&[("VOKKO_SPOTIFY_BOT_SECRET", "0123456789abcdef"), ("VOKKO_SPOTIFY_MARKET", "se")])).is_err());
        assert!(Config::from_lookup(lookup(&[("VOKKO_SPOTIFY_BOT_SECRET", "0123456789abcdef"), ("VOKKO_SPOTIFY_BOT_LISTEN", "nope")])).is_err());
    }
}
