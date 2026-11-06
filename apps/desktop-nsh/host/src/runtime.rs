//! The dev runtime the shell talks to: found by its descriptor and a health probe, and, in a
//! packaged dev build, started by the shell itself when nothing answers (the command is baked in at
//! build time, the way the Tauri shell's debug build runs the daemon from source). It never starts
//! or reaches the stable instance: the port comes from the dev data directory and 17890 is refused.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::endpoint::{self, STABLE_PORT};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// Whether a runtime of ours answers on `port`.
pub fn healthy(port: u16) -> bool {
    if port == STABLE_PORT {
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

/// Makes sure a dev runtime answers for `data_dir`, starting the baked-in one if it is allowed to.
pub fn ensure(data_dir: &Path) -> Result<(), String> {
    if let Ok(found) = endpoint::read(data_dir) {
        if healthy(found.port) {
            return Ok(());
        }
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
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(found) = endpoint::read(data_dir) {
            if healthy(found.port) {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("the dev runtime did not come up within 20 s".into())
}

/// Stops the runtime this shell started, and only that one.
pub fn stop() {
    if let Some(mut child) = CHILD.lock().unwrap_or_else(|p| p.into_inner()).take() {
        // SIGTERM lets it close its database; the runtime stops on it.
        unsafe { libc_kill(child.id() as i32, 15) };
        let _ = child.wait();
    }
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_stable_port_is_never_healthy_to_us() {
        assert!(!super::healthy(super::STABLE_PORT));
    }
}
