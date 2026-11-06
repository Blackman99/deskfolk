//! The independent runtime's status and operations, answered as the Tauri app does today
//! (`apps/desktop/src-tauri/src/lib.rs` `independent_runtime_status`, `independent_runtime`,
//! `snapshot_independent_status`, `independent_runtime_op`, `recover_stale_independent_marker`,
//! `restore_window_supervision_unless_adopted`; `handoff.rs` `status`; `launchd.rs`
//! `IndependentPolicy`, `adopt_independent_marker`, `agent_loaded_in_gui_domain`).
//!
//! The policy is fail-closed in the Tauri app and stays so: `enable`, `wait` and `force` are
//! refused with a reason, so the mutating half of `handoff.rs` (drain, plist, `launchctl
//! bootstrap`) has no caller there and is not copied. What differs from Tauri is whose files it
//! names: this shell's own data directory (`real-bot-nsh-dev`), its runtime's port (17990, probed
//! with `runtime::healthy`, which refuses 17890) and its own launchd label, never the stable
//! app's `com.real-bot.runtime`.
//!
//! `independent_runtime` (the operations) takes the Tauri app's `BundledNativeCaller`, which
//! refuses a development build with `disabled`; `independent_runtime_status` has no such guard.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::dev_build::Identity;

/// Stable app: `com.real-bot.runtime`. This shell's agent would be its own job.
pub const LABEL: &str = "com.real-bot.runtime.nsh-dev";
pub const MARKER_NAME: &str = "runtime.independent";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub available: bool,
    pub diagnostic: String,
}

impl Policy {
    /// Fail-closed until a sealed runtime (G-pack) exists. Dev never installs.
    pub fn production(dev: bool) -> Self {
        Self { available: false, diagnostic: if dev { "dev_does_not_install_agent" } else { "g_pack_not_verified" }.into() }
    }
}

pub fn refuse_unqualified_enable(policy: &Policy) -> Result<(), String> {
    if policy.available { Ok(()) } else { Err(policy.diagnostic.clone()) }
}

/// Who writes the runtime's data right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writer {
    Window,
    Agent,
    Down,
}

impl Writer {
    fn label(self) -> &'static str {
        match self {
            Writer::Window => "window",
            Writer::Agent => "agent",
            Writer::Down => "down",
        }
    }
}

pub fn writer_from_probe(ours: bool, supervising: bool, marker: bool) -> Writer {
    match ours {
        true if supervising => Writer::Window,
        true if marker => Writer::Agent,
        _ => Writer::Down,
    }
}

pub fn marker_present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).ok().is_some_and(|meta| meta.is_file())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Honor `runtime.independent` only when policy is available and this window bootstrapped or
/// launchd shows the agent loaded. Never adopts a PID.
pub fn adopt_marker(policy: &Policy, marker: &Path, bootstrapped: bool, agent_loaded: bool) -> bool {
    policy.available && marker_present(marker) && (bootstrapped || agent_loaded)
}

/// Read-only `launchctl print` output: is the job loaded and not merely listed as not running?
pub fn parse_launchctl_print_loaded(stdout: &str, label: &str) -> bool {
    let needle = format!("\"{label}\"");
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.contains("not exist") || trimmed.contains("Could not find") {
            return false;
        }
        if trimmed.contains(&needle) || trimmed.contains(label) {
            if trimmed.contains("state = not running") {
                continue;
            }
            return true;
        }
    }
    false
}

fn agent_loaded_in_gui_domain() -> bool {
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let output = std::process::Command::new("launchctl").args(["print", &format!("{domain}/{LABEL}")]).output();
    match output {
        Ok(output) if output.status.success() => {
            parse_launchctl_print_loaded(&String::from_utf8_lossy(&output.stdout), LABEL)
                || parse_launchctl_print_loaded(&String::from_utf8_lossy(&output.stderr), LABEL)
        }
        _ => false,
    }
}

/// The window-supervision half of the Tauri `AppState`.
#[derive(Debug)]
pub struct Supervision {
    supervising: bool,
    bootstrapped: bool,
}

static SUPERVISION: Mutex<Supervision> = Mutex::new(Supervision { supervising: true, bootstrapped: false });

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub enabled: bool,
    pub available: bool,
    pub diagnostic: String,
    pub supervising: bool,
    pub writer: String,
    pub drain: DrainDto,
    pub error: Option<String>,
    pub warning: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrainDto {
    pub phase: String,
    pub remaining: Vec<String>,
    pub forced: bool,
}

#[derive(Deserialize)]
pub struct Request {
    pub operation: String,
}

/// What the status reads from outside the process, injectable for tests.
pub struct World<'a> {
    pub policy: Policy,
    pub data_dir: &'a Path,
    /// A runtime of ours answers on this shell's port.
    pub runtime_ours: bool,
    state: &'a Mutex<Supervision>,
}

impl<'a> World<'a> {
    fn of(id: &'a Identity) -> Self {
        Self {
            policy: Policy::production(id.is_dev()),
            data_dir: &id.data_dir,
            runtime_ours: crate::runtime::healthy(id.port),
            state: &SUPERVISION,
        }
    }

    fn marker(&self) -> std::path::PathBuf {
        self.data_dir.join(MARKER_NAME)
    }
}

fn snapshot(world: &World, error: Option<String>, warning: Option<String>) -> StatusDto {
    let supervising = world.state.lock().map(|s| s.supervising).unwrap_or(true);
    let marker = marker_present(&world.marker());
    StatusDto {
        enabled: marker && !supervising,
        available: world.policy.available,
        diagnostic: world.policy.diagnostic.clone(),
        supervising,
        writer: writer_from_probe(world.runtime_ours, supervising, marker).label().into(),
        drain: DrainDto { phase: "running".into(), remaining: Vec::new(), forced: false },
        error,
        warning,
    }
}

fn adopted(world: &World) -> bool {
    let bootstrapped = world.state.lock().map(|s| s.bootstrapped).unwrap_or(false);
    let agent_loaded = world.policy.available && agent_loaded_in_gui_domain();
    adopt_marker(&world.policy, &world.marker(), bootstrapped, agent_loaded)
}

fn recover_stale_marker(world: &World) {
    if adopted(world) {
        return;
    }
    if let Ok(mut state) = world.state.lock() {
        state.supervising = true;
        state.bootstrapped = false;
    }
    let _ = remove_file_if_exists(&world.marker());
    let _ = remove_file_if_exists(&world.data_dir.join(format!("{LABEL}.plist")));
}

fn restore_window_supervision_unless_adopted(world: &World) {
    if adopted(world) {
        return;
    }
    if let Ok(mut state) = world.state.lock() {
        state.supervising = true;
    }
}

pub fn operate(world: &World, request: &Request) -> Result<StatusDto, String> {
    match request.operation.as_str() {
        "enable" | "wait" | "force" => {
            let reason = refuse_unqualified_enable(&world.policy).err().unwrap_or_else(|| "g_pack_not_verified".into());
            Ok(snapshot(world, Some(reason), None))
        }
        "disable" => {
            recover_stale_marker(world);
            let reason = refuse_unqualified_enable(&world.policy).err().unwrap_or_else(|| "g_pack_not_verified".into());
            Ok(snapshot(world, Some(reason), None))
        }
        "cancel" => {
            restore_window_supervision_unless_adopted(world);
            Ok(snapshot(world, None, None))
        }
        _ => Err("malformed".into()),
    }
}

/// `independent_runtime_status`: no guard, a dev build reports `dev_does_not_install_agent`.
pub fn status(id: &Identity) -> StatusDto {
    snapshot(&World::of(id), None, None)
}

/// `independent_runtime { request }`: refused as `disabled` in a development build, like every
/// command the Tauri app guards with `BundledNativeCaller`.
pub fn run(id: &Identity, request: &Request) -> Result<StatusDto, String> {
    if id.is_dev() {
        return Err("disabled".into());
    }
    operate(&World::of(id), request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh() -> &'static Mutex<Supervision> {
        Box::leak(Box::new(Mutex::new(Supervision { supervising: true, bootstrapped: false })))
    }

    fn world<'a>(dir: &'a Path, dev: bool, ours: bool) -> World<'a> {
        World { policy: Policy::production(dev), data_dir: dir, runtime_ours: ours, state: fresh() }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("deskfolk-nsh-independent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn op(name: &str) -> Request {
        Request { operation: name.into() }
    }

    #[test]
    fn the_policy_never_opens() {
        assert_eq!(Policy::production(true).diagnostic, "dev_does_not_install_agent");
        assert_eq!(Policy::production(false).diagnostic, "g_pack_not_verified");
        assert!(!Policy::production(true).available && !Policy::production(false).available);
    }

    #[test]
    fn the_status_reaches_the_card_in_the_shape_tauri_sends() {
        let dir = temp("shape");
        let value = serde_json::to_value(snapshot(&world(&dir, true, true), None, None)).unwrap();
        assert_eq!(
            value,
            json!({
                "enabled": false, "available": false, "diagnostic": "dev_does_not_install_agent",
                "supervising": true, "writer": "window",
                "drain": { "phase": "running", "remaining": [], "forced": false },
                "error": null, "warning": null,
            })
        );
    }

    #[test]
    fn enable_wait_and_force_are_refused_with_the_reason() {
        let dir = temp("refuse");
        for name in ["enable", "wait", "force"] {
            let got = operate(&world(&dir, true, false), &op(name)).unwrap();
            assert_eq!(got.error.as_deref(), Some("dev_does_not_install_agent"));
            assert!(!got.enabled);
        }
        let packaged = operate(&world(&dir, false, false), &op("enable")).unwrap();
        assert_eq!(packaged.error.as_deref(), Some("g_pack_not_verified"));
    }

    #[test]
    fn an_unknown_operation_is_malformed() {
        let dir = temp("malformed");
        assert_eq!(operate(&world(&dir, true, false), &op("explode")), Err("malformed".to_string()));
    }

    #[test]
    fn disable_recovers_a_stale_marker_and_cancel_restores_supervision() {
        let dir = temp("stale");
        let marker = dir.join(MARKER_NAME);
        let plist = dir.join(format!("{LABEL}.plist"));
        std::fs::write(&marker, "").unwrap();
        std::fs::write(&plist, "").unwrap();
        let w = world(&dir, true, true);
        w.state.lock().unwrap().supervising = false;
        // A leftover marker is not adopted (policy closed): the status shows it, `disable` clears it.
        let got = operate(&w, &op("disable")).unwrap();
        assert!(!marker.exists() && !plist.exists());
        assert!(got.supervising && !got.enabled);
        assert_eq!(got.error.as_deref(), Some("dev_does_not_install_agent"));
        w.state.lock().unwrap().supervising = false;
        let got = operate(&w, &op("cancel")).unwrap();
        assert!(got.supervising);
        assert_eq!(got.error, None);
    }

    #[test]
    fn a_dev_build_refuses_the_operations_but_not_the_status() {
        let id = Identity { bundle_id: "com.real-bot.desktop.nsh-dev".into(), data_dir: temp("gate"), port: 17990, version: "0.4.0" };
        assert_eq!(run(&id, &op("cancel")), Err("disabled".to_string()));
        assert_eq!(status(&id).diagnostic, "dev_does_not_install_agent");
    }

    #[test]
    fn writer_follows_the_probe_and_the_marker() {
        assert_eq!(writer_from_probe(true, true, false), Writer::Window);
        assert_eq!(writer_from_probe(true, false, true), Writer::Agent);
        assert_eq!(writer_from_probe(true, false, false), Writer::Down);
        assert_eq!(writer_from_probe(false, true, true), Writer::Down);
    }

    #[test]
    fn launchctl_print_output_is_read_for_a_loaded_job() {
        assert!(parse_launchctl_print_loaded("gui/501/com.real-bot.runtime.nsh-dev = {\n state = running", LABEL));
        assert!(!parse_launchctl_print_loaded("Could not find service \"com.real-bot.runtime.nsh-dev\"", LABEL));
    }
}
