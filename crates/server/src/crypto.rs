//! Secrets at rest: XChaCha20-Poly1305 under `VOKKO_SECRETS_KEY` (docs/design/stremio-bot.md section 6.1). A sealed value is
//! `nonce(24) || ciphertext`, and the associated data binds it to one row, so a row copied to another user does not open.
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

const NONCE_LEN: usize = 24;

/// A string that must never reach a log line or a client: `Debug` prints `<redacted>`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// The 32-byte `VOKKO_SECRETS_KEY`.
#[derive(Clone)]
pub struct SecretsKey([u8; 32]);

impl std::fmt::Debug for SecretsKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretsKey(<redacted>)")
    }
}

impl SecretsKey {
    /// 32 bytes as base64 (standard or URL-safe, padded or not).
    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        let bytes = STANDARD.decode(value).or_else(|_| URL_SAFE_NO_PAD.decode(value.trim_end_matches('='))).map_err(|_| "VOKKO_SECRETS_KEY must be base64")?;
        let key: [u8; 32] = bytes.try_into().map_err(|_| "VOKKO_SECRETS_KEY must decode to exactly 32 bytes (openssl rand -base64 32)")?;
        Ok(Self(key))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Option<Vec<u8>> {
        let mut nonce = [0_u8; NONCE_LEN];
        rand::fill(&mut nonce);
        let sealed = XChaCha20Poly1305::new(Key::from_slice(&self.0)).encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad }).ok()?;
        Some([nonce.as_slice(), &sealed].concat())
    }

    /// `None` for a wrong key, wrong `aad` or a damaged value.
    pub fn open(&self, aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
        let (nonce, ciphertext) = sealed.split_at_checked(NONCE_LEN)?;
        XChaCha20Poly1305::new(Key::from_slice(&self.0)).decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad }).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_and_open_round_trip_and_bind_to_the_aad() {
        let key = SecretsKey::from_bytes([7; 32]);
        let sealed = key.seal(b"stremio:42", b"auth-key").expect("seal");
        assert_ne!(&sealed[NONCE_LEN..], b"auth-key");
        assert_eq!(key.open(b"stremio:42", &sealed).as_deref(), Some(b"auth-key".as_slice()));
        assert!(key.open(b"stremio:43", &sealed).is_none(), "another user's row");
        assert!(SecretsKey::from_bytes([8; 32]).open(b"stremio:42", &sealed).is_none(), "another key");
        let mut damaged = sealed.clone();
        *damaged.last_mut().expect("byte") ^= 1;
        assert!(key.open(b"stremio:42", &damaged).is_none());
        assert!(key.open(b"stremio:42", &sealed[..10]).is_none());
        assert_ne!(sealed, key.seal(b"stremio:42", b"auth-key").expect("seal"), "a fresh nonce every time");
    }

    #[test]
    fn keys_parse_from_base64_only() {
        let encoded = STANDARD.encode([1_u8; 32]);
        assert!(SecretsKey::parse(&encoded).is_ok() && SecretsKey::parse(&format!(" {encoded}\n")).is_ok());
        assert!(SecretsKey::parse(&URL_SAFE_NO_PAD.encode([255_u8; 32])).is_ok());
        for bad in ["", "short", &STANDARD.encode([1_u8; 31]), &STANDARD.encode([1_u8; 33])] {
            assert!(SecretsKey::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn secrets_do_not_debug() {
        assert_eq!(format!("{:?}", Secret::new("hunter2")), "<redacted>");
        assert!(!format!("{:?}", SecretsKey::from_bytes([9; 32])).contains('9'));
    }
}
