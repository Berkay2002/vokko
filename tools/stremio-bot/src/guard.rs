//! The bot's own check of where ffmpeg may connect. The server already vetted the link when it resolved it; this is the second
//! wall, mirroring the server's `unfurl::is_public_ip`. Gap: ffmpeg looks the name up again when it connects, so a host that
//! answers differently the second time (DNS rebinding) is not caught; closing that needs the connection pinned to the checked
//! address (a local proxy), which ffmpeg cannot do by itself.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() || s[..6].iter().all(|segment| *segment == 0) {
        return false;
    }
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|segment| *segment == 0) {
        return public_v4(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return public_v4(embedded(s[1], s[2]));
    }
    let first = s[0];
    !((first & 0xfe00) == 0xfc00 // unique local
        || (first & 0xffc0) == 0xfe80 // link local
        || (first & 0xffc0) == 0xfec0 // site local
        || (first & 0xff00) == 0xff00 // multicast
        || (first == 0x2001 && (s[1] == 0x0db8 || s[1] == 0)) // documentation, Teredo
        || (first == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0)) // discard-only
}

/// An IP literal that is public, or a name that is not obviously local. Names are resolved in `resolves_public`.
pub fn host_ok(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_public_ip(ip);
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    name != "localhost" && !name.ends_with(".localhost") && !name.ends_with(".local") && !name.ends_with(".internal")
}

/// Resolves the media host and refuses it when it has no address or any address is not public.
pub async fn resolves_public(media_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(media_url).map_err(|_| "media_url is not a URL".to_owned())?;
    if !host_ok(&url) {
        return Err("media host is not public".into());
    }
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| "media host does not resolve".to_owned())?.collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("media host resolves to a non-public address".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses_pass() {
        for private in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "::10.0.0.1",
            "::ffff:192.168.0.1",
            "64:ff9b::a00:1",
            "2002:c0a8:1::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(private.parse().expect("ip")), "{private}");
        }
        for public in ["8.8.8.8", "1.1.1.1", "2606:4700::1", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(is_public_ip(public.parse().expect("ip")), "{public}");
        }
    }

    #[tokio::test]
    async fn names_are_resolved_and_checked() {
        assert!(resolves_public("https://localhost/v").await.is_err());
        assert!(resolves_public("https://nas.local/v").await.is_err());
        assert!(resolves_public("https://192.168.0.1/v").await.is_err());
        assert!(resolves_public("https://8.8.8.8/v").await.is_ok());
        assert!(resolves_public("https://nonexistent.invalid/v").await.is_err());
    }
}
