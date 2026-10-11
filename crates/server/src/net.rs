//! The address a request came from, for per-client limits.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::extract::ConnectInfo;
use axum::http::{Extensions, HeaderMap};

/// The peer address (`ConnectInfo`), or with `trust_proxy` the last `X-Forwarded-For` entry, which is the one the nearest
/// proxy appended. Without connection info (in-process requests) every caller shares the loopback address.
pub fn client_ip(extensions: &Extensions, headers: &HeaderMap, trust_proxy: bool) -> IpAddr {
    if trust_proxy
        && let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .and_then(|entry| entry.trim().parse().ok())
    {
        return ip;
    }
    extensions.get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_for_only_counts_when_trusted() {
        let mut extensions = Extensions::new();
        extensions.insert(ConnectInfo(SocketAddr::from(([10, 1, 1, 1], 4000))));
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "6.6.6.6, 203.0.113.9".parse().expect("header"));
        assert_eq!(client_ip(&extensions, &headers, false), IpAddr::from([10, 1, 1, 1]));
        assert_eq!(client_ip(&extensions, &headers, true), IpAddr::from([203, 0, 113, 9]));
        assert_eq!(client_ip(&Extensions::new(), &HeaderMap::new(), true), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
}
