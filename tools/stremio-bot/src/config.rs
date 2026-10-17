//! Environment configuration. The names match the server's `VOKKO_STREMIO_*` family.

use std::net::SocketAddr;

#[derive(Clone)]
pub struct Config {
    pub secret: String,
    pub listen: SocketAddr,
    /// Base URL of vokko-server, where `POST /internal/stremio/bot` lives.
    pub server_url: String,
    pub max_sessions: usize,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub codec: Codec,
    pub encoder: Encoder,
    pub simulcast: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Vp8,
    H264,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoder {
    Auto,
    Software,
    VideoToolbox,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let or = |key: &str, default: &str| get(key).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_owned());
        let secret = get("VOKKO_STREMIO_BOT_SECRET").unwrap_or_default();
        if secret.len() < 16 {
            return Err("VOKKO_STREMIO_BOT_SECRET must be set (at least 16 characters)".into());
        }
        let listen = or("VOKKO_STREMIO_BOT_LISTEN", "127.0.0.1:8720");
        let max_sessions = or("VOKKO_STREMIO_MAX_SESSIONS", "2");
        Ok(Self {
            secret,
            listen: listen.parse().map_err(|_| format!("VOKKO_STREMIO_BOT_LISTEN is not host:port: {listen}"))?,
            server_url: or("VOKKO_STREMIO_SERVER_URL", "http://127.0.0.1:8710").trim_end_matches('/').to_owned(),
            max_sessions: max_sessions.parse().map_err(|_| format!("VOKKO_STREMIO_MAX_SESSIONS is not a number: {max_sessions}"))?,
            ffmpeg: or("VOKKO_STREMIO_FFMPEG", "ffmpeg"),
            ffprobe: or("VOKKO_STREMIO_FFPROBE", "ffprobe"),
            codec: match or("VOKKO_STREMIO_CODEC", "vp8").as_str() {
                "vp8" => Codec::Vp8,
                "h264" => Codec::H264,
                other => return Err(format!("VOKKO_STREMIO_CODEC must be vp8 or h264, not {other}")),
            },
            encoder: match or("VOKKO_STREMIO_ENCODER", "auto").as_str() {
                "auto" => Encoder::Auto,
                "software" => Encoder::Software,
                "videotoolbox" => Encoder::VideoToolbox,
                other => return Err(format!("VOKKO_STREMIO_ENCODER must be auto, software or videotoolbox, not {other}")),
            },
            simulcast: or("VOKKO_STREMIO_SIMULCAST", "true") != "false",
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
        let c = Config::from_lookup(lookup(&[("VOKKO_STREMIO_BOT_SECRET", "0123456789abcdef")])).expect("config");
        assert_eq!((c.listen.to_string().as_str(), c.max_sessions, c.codec, c.simulcast), ("127.0.0.1:8720", 2, Codec::Vp8, true));
        let c = Config::from_lookup(lookup(&[
            ("VOKKO_STREMIO_BOT_SECRET", "0123456789abcdef"),
            ("VOKKO_STREMIO_SERVER_URL", "http://s:1/"),
            ("VOKKO_STREMIO_CODEC", "h264"),
            ("VOKKO_STREMIO_SIMULCAST", "false"),
        ]))
        .expect("config");
        assert_eq!((c.server_url.as_str(), c.codec, c.simulcast), ("http://s:1", Codec::H264, false));
    }

    #[test]
    fn rejects_missing_secret_and_bad_values() {
        assert!(Config::from_lookup(lookup(&[])).is_err());
        assert!(Config::from_lookup(lookup(&[("VOKKO_STREMIO_BOT_SECRET", "short")])).is_err());
        assert!(Config::from_lookup(lookup(&[("VOKKO_STREMIO_BOT_SECRET", "0123456789abcdef"), ("VOKKO_STREMIO_CODEC", "av1")])).is_err());
    }
}
