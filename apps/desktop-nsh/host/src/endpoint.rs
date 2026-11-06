//! Where the runtime this window talks to listens, read from the descriptor the daemon writes in
//! its data directory (`local-api.json`). The dev build reads its own data directory only and
//! refuses the stable instance's port: it never falls back to whatever answers on 17890.

use std::path::{Path, PathBuf};

/// The stable instance's port (`LOCAL_API_PORT` in `@real-bot/protocol`).
pub const STABLE_PORT: u16 = 17890;
pub const DESCRIPTOR_NAME: &str = "local-api.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub origin: String,
    pub port: u16,
    pub token: String,
}

#[derive(serde::Deserialize)]
struct Descriptor {
    port: u16,
    token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EndpointError {
    Missing(PathBuf),
    Unreadable(String),
    StablePort,
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EndpointError::Missing(path) => write!(f, "no runtime descriptor at {}", path.display()),
            EndpointError::Unreadable(why) => write!(f, "unreadable runtime descriptor: {why}"),
            EndpointError::StablePort => {
                write!(f, "the descriptor names the stable port {STABLE_PORT}; the dev build does not connect there")
            }
        }
    }
}

pub fn parse(text: &str) -> Result<Endpoint, EndpointError> {
    let descriptor: Descriptor =
        serde_json::from_str(text).map_err(|error| EndpointError::Unreadable(error.to_string()))?;
    if descriptor.port == STABLE_PORT {
        return Err(EndpointError::StablePort);
    }
    if descriptor.token.is_empty() {
        return Err(EndpointError::Unreadable("empty token".into()));
    }
    Ok(Endpoint {
        origin: format!("http://127.0.0.1:{}", descriptor.port),
        port: descriptor.port,
        token: descriptor.token,
    })
}

pub fn read(data_dir: &Path) -> Result<Endpoint, EndpointError> {
    let path = data_dir.join(DESCRIPTOR_NAME);
    let text = std::fs::read_to_string(&path).map_err(|_| EndpointError::Missing(path))?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_dev_port_and_token() {
        let ep = parse(r#"{"pid":12,"port":17990,"token":"abc","started_at":"2026-11-06T00:00:00.000Z"}"#).unwrap();
        assert_eq!(ep.origin, "http://127.0.0.1:17990");
        assert_eq!(ep.port, 17990);
        assert_eq!(ep.token, "abc");
    }

    #[test]
    fn never_connects_to_the_stable_port() {
        let got = parse(r#"{"pid":12,"port":17890,"token":"abc"}"#);
        assert_eq!(got, Err(EndpointError::StablePort));
    }

    #[test]
    fn a_missing_descriptor_is_an_error_not_a_fallback() {
        let dir = std::env::temp_dir().join("deskfolk-nsh-endpoint-test-missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(read(&dir), Err(EndpointError::Missing(_))));
    }
}
