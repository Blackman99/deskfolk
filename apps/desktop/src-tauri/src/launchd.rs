//! User-domain Aqua LaunchAgent for the opt-in independent runtime.
//!
//! Production stays fail-closed: this module never talks to the user's launchd
//! unless a test injects a fake controller. Plist rendering is PathState-only.
//! The mutating surface is unit-tested; the live window refuses enablement
//! until G-pack / G-launchd pass, so rustc reports it unused in `pnpm dev`.
#![cfg_attr(not(test), allow(dead_code))]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const LABEL: &str = "com.real-bot.runtime";
pub const THROTTLE_INTERVAL: u32 = 10;
pub const LATCH_NAME: &str = "runtime.stop";
pub const MARKER_NAME: &str = "runtime.independent";
pub const PLIST_NAME: &str = "com.real-bot.runtime.plist";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPaths {
    pub program: PathBuf,
    pub plist: PathBuf,
    pub latch: PathBuf,
    pub marker: PathBuf,
    pub data_dir: PathBuf,
}

impl AgentPaths {
    pub fn for_data_dir(program: PathBuf, data_dir: PathBuf, plist: PathBuf) -> Self {
        Self {
            latch: data_dir.join(LATCH_NAME),
            marker: data_dir.join(MARKER_NAME),
            program,
            plist,
            data_dir,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndependentPolicy {
    pub available: bool,
    pub diagnostic: String,
}

impl IndependentPolicy {
    /// Fail-closed until a sealed runtime (G-pack) exists. Dev never installs.
    pub fn production(dev: bool) -> Self {
        if dev {
            return Self {
                available: false,
                diagnostic: "dev_does_not_install_agent".into(),
            };
        }
        Self {
            available: false,
            diagnostic: "g_pack_not_verified".into(),
        }
    }
}

pub trait Launchctl {
    fn bootstrap(&mut self, domain: &str, plist: &Path) -> Result<(), String>;
    fn bootout(&mut self, domain: &str, label: &str) -> Result<(), String>;
}

/// KeepAlive.PathState[latch]=false: relaunch only when the latch is absent.
pub fn keep_alive_after_exit(latch_exists: bool) -> bool {
    !latch_exists
}

pub fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn render_plist(program: &Path, latch: &Path, data_dir: &Path) -> Result<String, String> {
    require_absolute(program, "program")?;
    require_absolute(latch, "latch")?;
    require_absolute(data_dir, "data_dir")?;
    let program = xml_escape(&path_string(program)?);
    let latch = xml_escape(&path_string(latch)?);
    let data_dir = xml_escape(&path_string(data_dir)?);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>PathState</key>
		<dict>
			<key>{latch}</key>
			<false/>
		</dict>
	</dict>
	<key>ThrottleInterval</key>
	<integer>{THROTTLE_INTERVAL}</integer>
	<key>ProgramArguments</key>
	<array>
		<string>{program}</string>
		<string>--standalone</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>REAL_BOT_DATA_DIR</key>
		<string>{data_dir}</string>
	</dict>
</dict>
</plist>
"#
    ))
}

pub fn require_absolute(path: &Path, label: &str) -> Result<(), String> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(format!("{label} must be an absolute path"))
    }
}

pub fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "path must be utf-8".into())
}

fn lstat(path: &Path) -> Result<fs::Metadata, String> {
    fs::symlink_metadata(path).map_err(|_| format!("{} is not readable", path.display()))
}

fn reject_symlink(path: &Path, meta: &fs::Metadata) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        Err(format!("{} must not be a symlink", path.display()))
    } else {
        Ok(())
    }
}

fn assert_owner_not_group_world_writable(path: &Path, meta: &fs::Metadata, user_owned: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::getuid() };
        if user_owned {
            if meta.uid() != uid {
                return Err(format!("{} is not owned by the current user", path.display()));
            }
        } else if meta.uid() != uid && meta.uid() != 0 {
            return Err(format!(
                "{} must be owned by the current user or root",
                path.display()
            ));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(format!(
                "{} must not be group or world writable",
                path.display()
            ));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, meta, user_owned);
    }
    Ok(())
}

/// User-owned, not a symlink, not group/world writable. Relative paths never qualify.
pub fn assert_user_owned_not_group_world_writable(path: &Path) -> Result<(), String> {
    require_absolute(path, "path")?;
    let meta = lstat(path)?;
    reject_symlink(path, &meta)?;
    assert_owner_not_group_world_writable(path, &meta, true)
}

/// Ancestors must not be symlinks or group/world writable (root-owned 755 is allowed).
pub fn assert_ancestors_not_group_world_writable(path: &Path) -> Result<(), String> {
    require_absolute(path, "path")?;
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir.as_os_str().is_empty() {
            break;
        }
        let meta = lstat(dir)?;
        reject_symlink(dir, &meta)?;
        if !meta.is_dir() {
            return Err(format!("{} must be a directory", dir.display()));
        }
        assert_owner_not_group_world_writable(dir, &meta, false)?;
        if dir == Path::new("/") {
            break;
        }
        current = dir.parent();
    }
    Ok(())
}

fn assert_regular_file_user_private(path: &Path) -> Result<(), String> {
    assert_user_owned_not_group_world_writable(path)?;
    let meta = lstat(path)?;
    if !meta.is_file() {
        return Err(format!("{} must be a user-owned file", path.display()));
    }
    Ok(())
}

fn assert_directory_user_private(path: &Path) -> Result<(), String> {
    assert_user_owned_not_group_world_writable(path)?;
    let meta = lstat(path)?;
    if !meta.is_dir() {
        return Err(format!("{} must be a directory", path.display()));
    }
    Ok(())
}

fn chmod_private(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|err| err.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

fn ensure_user_private_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| "path must have a parent".to_string())?;
    require_absolute(parent, "parent")?;
    if parent.exists() {
        let meta = lstat(parent)?;
        reject_symlink(parent, &meta)?;
        if !meta.is_dir() {
            return Err(format!("{} must be a directory", parent.display()));
        }
        assert_owner_not_group_world_writable(parent, &meta, true)?;
    } else {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        chmod_private(parent, 0o700)?;
        assert_directory_user_private(parent)?;
    }
    assert_ancestors_not_group_world_writable(parent)
}

pub fn write_agent_plist(paths: &AgentPaths) -> Result<String, String> {
    assert_regular_file_user_private(&paths.program)?;
    assert_ancestors_not_group_world_writable(&paths.program)?;
    require_absolute(&paths.plist, "plist")?;
    ensure_user_private_parent(&paths.plist)?;
    if paths.plist.exists() {
        assert_regular_file_user_private(&paths.plist)?;
    }
    if paths.latch.exists() {
        assert_regular_file_user_private(&paths.latch)?;
        assert_ancestors_not_group_world_writable(&paths.latch)?;
    } else if let Some(parent) = paths.latch.parent() {
        if parent.exists() {
            assert_directory_user_private(parent)?;
            assert_ancestors_not_group_world_writable(parent)?;
        }
    }
    if paths.marker.exists() {
        assert_regular_file_user_private(&paths.marker)?;
        assert_ancestors_not_group_world_writable(&paths.marker)?;
    }
    let body = render_plist(&paths.program, &paths.latch, &paths.data_dir)?;
    if body.contains("PathExists") {
        return Err("plist must not use PathExists".into());
    }
    let tmp = paths.plist.with_extension("plist.tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|err| err.to_string())?;
        file.write_all(body.as_bytes())
            .map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }
    chmod_private(&tmp, 0o600)?;
    fs::rename(&tmp, &paths.plist).map_err(|err| err.to_string())?;
    chmod_private(&paths.plist, 0o600)?;
    if let Ok(dir) = File::open(paths.plist.parent().unwrap_or_else(|| Path::new("/"))) {
        let _ = dir.sync_all();
    }
    assert_regular_file_user_private(&paths.plist)?;
    Ok(body)
}

pub fn write_marker(path: &Path) -> Result<(), String> {
    require_absolute(path, "marker")?;
    ensure_user_private_parent(path)?;
    if path.exists() {
        assert_regular_file_user_private(path)?;
    }
    fs::write(path, b"1\n").map_err(|err| err.to_string())?;
    chmod_private(path, 0o600)?;
    assert_regular_file_user_private(path)
}

pub fn write_stop_latch(path: &Path) -> Result<(), String> {
    require_absolute(path, "latch")?;
    ensure_user_private_parent(path)?;
    if path.exists() {
        assert_regular_file_user_private(path)?;
    }
    fs::write(path, b"stopped\n").map_err(|err| err.to_string())?;
    chmod_private(path, 0o600)?;
    assert_regular_file_user_private(path)
}

pub fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn independent_marker_present(path: &Path) -> bool {
    lstat(path).ok().is_some_and(|meta| meta.is_file())
}

/// Honor `runtime.independent` only when policy is available and this window
/// bootstrapped or launchctl shows `com.real-bot.runtime` loaded. Never adopt a PID.
pub fn adopt_independent_marker(
    policy: &IndependentPolicy,
    marker: &Path,
    this_window_bootstrapped: bool,
    agent_loaded: bool,
) -> bool {
    policy.available
        && independent_marker_present(marker)
        && (this_window_bootstrapped || agent_loaded)
}

/// Read-only `launchctl print`. Tests inject a fake; production never bootstraps from this.
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

pub fn agent_loaded_in_gui_domain() -> bool {
    let domain = gui_domain();
    let output = std::process::Command::new("launchctl")
        .args(["print", &format!("{domain}/{LABEL}")])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            parse_launchctl_print_loaded(&String::from_utf8_lossy(&output.stdout), LABEL)
                || parse_launchctl_print_loaded(&String::from_utf8_lossy(&output.stderr), LABEL)
        }
        _ => false,
    }
}

pub fn gui_domain() -> String {
    #[cfg(unix)]
    {
        format!("gui/{}", unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        "gui/0".into()
    }
}

/// Real launchctl. Production stays fail-closed and must not construct this while G-pack is closed.
pub struct ProcessLaunchctl;

impl Launchctl for ProcessLaunchctl {
    fn bootstrap(&mut self, domain: &str, plist: &Path) -> Result<(), String> {
        run_launchctl(&["bootstrap", domain, &path_string(plist)?])
    }
    fn bootout(&mut self, domain: &str, label: &str) -> Result<(), String> {
        run_launchctl(&["bootout", &format!("{domain}/{label}")])
    }
}

fn run_launchctl(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("launchctl")
        .args(args)
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("launchctl {args:?} failed"))
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeLaunchctl {
    pub bootstraps: Vec<PathBuf>,
    pub bootouts: Vec<String>,
    pub fail_bootstrap: bool,
    pub fail_bootout: bool,
}

#[cfg(test)]
impl Launchctl for FakeLaunchctl {
    fn bootstrap(&mut self, _domain: &str, plist: &Path) -> Result<(), String> {
        if self.fail_bootstrap {
            return Err("bootstrap failed".into());
        }
        self.bootstraps.push(plist.to_path_buf());
        Ok(())
    }
    fn bootout(&mut self, _domain: &str, label: &str) -> Result<(), String> {
        if self.fail_bootout {
            return Err("bootout failed".into());
        }
        self.bootouts.push(label.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = UNIQUE.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("independent-runtime-tests")
            .join(format!("launchd-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }

    fn program_in(dir: &Path) -> PathBuf {
        let path = dir.join("real-bot-daemon");
        fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }

    #[test]
    fn production_policy_is_fail_closed() {
        let prod = IndependentPolicy::production(false);
        assert!(!prod.available);
        assert_eq!(prod.diagnostic, "g_pack_not_verified");
        let dev = IndependentPolicy::production(true);
        assert!(!dev.available);
        assert_eq!(dev.diagnostic, "dev_does_not_install_agent");
    }

    #[test]
    fn plist_uses_path_state_not_path_exists() {
        let dir = temp_dir();
        let program = dir.join("real-bot-daemon");
        let latch = dir.join("runtime.stop");
        let body = render_plist(&program, &latch, &dir).unwrap();
        assert!(body.contains("<key>PathState</key>"));
        assert!(!body.contains("PathExists"));
        assert!(body.contains(&format!("<key>{}</key>", latch.display())));
        assert!(body.contains("<false/>"));
        assert!(body.contains("<key>RunAtLoad</key>"));
        assert!(body.contains("<integer>10</integer>"));
        assert!(body.contains("<string>Aqua</string>"));
        assert!(body.contains("--standalone"));
        assert!(!body.contains("fork"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(render_plist(Path::new("daemon"), Path::new("/tmp/latch"), Path::new("/tmp")).is_err());
        assert!(assert_user_owned_not_group_world_writable(Path::new("relative")).is_err());
    }

    #[test]
    fn group_or_world_writable_program_is_rejected() {
        let dir = temp_dir();
        let program = program_in(&dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o722)).unwrap();
            assert!(assert_user_owned_not_group_world_writable(&program).is_err());
            fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(assert_user_owned_not_group_world_writable(&program).is_ok());
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_agent_plist_is_user_private() {
        let dir = temp_dir();
        let paths = AgentPaths::for_data_dir(program_in(&dir), dir.clone(), dir.join(PLIST_NAME));
        let body = write_agent_plist(&paths).unwrap();
        assert!(body.contains("PathState"));
        assert!(!body.contains("PathExists"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&paths.plist).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn group_writable_latch_is_rejected() {
        let dir = temp_dir();
        let latch = dir.join(LATCH_NAME);
        fs::write(&latch, b"stopped\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&latch, fs::Permissions::from_mode(0o660)).unwrap();
            assert!(assert_user_owned_not_group_world_writable(&latch).is_err());
            let paths = AgentPaths::for_data_dir(program_in(&dir), dir.clone(), dir.join(PLIST_NAME));
            assert!(write_agent_plist(&paths).is_err());
            fs::set_permissions(&latch, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(write_stop_latch(&latch).is_ok());
            let mode = fs::metadata(&latch).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn symlink_plist_is_rejected() {
        let dir = temp_dir();
        let real = dir.join("real.plist");
        fs::write(&real, b"not-a-job").unwrap();
        let link = dir.join(PLIST_NAME);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let paths = AgentPaths::for_data_dir(program_in(&dir), dir.clone(), link);
            assert!(write_agent_plist(&paths).is_err());
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn symlink_program_is_rejected() {
        let dir = temp_dir();
        let real = program_in(&dir);
        let link = dir.join("linked-daemon");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(assert_user_owned_not_group_world_writable(&link).is_err());
            let paths = AgentPaths::for_data_dir(link, dir.clone(), dir.join(PLIST_NAME));
            assert!(write_agent_plist(&paths).is_err());
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn planted_marker_is_ignored_without_policy_or_loaded_job() {
        let dir = temp_dir();
        let marker = dir.join(MARKER_NAME);
        write_marker(&marker).unwrap();
        let gated = IndependentPolicy::production(false);
        assert!(!adopt_independent_marker(&gated, &marker, false, false));
        assert!(!adopt_independent_marker(&gated, &marker, true, true));
        let open = IndependentPolicy {
            available: true,
            diagnostic: "test_seam".into(),
        };
        assert!(!adopt_independent_marker(&open, &marker, false, false));
        assert!(adopt_independent_marker(&open, &marker, true, false));
        assert!(adopt_independent_marker(&open, &marker, false, true));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn launchctl_print_parser_does_not_treat_missing_job_as_loaded() {
        assert!(!parse_launchctl_print_loaded(
            "Could not find service \"com.real-bot.runtime\" in domain",
            LABEL
        ));
        assert!(parse_launchctl_print_loaded(
            "gui/501/com.real-bot.runtime = {\n\tstate = running\n}",
            LABEL
        ));
    }

    #[test]
    fn keepalive_path_state_stays_stopped_across_throttle_interval() {
        assert!(keep_alive_after_exit(false));
        assert!(!keep_alive_after_exit(true));
        let mut elapsed = 0;
        while elapsed < THROTTLE_INTERVAL {
            elapsed += 1;
            assert!(
                !keep_alive_after_exit(true),
                "stop latch must suppress relaunch at {elapsed}s"
            );
        }
    }

    #[test]
    fn fake_launchctl_never_spawns_a_process() {
        let mut fake = FakeLaunchctl::default();
        fake.bootstrap("gui/1", Path::new("/tmp/com.real-bot.runtime.plist"))
            .unwrap();
        fake.bootout("gui/1", LABEL).unwrap();
        assert_eq!(fake.bootstraps.len(), 1);
        assert_eq!(fake.bootouts, vec![LABEL]);
        fake.fail_bootstrap = true;
        assert!(fake.bootstrap("gui/1", Path::new("/tmp/x.plist")).is_err());
    }
}
