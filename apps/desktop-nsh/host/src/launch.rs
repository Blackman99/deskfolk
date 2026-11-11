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
    params.insert("material".into(), material().into());
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
        set("story", config.story.as_ref());
        if config.scroll_probe {
            params.insert("scrollProbe".into(), true.into());
        }
    }
    params
}

/// What is behind the app (`ui/glass.ts`): the sidebar material on macOS (`window.rs`), Mica on
/// Windows 11 22H2 and later (`win.rs`), nothing elsewhere.
fn material() -> &'static str {
    #[cfg(target_os = "macos")]
    let glass = true;
    #[cfg(windows)]
    let glass = crate::win::has_material();
    #[cfg(not(any(target_os = "macos", windows)))]
    let glass = false;
    if glass { "glass" } else { "none" }
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
    host.handle("tauri.app_version", |call: HostCall| call.resolve(json!(crate::config::product_version())));
    host.handle("tauri.window_material", |call: HostCall| call.resolve(json!(material())));
    install_portable(&host);
    host
}

/// The update check answers the same on every desktop (`updates::check`, on a thread of its own:
/// it waits on the network). The rest of the update and system commands are the macOS shell's
/// (`host_calls.rs`); the other desktops answer what the Tauri app answers for a copy that cannot
/// install or register anything: launch-at-login off, no in-app install, no independent runtime
/// and no remote pairing.
fn install_portable(host: &HostChannel) {
    host.handle("tauri.check_for_update", |call: HostCall| {
        let force = call.data()["force"].as_bool().unwrap_or(false);
        std::thread::spawn(move || match crate::updates::check(crate::config::product_version(), force) {
            Ok(check) => call.resolve(json!(check)),
            Err(why) => call.reject(why),
        });
    });
    #[cfg(not(target_os = "macos"))]
    {
        host.handle("tauri.set_launch_at_login", |call: HostCall| call.resolve(json!(false)));
        host.handle("tauri.can_install_update", |call: HostCall| call.resolve(json!(false)));
        host.handle("tauri.update_install_state", |call: HostCall| call.resolve(idle_install_state()));
        host.handle("tauri.cancel_update_install", |call: HostCall| call.resolve(idle_install_state()));
        host.handle("tauri.start_update_install", |call: HostCall| call.reject("not-installed"));
        for name in ["independent_runtime", "remote_local_setup", "remote_native_confirmation"] {
            host.handle(format!("tauri.{name}"), |call: HostCall| call.reject("disabled"));
        }
        host.handle("tauri.independent_runtime_status", |call: HostCall| {
            call.resolve(json!({
                "enabled": false, "available": false, "diagnostic": "dev_does_not_install_agent",
                "supervising": true, "writer": "down",
                "drain": { "phase": "running", "remaining": [], "forced": false },
                "error": null, "warning": null,
            }))
        });
    }
}

/// `installer::InstallState::idle()` as the card reads it.
#[cfg(not(target_os = "macos"))]
fn idle_install_state() -> Value {
    json!({ "phase": "idle", "downloaded": 0, "total": null, "version": null, "error": null, "detail": null })
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
            story: None,
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
