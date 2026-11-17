//! The runtime the shell talks to: found by its descriptor and a health probe.
//!
//! - **Dev build:** in a packaged dev build the shell starts the dev runtime itself when nothing
//!   answers (the command is baked in at build time, the way the 0.4.0 shell's debug build runs the
//!   daemon from source). It never starts or reaches the stable instance: the port comes from the
//!   dev data directory and 17890 is refused.
//! - **`--stable-instance`:** 17890 only, and never started by the shell
//!   (`scripts/dev-runtime.ts --stable-instance` runs it, in place of the installed app's).
//! - **Release** (`config::RELEASE`): the daemon compiled into the `.app`
//!   (`Contents/Resources/native/real-bot-daemon`, where the 0.4.0 app kept it), started with the
//!   remote setup channel and watched the way the 0.4.0 app's window does (`supervisor.rs`, `tick`):
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
/// itself, where the 0.4.0 app kept them: `Contents/Resources/native/real-bot-daemon` in the
/// `.app`; `native\real-bot-daemon.exe` in the install directory on Windows;
/// `/usr/lib/Deskfolk/native/real-bot-daemon` beside the shell on Linux (`/usr/bin/real-bot-desktop`
/// is a link to it, which `current_exe` resolves).
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
        "linux" => dir.join("native").join("real-bot-daemon"),
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

/// Starts the bundled daemon with the remote setup channel (pairing on this computer goes over it,
/// `remote_setup.rs`), as the 0.4.0 app's `daemon::spawn` does in a release. Passing the channel
/// also makes the daemon window-supervised, so a paired phone can restart it.
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
    #[cfg(unix)]
    let channel = crate::remote_setup::prepare_channel(&mut command);
    // The daemon's stdin and stdout are the channel on Windows (after the `null`s above, which it
    // replaces); no console window of its own (the 0.4.0 app's `suppress_console_window`).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        crate::remote_setup::prepare_channel(&mut command);
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut child = command.spawn().map_err(|e| format!("cannot start Deskfolk's runtime: {e}"))?;
    #[cfg(unix)]
    if let Some(channel) = channel {
        crate::remote_setup::adopt_channel(channel);
    }
    #[cfg(windows)]
    {
        crate::remote_setup::adopt_channel(&mut child);
        end_with_this_process(&child);
    }
    *CHILD.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    Ok(())
}

/// Puts the daemon in a job that ends with this process, however it ends (the 0.4.0 app's
/// `daemon.rs`): a shell that crashes or is ended in Task Manager takes the daemon, its pty helper
/// and its terminals' programs with it, rather than leaving them running without a window (the next
/// launch would find a runtime with no setup channel to it). The job's handle is never closed: it
/// closes with the process.
#[cfg(windows)]
fn end_with_this_process(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows::core::PCWSTR;

    struct Job(HANDLE);
    // SAFETY: a job handle may be used from any thread; this one is only ever passed to the system.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    let job = JOB.get_or_init(|| {
        // SAFETY: plain calls; the structure outlives the call that reads it.
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(Job(job))
        }
    });
    match job {
        // SAFETY: the child's handle is alive while `child` is.
        Some(job) => match unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) } {
            Ok(()) => log::info!("the runtime ends with this window"),
            Err(why) => log::warn!("the runtime would outlive this window: {why}"),
        },
        None => log::warn!("no job to end the runtime with this window"),
    }
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

/// The 0.4.0 app's `Supervisor::on_probe` and `tick`, for a window that always supervises (the
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
            if supervising() {
                clear_stop_latch(&data_dir);
            }
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

/// The latch a runtime writes when a paired phone stops it (`lifecycle.ts`, `runtime.stop`): it
/// keeps an independent runtime from being started again by launchd. A window that supervises
/// starts it again anyway, and a runtime that found the latch still there would report itself
/// stopped and its restart unavailable (`remote/maint.ts`), so the window clears it while it
/// supervises, as the 0.4.0 app's `tick` did.
fn clear_stop_latch(data_dir: &std::path::Path) {
    match std::fs::remove_file(data_dir.join(STOP_LATCH)) {
        Ok(()) => log::info!("cleared the runtime's stop latch: this window supervises it"),
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => {}
        Err(why) => log::warn!("cannot clear the runtime's stop latch: {why}"),
    }
}

const STOP_LATCH: &str = "runtime.stop";

/// Whether a window of the app ran in this process: its app asked for the runtime's address
/// (`launch::channel`). A Linux launch that only handed itself to the copy already running never
/// does, and leaves that copy's runtime alone (`gtk.rs`).
static WINDOW_RAN: AtomicBool = AtomicBool::new(false);

pub fn mark_window_ran() {
    WINDOW_RAN.store(true, Ordering::SeqCst);
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn window_ran() -> bool {
    WINDOW_RAN.load(Ordering::SeqCst)
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
/// authenticated `/v1/runtime/quit` (the 0.4.0 app's `begin_quit`).
pub fn stop() {
    QUITTING.store(true, Ordering::SeqCst);
    let child = CHILD.lock().unwrap_or_else(|p| p.into_inner()).take();
    if crate::config::RELEASE && supervising() && child.is_none() {
        post_quit();
        return;
    }
    if let Some(mut child) = child {
        // SIGTERM lets it close its database; the runtime stops on it. Windows has no signal to
        // send: a release asks the runtime to quit over its API (as the 0.4.0 app's window did) and
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

/// Stops only a runtime this process started, and leaves one another copy of the app runs (a launch
/// that handed itself to the copy already running, `win.rs`, `gtk.rs`). The Mac has no such launch.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn stop_started() {
    if CHILD.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        stop();
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
    fn the_daemon_sits_where_0_4_0_kept_it_on_each_desktop() {
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

    #[test]
    fn a_supervising_window_clears_the_stop_latch() {
        let dir = std::env::temp_dir().join(format!("deskfolk-latch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runtime.stop"), "stopped\n").unwrap();
        super::clear_stop_latch(&dir);
        assert!(!dir.join("runtime.stop").exists());
        // Nothing to clear is fine too.
        super::clear_stop_latch(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
