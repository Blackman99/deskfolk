//! Independent-runtime handoff. Caller owns exit; quiesce never exits.
//!
//! Enable: drain → supervising=false → no-latch exit → port empty → bootstrap.
//! Disable with a window: supervising=true → bootout (no latch) → window Spawn.
//! Disable without a window: warn, latch+stop+bootout. Bootstrap failure stays Down.

use std::path::PathBuf;
use std::time::Duration;

use crate::launchd::{
    adopt_independent_marker, gui_domain, independent_marker_present, keep_alive_after_exit,
    remove_file_if_exists, write_agent_plist, write_marker, AgentPaths, IndependentPolicy,
    Launchctl, LABEL,
};
use crate::supervisor::{Probe, Supervisor};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainPhase {
    Running,
    Draining,
    Drained,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrainState {
    pub phase: DrainPhase,
    pub remaining: Vec<String>,
    pub forced: bool,
}

pub trait DrainControl {
    fn begin(&mut self) -> DrainState;
    fn state(&self) -> DrainState;
    fn wait(&mut self) -> DrainState;
    fn cancel(&mut self) -> DrainState;
    fn force(&mut self) -> DrainState;
}

pub trait RuntimeExit {
    fn no_latch_exit(&mut self) -> Result<(), String>;
    fn latch_then_exit(&mut self) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writer {
    Window,
    Agent,
    Down,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandoffStatus {
    pub enabled: bool,
    pub available: bool,
    pub diagnostic: String,
    pub supervising: bool,
    pub drain: DrainState,
    pub writer: Writer,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnableRequest {
    Begin,
    Wait,
    Force,
    Cancel,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnableOutcome {
    Waiting(DrainState),
    Bootstrapped,
    Cancelled(DrainState),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisableOutcome {
    WindowSpawn,
    StoppedWithoutWindow { warning: String },
    Failed(String),
}

pub const WINDOW_ABSENT_DISABLE_WARNING: &str =
    "desktop_absent_disable_stops_runtime";

pub fn production_policy(dev: bool) -> IndependentPolicy {
    IndependentPolicy::production(dev)
}

pub fn refuse_unqualified_enable(policy: &IndependentPolicy) -> Result<(), String> {
    if policy.available {
        Ok(())
    } else {
        Err(policy.diagnostic.clone())
    }
}

/// Quiesce → stop spawn → no-latch exit → wait for Down → bootstrap a new child.
/// Never adopts the previous PID. Failure leaves supervising=false (explicit Down).
pub fn enable_independent<L: Launchctl, D: DrainControl, E: RuntimeExit>(
    supervisor: &mut Supervisor,
    drain: &mut D,
    exit: &mut E,
    launchctl: &mut L,
    paths: &AgentPaths,
    policy: &IndependentPolicy,
    request: EnableRequest,
    probe: impl FnMut() -> Probe,
) -> EnableOutcome {
    if let Err(reason) = refuse_unqualified_enable(policy) {
        return EnableOutcome::Failed(reason);
    }
    match request {
        EnableRequest::Cancel => {
            supervisor.set_supervising(true);
            return EnableOutcome::Cancelled(drain.cancel());
        }
        EnableRequest::Begin => {
            let state = drain.begin();
            if state.phase != DrainPhase::Drained {
                return EnableOutcome::Waiting(state);
            }
        }
        EnableRequest::Wait => {
            let _ = drain.state();
            let state = drain.wait();
            if state.phase != DrainPhase::Drained {
                return EnableOutcome::Waiting(state);
            }
        }
        EnableRequest::Force => {
            let state = drain.force();
            if state.phase != DrainPhase::Drained {
                return EnableOutcome::Waiting(state);
            }
        }
    }
    finish_enable(supervisor, exit, launchctl, paths, probe, pause_for_down)
}

fn finish_enable<L: Launchctl, E: RuntimeExit>(
    supervisor: &mut Supervisor,
    exit: &mut E,
    launchctl: &mut L,
    paths: &AgentPaths,
    mut probe: impl FnMut() -> Probe,
    pause: impl FnMut(),
) -> EnableOutcome {
    supervisor.set_supervising(false);
    if let Err(err) = exit.no_latch_exit() {
        return EnableOutcome::Failed(err);
    }
    if !wait_for_down(&mut probe, pause) {
        return EnableOutcome::Failed("port_not_empty".into());
    }
    if let Err(err) = write_agent_plist(paths) {
        return EnableOutcome::Failed(err);
    }
    match launchctl.bootstrap(&gui_domain(), &paths.plist) {
        Ok(()) => {
            if let Err(err) = write_marker(&paths.marker) {
                return EnableOutcome::Failed(err);
            }
            EnableOutcome::Bootstrapped
        }
        Err(err) => EnableOutcome::Failed(err),
    }
}

/// Window present: supervising=true first, then bootout without writing the latch.
pub fn disable_independent_with_window<L: Launchctl>(
    supervisor: &mut Supervisor,
    launchctl: &mut L,
    paths: &AgentPaths,
    mut probe: impl FnMut() -> Probe,
) -> DisableOutcome {
    supervisor.set_supervising(true);
    if let Err(err) = launchctl.bootout(&gui_domain(), LABEL) {
        return DisableOutcome::Failed(err);
    }
    let _ = remove_file_if_exists(&paths.marker);
    let _ = remove_file_if_exists(&paths.plist);
    if probe() == Probe::Ours {
        return DisableOutcome::WindowSpawn;
    }
    DisableOutcome::WindowSpawn
}

/// Window absent: warn, latch+stop+bootout so the agent cannot orphan a writer.
pub fn disable_independent_without_window<L: Launchctl, E: RuntimeExit>(
    launchctl: &mut L,
    exit: &mut E,
    paths: &AgentPaths,
) -> DisableOutcome {
    if let Err(err) = exit.latch_then_exit() {
        return DisableOutcome::Failed(err);
    }
    if let Err(err) = launchctl.bootout(&gui_domain(), LABEL) {
        return DisableOutcome::Failed(err);
    }
    let _ = remove_file_if_exists(&paths.marker);
    let _ = remove_file_if_exists(&paths.plist);
    DisableOutcome::StoppedWithoutWindow {
        warning: WINDOW_ABSENT_DISABLE_WARNING.into(),
    }
}

pub const DOWN_WAIT_ATTEMPTS: u32 = 40;
pub const DOWN_WAIT_PAUSE: Duration = Duration::from_millis(50);

pub fn pause_for_down() {
    std::thread::sleep(DOWN_WAIT_PAUSE);
}

pub fn wait_for_down(probe: &mut impl FnMut() -> Probe, mut pause: impl FnMut()) -> bool {
    if probe() == Probe::Down {
        return true;
    }
    for _ in 0..DOWN_WAIT_ATTEMPTS {
        pause();
        if probe() == Probe::Down {
            return true;
        }
    }
    false
}

/// Ignore a leftover/planted marker unless policy is available and a job is
/// actually loaded (or this window bootstrapped). Do not adopt a live PID.
pub fn restore_independent_mode(
    supervisor: &mut Supervisor,
    policy: &IndependentPolicy,
    marker: &std::path::Path,
    this_window_bootstrapped: bool,
    agent_loaded: bool,
) -> bool {
    let adopt = adopt_independent_marker(policy, marker, this_window_bootstrapped, agent_loaded);
    if adopt {
        supervisor.set_supervising(false);
    }
    adopt
}

/// Gated disable/recovery still deletes a stale marker and restores window Spawn.
pub fn recover_stale_independent_marker<L: Launchctl>(
    supervisor: &mut Supervisor,
    launchctl: &mut L,
    paths: &AgentPaths,
    policy: &IndependentPolicy,
    this_window_bootstrapped: bool,
    agent_loaded: bool,
) -> bool {
    if adopt_independent_marker(policy, &paths.marker, this_window_bootstrapped, agent_loaded) {
        return false;
    }
    if !independent_marker_present(&paths.marker) {
        return false;
    }
    supervisor.set_supervising(true);
    let _ = launchctl.bootout(&gui_domain(), LABEL);
    let _ = remove_file_if_exists(&paths.marker);
    let _ = remove_file_if_exists(&paths.plist);
    true
}

pub fn writer_from_probe(probe: Probe, supervising: bool, marker: bool) -> Writer {
    match probe {
        Probe::Ours if supervising => Writer::Window,
        Probe::Ours if marker => Writer::Agent,
        _ => Writer::Down,
    }
}

pub fn status(
    supervisor: &Supervisor,
    drain: DrainState,
    policy: &IndependentPolicy,
    probe: Probe,
    marker: PathBuf,
    error: Option<String>,
) -> HandoffStatus {
    let supervising = supervisor.is_supervising();
    let marker = independent_marker_present(&marker);
    HandoffStatus {
        enabled: marker && !supervising,
        available: policy.available,
        diagnostic: policy.diagnostic.clone(),
        supervising,
        drain,
        writer: writer_from_probe(probe, supervising, marker),
        error,
    }
}

pub fn stop_stays_stopped(latch_exists: bool, elapsed: Duration) -> bool {
    elapsed.as_secs() <= u64::MAX && !keep_alive_after_exit(latch_exists)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launchd::FakeLaunchctl;
    use crate::supervisor::{Action, Endpoint};
    use std::cell::Cell;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    struct ScriptedDrain {
        remaining: Vec<String>,
        forced: bool,
        phase: DrainPhase,
        began: bool,
        cancelled: bool,
        forced_count: usize,
        wait_count: usize,
    }

    impl ScriptedDrain {
        fn live(ids: &[&str]) -> Self {
            Self {
                remaining: ids.iter().map(|id| (*id).to_string()).collect(),
                forced: false,
                phase: DrainPhase::Running,
                began: false,
                cancelled: false,
                forced_count: 0,
                wait_count: 0,
            }
        }
        fn snapshot(&self) -> DrainState {
            DrainState {
                phase: self.phase,
                remaining: self.remaining.clone(),
                forced: self.forced,
            }
        }
    }

    impl DrainControl for ScriptedDrain {
        fn begin(&mut self) -> DrainState {
            self.began = true;
            self.phase = if self.remaining.is_empty() {
                DrainPhase::Drained
            } else {
                DrainPhase::Draining
            };
            self.snapshot()
        }
        fn state(&self) -> DrainState {
            self.snapshot()
        }
        fn wait(&mut self) -> DrainState {
            self.wait_count += 1;
            self.begin();
            self.snapshot()
        }
        fn cancel(&mut self) -> DrainState {
            self.cancelled = true;
            self.phase = DrainPhase::Running;
            self.forced = false;
            self.snapshot()
        }
        fn force(&mut self) -> DrainState {
            self.forced_count += 1;
            self.forced = true;
            self.remaining.clear();
            self.phase = DrainPhase::Drained;
            self.snapshot()
        }
    }

    #[derive(Default)]
    struct ScriptedExit {
        no_latch: usize,
        latch: usize,
        fail_no_latch: bool,
    }

    impl RuntimeExit for ScriptedExit {
        fn no_latch_exit(&mut self) -> Result<(), String> {
            if self.fail_no_latch {
                return Err("exit failed".into());
            }
            self.no_latch += 1;
            Ok(())
        }
        fn latch_then_exit(&mut self) -> Result<(), String> {
            self.latch += 1;
            Ok(())
        }
    }

    fn temp_paths() -> (std::path::PathBuf, AgentPaths) {
        let n = UNIQUE.fetch_add(1, Ordering::SeqCst);
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("independent-runtime-tests")
            .join(format!("handoff-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let program = dir.join("real-bot-daemon");
        fs::write(&program, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let paths = AgentPaths::for_data_dir(program, dir.clone(), dir.join("com.real-bot.runtime.plist"));
        (dir, paths)
    }

    fn open_policy() -> IndependentPolicy {
        IndependentPolicy {
            available: true,
            diagnostic: "test_seam".into(),
        }
    }

    #[test]
    fn wait_request_keeps_supervising_while_turns_remain() {
        let mut supervisor = Supervisor::new();
        let mut drain = ScriptedDrain::live(&["turn-1"]);
        drain.begin();
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Wait,
            || Probe::Ours,
        );
        assert!(matches!(outcome, EnableOutcome::Waiting(_)));
        assert_eq!(drain.wait_count, 1);
        assert!(supervisor.is_supervising());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn live_turn_waits_before_exit_and_bootstrap() {
        let mut supervisor = Supervisor::new();
        supervisor.remember(Endpoint::new(17890, "tok"));
        let mut drain = ScriptedDrain::live(&["turn-1"]);
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Begin,
            || Probe::Ours,
        );
        assert_eq!(
            outcome,
            EnableOutcome::Waiting(DrainState {
                phase: DrainPhase::Draining,
                remaining: vec!["turn-1".into()],
                forced: false,
            })
        );
        assert!(supervisor.is_supervising());
        assert_eq!(exit.no_latch, 0);
        assert!(launch.bootstraps.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explicit_force_then_handoff() {
        let mut supervisor = Supervisor::new();
        let mut drain = ScriptedDrain::live(&["turn-1"]);
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let mut probes = vec![Probe::Ours, Probe::Down].into_iter();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Force,
            || probes.next().unwrap_or(Probe::Down),
        );
        assert_eq!(outcome, EnableOutcome::Bootstrapped);
        assert_eq!(drain.forced_count, 1);
        assert!(!supervisor.is_supervising());
        assert_eq!(exit.no_latch, 1);
        assert_eq!(exit.latch, 0);
        assert_eq!(launch.bootstraps, vec![paths.plist.clone()]);
        assert!(paths.marker.is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn handoff_sequence_is_quiesce_stop_spawn_no_latch_exit_bootstrap() {
        let mut supervisor = Supervisor::new();
        supervisor.remember(Endpoint::new(17890, "tok"));
        let mut drain = ScriptedDrain::live(&[]);
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let mut probes = vec![Probe::Ours, Probe::Down].into_iter();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Begin,
            || probes.next().unwrap_or(Probe::Down),
        );
        assert_eq!(outcome, EnableOutcome::Bootstrapped);
        assert!(drain.began);
        assert!(!supervisor.is_supervising());
        assert_eq!(exit.no_latch, 1);
        assert_eq!(launch.bootstraps.len(), 1);
        assert_eq!(supervisor.on_probe(Probe::Down, false), Action::Idle);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bootstrap_failure_stays_down_and_does_not_restore_window_spawn() {
        let mut supervisor = Supervisor::new();
        let mut drain = ScriptedDrain::live(&[]);
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl {
            fail_bootstrap: true,
            ..FakeLaunchctl::default()
        };
        let (dir, paths) = temp_paths();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Begin,
            || Probe::Down,
        );
        assert!(matches!(outcome, EnableOutcome::Failed(_)));
        assert!(!supervisor.is_supervising());
        assert_eq!(supervisor.on_probe(Probe::Down, false), Action::Idle);
        assert!(!paths.marker.is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cancel_restores_window_supervision() {
        let mut supervisor = Supervisor::new();
        supervisor.set_supervising(false);
        let mut drain = ScriptedDrain::live(&["turn-1"]);
        drain.begin();
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &open_policy(),
            EnableRequest::Cancel,
            || Probe::Ours,
        );
        assert!(matches!(outcome, EnableOutcome::Cancelled(_)));
        assert!(supervisor.is_supervising());
        assert_eq!(exit.no_latch, 0);
        assert!(launch.bootstraps.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn production_gate_never_bootstraps() {
        let mut supervisor = Supervisor::new();
        let mut drain = ScriptedDrain::live(&[]);
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let outcome = enable_independent(
            &mut supervisor,
            &mut drain,
            &mut exit,
            &mut launch,
            &paths,
            &production_policy(false),
            EnableRequest::Begin,
            || Probe::Down,
        );
        assert_eq!(
            outcome,
            EnableOutcome::Failed("g_pack_not_verified".into())
        );
        assert!(supervisor.is_supervising());
        assert!(launch.bootstraps.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disable_with_window_sets_supervising_before_bootout() {
        let mut supervisor = Supervisor::new();
        supervisor.set_supervising(false);
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        write_marker(&paths.marker).unwrap();
        let outcome = disable_independent_with_window(
            &mut supervisor,
            &mut launch,
            &paths,
            || Probe::Down,
        );
        assert_eq!(outcome, DisableOutcome::WindowSpawn);
        assert!(supervisor.is_supervising());
        assert_eq!(launch.bootouts, vec![LABEL]);
        assert!(!paths.marker.is_file());
        assert!(!paths.plist.is_file());
        assert_eq!(supervisor.on_probe(Probe::Down, false), Action::Spawn);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_reports_gated_policy_without_claiming_the_agent() {
        let supervisor = Supervisor::new();
        let (dir, paths) = temp_paths();
        let status = status(
            &supervisor,
            DrainState {
                phase: DrainPhase::Running,
                remaining: Vec::new(),
                forced: false,
            },
            &production_policy(false),
            Probe::Ours,
            paths.marker.clone(),
            None,
        );
        assert!(!status.enabled);
        assert!(!status.available);
        assert_eq!(status.diagnostic, "g_pack_not_verified");
        assert_eq!(status.writer, Writer::Window);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disable_without_window_latches_then_bootout() {
        let mut launch = FakeLaunchctl::default();
        let mut exit = ScriptedExit::default();
        let (dir, paths) = temp_paths();
        write_marker(&paths.marker).unwrap();
        fs::write(&paths.plist, b"leftover").unwrap();
        let outcome = disable_independent_without_window(&mut launch, &mut exit, &paths);
        assert_eq!(
            outcome,
            DisableOutcome::StoppedWithoutWindow {
                warning: WINDOW_ABSENT_DISABLE_WARNING.into(),
            }
        );
        assert_eq!(exit.latch, 1);
        assert_eq!(exit.no_latch, 0);
        assert_eq!(launch.bootouts, vec![LABEL]);
        assert!(!paths.marker.is_file());
        assert!(!paths.plist.is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn planted_marker_with_unavailable_policy_stays_supervising_and_clears_on_recovery() {
        let mut supervisor = Supervisor::new();
        let (dir, paths) = temp_paths();
        write_marker(&paths.marker).unwrap();
        fs::write(&paths.plist, b"leftover").unwrap();
        let policy = production_policy(false);
        assert!(!restore_independent_mode(
            &mut supervisor,
            &policy,
            &paths.marker,
            false,
            false,
        ));
        assert!(supervisor.is_supervising());
        assert!(paths.marker.is_file());
        let gated_status = status(
            &supervisor,
            DrainState {
                phase: DrainPhase::Running,
                remaining: Vec::new(),
                forced: false,
            },
            &policy,
            Probe::Ours,
            paths.marker.clone(),
            None,
        );
        assert!(!gated_status.enabled);
        assert_eq!(gated_status.writer, Writer::Window);
        assert_eq!(writer_from_probe(Probe::Ours, false, false), Writer::Down);
        let mut launch = FakeLaunchctl::default();
        assert!(recover_stale_independent_marker(
            &mut supervisor,
            &mut launch,
            &paths,
            &policy,
            false,
            false,
        ));
        assert!(supervisor.is_supervising());
        assert!(!paths.marker.is_file());
        assert!(!paths.plist.is_file());
        assert_eq!(supervisor.on_probe(Probe::Down, false), Action::Spawn);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delayed_down_probe_bootstraps_only_after_pauses() {
        let mut supervisor = Supervisor::new();
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let drained = Cell::new(false);
        let pauses = Cell::new(0u8);
        let outcome = finish_enable(
            &mut supervisor,
            &mut exit,
            &mut launch,
            &paths,
            || {
                if drained.get() {
                    Probe::Down
                } else {
                    Probe::Ours
                }
            },
            || {
                pauses.set(pauses.get() + 1);
                drained.set(true);
            },
        );
        assert_eq!(outcome, EnableOutcome::Bootstrapped);
        assert_eq!(pauses.get(), 1);
        assert!(drained.get());
        assert!(!supervisor.is_supervising());
        assert_eq!(launch.bootstraps, vec![paths.plist.clone()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wait_for_down_pauses_until_a_delayed_probe_drains() {
        let drained = Cell::new(false);
        let pauses = Cell::new(0u8);
        let down = wait_for_down(
            &mut || {
                if drained.get() {
                    Probe::Down
                } else {
                    Probe::Ours
                }
            },
            || {
                pauses.set(pauses.get() + 1);
                drained.set(true);
            },
        );
        assert!(down);
        assert_eq!(pauses.get(), 1);
        assert!(drained.get());
    }

    #[test]
    fn wait_timeout_after_real_pauses_stays_down_without_window_spawn() {
        let mut supervisor = Supervisor::new();
        let mut exit = ScriptedExit::default();
        let mut launch = FakeLaunchctl::default();
        let (dir, paths) = temp_paths();
        let mut pauses = 0u32;
        let outcome = finish_enable(
            &mut supervisor,
            &mut exit,
            &mut launch,
            &paths,
            || Probe::Ours,
            || pauses += 1,
        );
        assert_eq!(outcome, EnableOutcome::Failed("port_not_empty".into()));
        assert_eq!(pauses, DOWN_WAIT_ATTEMPTS);
        assert!(!supervisor.is_supervising());
        assert_eq!(supervisor.on_probe(Probe::Down, false), Action::Idle);
        assert!(launch.bootstraps.is_empty());
        assert!(!paths.marker.is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stop_with_latch_remains_stopped_across_throttle_interval() {
        for secs in 0..=10 {
            assert!(
                stop_stays_stopped(true, Duration::from_secs(secs)),
                "still stopped at {secs}s"
            );
        }
        assert!(!stop_stays_stopped(false, Duration::from_secs(0)));
    }
}
