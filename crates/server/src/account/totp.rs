//! TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps) and RFC 4648 base32 for the shared secret.
use hmac::{Hmac, Mac};
use sha1::Sha1;

pub const STEP_SECONDS: u64 = 30;
/// Shortest accepted secret: 16 base32 chars = 80 bits.
pub const MIN_SECRET_CHARS: usize = 16;

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    out
}

/// Decodes base32 (case-insensitive, spaces and `=` padding ignored); `None` on any other character.
pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in text.chars().filter(|c| !c.is_whitespace() && *c != '=') {
        let value = ALPHABET.iter().position(|&a| char::from(a) == c.to_ascii_uppercase())? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The secret in canonical form (uppercase, no spaces or padding) if it is valid base32 of at least 80 bits.
pub fn normalize_secret(text: &str) -> Option<String> {
    let canonical: String = text.chars().filter(|c| !c.is_whitespace() && *c != '=').map(|c| c.to_ascii_uppercase()).collect();
    if canonical.len() < MIN_SECRET_CHARS || canonical.len() > 128 {
        return None;
    }
    base32_decode(&canonical).map(|_| canonical)
}

pub fn code_at(key: &[u8], step: u64) -> u32 {
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(key) else { return u32::MAX };
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let binary = u32::from_be_bytes([digest[offset] & 0x7f, digest[offset + 1], digest[offset + 2], digest[offset + 3]]);
    binary % 1_000_000
}

/// Constant-time equality of two byte strings of the same length.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The 30 s step a 6-digit `code` matches at `unix_seconds` (±1 step), compared in constant time.
pub fn matching_step(secret: &str, code: &str, unix_seconds: u64) -> Option<u64> {
    let code = code.trim().replace(' ', "");
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let key = base32_decode(secret)?;
    let now = unix_seconds / STEP_SECONDS;
    let mut found = None;
    for step in [now.saturating_sub(1), now, now + 1] {
        let expected = format!("{:06}", code_at(&key, step));
        if ct_eq(expected.as_bytes(), code.as_bytes()) {
            found = Some(step);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_vectors() {
        // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", truncated to 6 digits
        let key = b"12345678901234567890";
        for (time, expected) in [(59_u64, 287_082_u32), (1_111_111_109, 81_804), (1_234_567_890, 5_924), (2_000_000_000, 279_037)] {
            assert_eq!(code_at(key, time / STEP_SECONDS), expected, "t = {time}");
        }
        let secret = base32_encode(key);
        assert_eq!(base32_decode(&secret).as_deref(), Some(&key[..]));
        assert_eq!(matching_step(&secret, "287082", 59), Some(1));
        assert_eq!(matching_step(&secret, "287082", 59 + 30), Some(1), "one step late is accepted");
        assert_eq!(matching_step(&secret, "287082", 59 + 90), None);
        assert_eq!(matching_step(&secret, "28708", 59), None);
    }

    #[test]
    fn base32_round_trip() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base32_decode(&base32_encode(bytes)).as_deref(), Some(bytes));
        }
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
        assert!(base32_decode("not base32!").is_none());
        // spaces and lowercase are accepted; 80 bits is the minimum
        let canonical = base32_encode(b"0123456789");
        let spaced: String =
            canonical.to_lowercase().chars().collect::<Vec<_>>().chunks(4).map(|chunk| chunk.iter().collect::<String>()).collect::<Vec<_>>().join(" ");
        assert_eq!(normalize_secret(&spaced), Some(canonical));
        assert!(normalize_secret(&base32_encode(b"01234")).is_none(), "too short");
    }
}
