//! The runtime the shell talks to: found by its descriptor and a health probe.
//!
//! - **Dev build:** in a packaged dev build the shell starts the dev runtime itself when nothing
//!   answers (the command is baked in at build time, the way the Tauri shell's debug build runs the
//!   daemon from source). It never starts or reaches the stable instance: the port comes from the
//!   dev data directory and 17890 is refused.
//! - **`--stable-instance`:** 17890 only, and never started by the shell
//!   (`scripts/dev-runtime.ts --stable-instance` runs it, in place of the installed app's).
//! - **Release** (`config::RELEASE`): the daemon compiled into the `.app`
//!   (`Contents/Resources/native/real-bot-daemon`, where the Tauri app kept it), started with the
//!   remote setup channel and watched the way the Tauri app's window does (`supervisor.rs`, `tick`):
//!   when it is down, nothing else holds the data directory and the shell is not quitting, it is
//!   started again. On quit the shell stops the daemon it supervises.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::endpoint::{self, Instance};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static QUITTING: AtomicBool = AtomicBool::new(false);

/// How long a release waits for its daemon's first answer. The first start after an update opens
/// the database and brings its schema up to date, which can take a while on a large one.
const RELEASE_START_WAIT: Duration = Duration::from_secs(90);

/// Whether a runtime of ours answers on `port`.
pub fn healthy(port: u16) -> bool {
    healthy_as(port, endpoint::instance())
}

fn healthy_as(port: u16, instance: Instance) -> bool {
    if !instance.allows(port) {
        return false;
    }
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    if stream.write_all(b"GET /v1/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer.contains("\"ok\":true") && answer.contains("\"name\":\"real-bot\"")
}

/// The command a packaged dev build starts its runtime with: `bun` and `dev-runtime.ts`, baked in
/// by `scripts/package.ts`. `None` in builds that were not given one.
fn baked_command() -> Option<(&'static str, &'static str)> {
    Some((option_env!("DESKFOLK_BUN")?, option_env!("DESKFOLK_DEV_RUNTIME")?))
}

pub fn has_dev_command() -> bool {
    baked_command().is_some()
}

/// The daemon a package carries, beside the pty, WebRTC and credential helpers it finds next to
/// itself, where the Tauri app kept them: `Contents/Resources/native/real-bot-daemon` in the
/// `.app`; `native\real-bot-daemon.exe` in the install directory on Windows.
pub fn bundled_daemon() -> Option<PathBuf> {
    bundled_daemon_for(&std::env::current_exe().ok()?)
}

fn bundled_daemon_for(exe: &Path) -> Option<PathBuf> {
    let daemon = daemon_path_for(exe, std::env::consts::OS)?;
    daemon.is_file().then_some(daemon)
}

fn daemon_path_for(exe: &Path, os: &str) -> Option<PathBuf> {
    let dir = exe.parent()?;
    Some(match os {
        "windows" => dir.join("native").join("real-bot-daemon.exe"),
        _ => dir.parent()?.join("Resources").join("native").join("real-bot-daemon"),
    })
}

/// Makes sure a runtime answers for `data_dir`, starting one if this build may.
pub fn ensure(data_dir: &Path) -> Result<(), String> {
    if let Ok(found) = endpoint::read(data_dir) {
        if healthy(found.port) {
            return Ok(());
        }
    }
    if crate::config::RELEASE {
        return ensure_bundled(data_dir);
    }
    if endpoint::instance() == Instance::Stable {
        return Err(format!(
            "no runtime answers on 17890 for {}; start it with scripts/dev-runtime.ts --stable-instance",
            data_dir.display()
        ));
    }
    let Some((bun, script)) = baked_command() else {
        return Err(format!("no dev runtime answers for {}; start it with scripts/dev-runtime.ts", data_dir.display()));
    };
    log::info!("starting the dev runtime: {bun} {script}");
    let mut command = Command::new(bun);
    command.arg(script).stdin(Stdio::null());
    if let Some(helper) = option_env!("DESKFOLK_PTY_HELPER") {
        command.env("REAL_BOT_PTY_HELPER", helper);
    }
    let child = command.spawn().map_err(|e| format!("cannot start the dev runtime: {e}"))?;
    *CHILD.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    wait_for(data_dir, Duration::from_secs(20)).ok_or_else(|| "the dev runtime did not come up within 20 s".into())
}

/// Waits for the runtime of `data_dir` to answer.
fn wait_for(data_dir: &Path, limit: Duration) -> Option<()> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Ok(found) = endpoint::read(data_dir) {
            if healthy(found.port) {
                return Some(());
            }
        }
        if !child_alive() && !holder_alive(data_dir) {
            // It ended before answering (a schema it cannot open, a port taken by something else):
            // its reason is in `daemon.log`.
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

/// A release's first start: the bundled daemon, once no other holder of the data directory is
/// alive (a daemon starting up, or the one an update's previous copy is still stopping).
fn ensure_bundled(data_dir: &Path) -> Result<(), String> {
    let deadline = Instant::now() + RELEASE_START_WAIT;
    let mut started = false;
    while Instant::now() < deadline {
        if endpoint::read(data_dir).is_ok_and(|found| healthy(found.port)) {
            return Ok(());
        }
        if !child_alive() && !holder_alive(data_dir) {
            if started {
                break;
            }
            spawn_bundled()?;
            started = true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "Deskfolk's runtime did not start. What it last wrote is in {}.",
        data_dir.join("daemon.log").display()
    ))
}

/// Starts the bundled daemon with the remote setup channel (pairing on this Mac goes over it,
/// `remote_setup.rs`), as the Tauri app's `daemon::spawn` does in a release.
fn spawn_bundled() -> Result<(), String> {
    let daemon = bundled_daemon().ok_or("this copy of Deskfolk has no runtime inside it")?;
    log::info!("starting the runtime: {}", daemon.display());
    let mut command = Command::new(&daemon);
    command
        .env_remove("BUN_BE_BUN")
        .env_remove("BUN_OPTIONS")
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "macos")]
    let channel = crate::remote_setup::prepare_channel(&mut command);
    // No console window of its own (the Tauri app's `suppress_console_window`). Windows has no
    // setup channel yet (the Tauri app's stdin/stdout one was not carried over): phones paired
    // before keep working, pairing a new one from this computer answers `disabled`.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| format!("cannot start Deskfolk's runtime: {e}"))?;
    #[cfg(target_os = "macos")]
    if let Some(channel) = channel {
        crate::remote_setup::adopt_channel(channel);
    }
    *CHILD.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    Ok(())
}

fn child_alive() -> bool {
    let mut guard = CHILD.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// The process the data directory's descriptor names is alive: something holds it (`main.ts`
/// refuses a second runtime while it does).
fn holder_alive(data_dir: &Path) -> bool {
    #[derive(serde::Deserialize)]
    struct Holder {
        pid: i32,
    }
    let Ok(text) = std::fs::read_to_string(data_dir.join(endpoint::DESCRIPTOR_NAME)) else { return false };
    let Ok(holder) = serde_json::from_str::<Holder>(&text) else { return false };
    pid_alive(holder.pid)
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc_kill(pid, 0) } == 0
}

#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid <= 0 {
        return false;
    }
    // SAFETY: a handle opened here is only read and then closed.
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) else { return false };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(process);
        alive
    }
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: i32) -> bool {
    false
}

/// What the supervision loop does on one tick.
#[derive(Debug, PartialEq, Eq)]
enum Tick {
    Idle,
    Spawn,
}

/// The Tauri app's `Supervisor::on_probe` and `tick`, for a window that always supervises (the
/// independent runtime stays fail-closed, `independent.rs`): start the daemon again only when
/// nothing of ours answers, nothing holds the data directory and the daemon this shell started is
/// not still alive.
fn decide(quitting: bool, supervising: bool, answers: bool, holder: bool, child: bool) -> Tick {
    if quitting || !supervising || answers || holder || child { Tick::Idle } else { Tick::Spawn }
}

/// A release's watch over its daemon, once a second for as long as the shell runs.
pub fn supervise(data_dir: PathBuf) {
    if !crate::config::RELEASE {
        return;
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let tick = decide(
                QUITTING.load(Ordering::SeqCst),
                supervising(),
                healthy(endpoint::STABLE_PORT),
                holder_alive(&data_dir),
                child_alive(),
            );
            if tick == Tick::Spawn {
                log::warn!("the runtime stopped answering; starting it again");
                if let Err(why) = spawn_bundled() {
                    log::warn!("{why}");
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
        }
    });
}

fn supervising() -> bool {
    #[cfg(target_os = "macos")]
    return crate::independent::supervising();
    #[cfg(not(target_os = "macos"))]
    return true;
}

/// Stops the runtime this shell is responsible for. A dev build stops the dev runtime it started,
/// and only that one. A release that supervises stops its daemon however it came up (the copy an
/// update replaced may have started it): the one it started by a signal, any other through the
/// authenticated `/v1/runtime/quit` (the Tauri app's `begin_quit`).
pub fn stop() {
    QUITTING.store(true, Ordering::SeqCst);
    let child = CHILD.lock().unwrap_or_else(|p| p.into_inner()).take();
    if crate::config::RELEASE && supervising() && child.is_none() {
        post_quit();
        return;
    }
    if let Some(mut child) = child {
        // SIGTERM lets it close its database; the runtime stops on it. Windows has no signal to
        // send: a release asks the runtime to quit over its API (as the Tauri app's window did) and
        // ends the process only if that does not take; a dev build ends it.
        #[cfg(unix)]
        unsafe {
            libc_kill(child.id() as i32, 15)
        };
        #[cfg(not(unix))]
        if crate::config::RELEASE {
            post_quit();
        } else {
            let _ = child.kill();
        }
        if crate::config::RELEASE {
            // Its turns are told to stop and its database closed; give it the few seconds that
            // takes before the process goes.
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// `POST /v1/runtime/quit` to the runtime of this shell's data directory, if one of ours answers.
fn post_quit() {
    let Some(data_dir) = endpoint::data_dir() else { return };
    let Ok(found) = endpoint::read(&data_dir) else { return };
    if !healthy(found.port) {
        return;
    }
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], found.port).into(), Duration::from_millis(300)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!(
        "POST /v1/runtime/quit HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\n\r\n",
        found.token
    );
    if stream.write_all(request.as_bytes()).is_ok() {
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
    }
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stable_port_is_never_healthy_to_us() {
        assert!(!super::healthy(crate::endpoint::STABLE_PORT));
    }

    #[test]
    fn the_stable_instance_never_takes_another_port_for_its_runtime() {
        assert!(!super::healthy_as(17990, super::Instance::Stable));
    }

    #[test]
    fn the_daemon_sits_where_the_tauri_app_kept_it_on_each_desktop() {
        assert_eq!(
            daemon_path_for(Path::new("/Applications/Deskfolk.app/Contents/MacOS/deskfolk-nsh"), "macos"),
            Some(PathBuf::from("/Applications/Deskfolk.app/Contents/Resources/native/real-bot-daemon"))
        );
        assert_eq!(
            daemon_path_for(Path::new("/Users/a/AppData/Local/Deskfolk/Deskfolk.exe"), "windows"),
            Some(PathBuf::from("/Users/a/AppData/Local/Deskfolk/native/real-bot-daemon.exe"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_daemon_lives_in_the_apps_native_folder() {
        let root = std::env::temp_dir().join(format!("deskfolk-nsh-bundled-{}", std::process::id()));
        let native = root.join("Deskfolk.app/Contents/Resources/native");
        std::fs::create_dir_all(&native).unwrap();
        let exe = root.join("Deskfolk.app/Contents/MacOS/deskfolk-nsh");
        assert_eq!(bundled_daemon_for(&exe), None, "no daemon there yet");
        std::fs::write(native.join("real-bot-daemon"), b"").unwrap();
        assert_eq!(bundled_daemon_for(&exe), Some(native.join("real-bot-daemon")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn it_starts_again_only_when_nothing_holds_the_data_directory() {
        assert_eq!(decide(false, true, false, false, false), Tick::Spawn);
        assert_eq!(decide(false, true, true, false, false), Tick::Idle, "one of ours answers");
        assert_eq!(decide(false, true, false, true, false), Tick::Idle, "a holder is still alive");
        assert_eq!(decide(false, true, false, false, true), Tick::Idle, "the one it started is still starting");
        assert_eq!(decide(true, true, false, false, false), Tick::Idle, "quitting");
        assert_eq!(decide(false, false, false, false, false), Tick::Idle, "not supervising");
    }

    #[cfg(unix)]
    #[test]
    fn a_descriptor_names_a_live_or_a_gone_holder() {
        let dir = std::env::temp_dir().join(format!("deskfolk-nsh-holder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!holder_alive(&dir), "no descriptor");
        std::fs::write(dir.join("local-api.json"), format!(r#"{{"pid":{},"port":17890,"token":"t"}}"#, std::process::id())).unwrap();
        assert!(holder_alive(&dir));
        std::fs::write(dir.join("local-api.json"), r#"{"pid":0,"port":17890,"token":"t"}"#).unwrap();
        assert!(!holder_alive(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
