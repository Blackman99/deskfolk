//! What every window's app starts with, on every desktop: the launch parameters (`host.params`:
//! the runtime's address and token, and the first window's development checks) and the host
//! functions all shells answer the same way.

use nsh_engine::{HostCall, HostChannel};
use serde_json::{Map, Value, json};

use crate::config::Config;

pub fn params(config: &Config, window_id: u32) -> Map<String, Value> {
    let mut params = Map::new();
    params.insert("origin".into(), config.endpoint.origin.clone().into());
    params.insert("token".into(), config.endpoint.token.clone().into());
    params.insert("windowId".into(), window_id.into());
    params.insert("material".into(), if cfg!(target_os = "macos") { "glass" } else { "none" }.into());
    if window_id == 1 {
        let mut set = |name: &str, value: Option<&String>| {
            if let Some(value) = value {
                params.insert(name.into(), value.clone().into());
            }
        };
        set("openSession", config.open_session.as_ref());
        set("pane", config.pane.as_ref());
        set("pdfPath", config.pdf.as_ref());
        set("terminal", config.terminal.as_ref());
        if config.scroll_probe {
            params.insert("scrollProbe".into(), true.into());
        }
    }
    params
}

/// A window's channel: its launch parameters and the host functions every desktop answers.
pub fn channel(config: &Config, window_id: u32) -> HostChannel {
    let host = HostChannel::new();
    host.set_params(params(config, window_id));
    let endpoint = json!({ "origin": config.endpoint.origin, "token": config.endpoint.token });
    {
        let endpoint = endpoint.clone();
        host.handle("runtime.endpoint", move |call: HostCall| call.resolve(endpoint.clone()));
    }
    // The messenger's Tauri commands (`app/src/platform/tauri-bridge.ts`), by their Tauri names.
    host.handle("tauri.local_api_endpoint", move |call: HostCall| call.resolve(endpoint.clone()));
    host.handle("tauri.app_version", |call: HostCall| call.resolve(json!(env!("CARGO_PKG_VERSION"))));
    host.handle("tauri.window_material", |call: HostCall| {
        call.resolve(json!(if cfg!(target_os = "macos") { "glass" } else { "none" }))
    });
    host
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::Endpoint;

    fn config() -> Config {
        Config {
            bundle: "bundle.js".into(),
            data_dir: "/tmp/dev".into(),
            endpoint: Endpoint { origin: "http://127.0.0.1:17990".into(), port: 17990, token: "t".into() },
            app_name: "Deskfolk Dev".into(),
            bundle_id: "com.real-bot.desktop.nsh-dev".into(),
            watch: false,
            background: false,
            snapshots: None,
            open_session: Some("s1".into()),
            pane: None,
            pdf: None,
            fps: false,
            scroll_probe: false,
            terminal: None,
        }
    }

    #[test]
    fn the_first_window_carries_the_checks_and_every_window_the_runtime() {
        let first = params(&config(), 1);
        assert_eq!(first["origin"], "http://127.0.0.1:17990");
        assert_eq!(first["openSession"], "s1");
        let second = params(&config(), 2);
        assert_eq!(second["token"], "t");
        assert!(second.get("openSession").is_none());
    }
}
