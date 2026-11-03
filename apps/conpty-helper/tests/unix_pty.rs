//! The forkpty backend end to end: the real binary, a real pty, real shells. These run on macOS
//! as well as Linux, so the backend Linux ships is exercised on every `cargo test` here.
#![cfg(unix)]

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_real-bot-pty");

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    output: mpsc::Receiver<Vec<u8>>,
    seen: Vec<u8>,
}

fn start(cwd: &str, command: &[&str]) -> Session {
    let mut child = Command::new(HELPER)
        .args(["--rows", "24", "--cols", "80", "--cwd", cwd, "--"])
        .args(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("helper starts");
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap();
    let (tx, output) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(got) = stdout.read(&mut buffer) {
            if got == 0 || tx.send(buffer[..got].to_vec()).is_err() {
                break;
            }
        }
    });
    Session { child, stdin, output, seen: Vec::new() }
}

impl Session {
    fn frame(&mut self, kind: u8, payload: &[u8]) {
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn input(&mut self, text: &str) {
        self.frame(1, text.as_bytes());
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        let mut payload = rows.to_be_bytes().to_vec();
        payload.extend_from_slice(&cols.to_be_bytes());
        self.frame(2, &payload);
    }

    fn signal(&mut self, darwin_signo: u8) {
        self.frame(3, &[darwin_signo]);
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.seen).into_owned()
    }

    /// Waits until the output so far contains `needle`, and returns all of it. The pty echoes what
    /// is typed, so a needle meant to prove a command ran must not appear in the command itself
    /// (hence `echo up-$((40+2))` waiting for `up-42`).
    fn wait_for(&mut self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.text().contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.output.recv_timeout(left) {
                Ok(bytes) => self.seen.extend(bytes),
                Err(_) => panic!("never saw {needle:?}; output so far: {:?}", self.text()),
            }
        }
        self.text()
    }

    fn exit_code(mut self) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                while let Ok(bytes) = self.output.recv_timeout(Duration::from_millis(200)) {
                    self.seen.extend(bytes);
                }
                return status.code().expect("helper exits, not killed");
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("helper did not exit; output: {:?}", self.text());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn the_shell_has_a_controlling_terminal_and_is_in_the_foreground() {
    let mut session = start("/", &["/bin/sh", "-c", "tty; ps -o stat= -p $$; echo end-of-check"]);
    let out = session.wait_for("end-of-check");
    assert!(out.contains("/dev/"), "tty names a device: {out:?}");
    assert!(!out.contains("not a tty"), "{out:?}");
    let stat = out.lines().nth(1).unwrap_or_default();
    assert!(stat.contains('+'), "ps marks the foreground process group: {out:?}");
    assert_eq!(session.exit_code(), 0);
}

#[test]
fn the_child_starts_in_the_given_folder() {
    let dir = std::env::temp_dir().canonicalize().unwrap();
    let dir = dir.to_str().unwrap();
    let mut session = start(dir, &["/bin/sh", "-c", "pwd -P"]);
    session.wait_for(dir);
    assert_eq!(session.exit_code(), 0);
}

#[test]
fn a_missing_folder_exits_126_and_a_missing_program_127() {
    let session = start("/no/such/folder/anywhere", &["/bin/sh", "-c", "true"]);
    assert_eq!(session.exit_code(), 126);
    let session = start("/", &["/no/such/program"]);
    assert_eq!(session.exit_code(), 127);
}

#[test]
fn the_exit_status_comes_back_and_a_signal_reads_128_plus() {
    assert_eq!(start("/", &["/bin/sh", "-c", "exit 3"]).exit_code(), 3);
    assert_eq!(start("/", &["/bin/sh", "-c", "kill -9 $$"]).exit_code(), 137);
}

#[test]
fn a_resize_reaches_the_pty() {
    let mut session = start("/", &["/bin/sh"]);
    session.resize(40, 120);
    session.input("stty size; echo size-$((40+2))\n");
    let out = session.wait_for("size-42");
    assert!(out.contains("40 120"), "{out:?}");
    session.input("exit\n");
    assert_eq!(session.exit_code(), 0);
}

#[test]
fn an_interrupt_reaches_the_foreground_program_and_the_shell_survives() {
    // What an interactive shell does with the rest of a line after an interrupt differs (dash
    // drops it, bash runs it), so the check comes as the next line: `sleep` died of SIGINT (130),
    // well before its hundred seconds, and the shell is still there to say so.
    let mut session = start("/", &["/bin/sh"]);
    session.input("sleep 100\n");
    std::thread::sleep(Duration::from_millis(400));
    session.signal(2);
    std::thread::sleep(Duration::from_millis(300));
    session.input("echo status-$?-$((40+2))\n");
    session.wait_for("status-130-42");
    session.input("exit 4\n");
    assert_eq!(session.exit_code(), 4);
}

#[test]
fn darwin_sigtstp_arrives_as_this_hosts_sigtstp() {
    // No child process to stop: the loop is built-ins only, so the trap runs as soon as the
    // signal lands. On Linux, passing 18 through unchanged would deliver SIGCONT and hang here.
    let mut session = start("/", &["/bin/sh", "-c", "trap 'echo got-tstp; exit 5' TSTP; echo ready; while :; do :; done"]);
    session.wait_for("ready");
    session.signal(18);
    session.wait_for("got-tstp");
    assert_eq!(session.exit_code(), 5);
}

#[test]
fn a_closed_pipe_ends_the_shell_quietly() {
    // SIGPIPE must be back at its default in the child, or `yes` reports the broken pipe.
    let mut session = start("/", &["/bin/sh", "-c", "yes | head -1; echo pipe-done"]);
    let out = session.wait_for("pipe-done");
    assert!(!out.to_lowercase().contains("broken pipe"), "{out:?}");
    assert_eq!(session.exit_code(), 0);
}

/// After a shut-down the helper exits with the hung-up shell's status (129) when its output loop
/// reaps it, or 0 when the shut-down does — the Swift helper's race, kept on purpose.
fn hung_up(code: i32) -> bool {
    code == 128 + libc::SIGHUP || code == 0
}

#[test]
fn a_shut_down_frame_hangs_the_session_up() {
    let mut session = start("/", &["/bin/sh"]);
    session.input("echo up-$((40+2))\n");
    session.wait_for("up-42");
    session.frame(4, &[]);
    let code = session.exit_code();
    assert!(hung_up(code), "exit {code}");
}

#[test]
fn a_closed_stdin_means_the_daemon_is_gone() {
    let mut session = start("/", &["/bin/sh"]);
    session.input("echo up-$((40+2))\n");
    session.wait_for("up-42");
    session.stdin = None;
    let code = session.exit_code();
    assert!(hung_up(code), "exit {code}");
}

#[test]
fn a_shell_that_ignores_hangup_is_killed_after_the_grace() {
    let mut session = start("/", &["/bin/sh", "-c", "trap '' HUP; echo ready; while :; do sleep 0.1; done"]);
    session.wait_for("ready");
    let started = Instant::now();
    session.frame(4, &[]);
    let code = session.exit_code();
    assert!(code == 128 + libc::SIGKILL || code == 0, "exit {code}");
    assert!(started.elapsed() >= Duration::from_millis(1500), "waited out the grace first");
}

#[test]
fn sigterm_to_the_helper_shuts_the_session_down() {
    let mut session = start("/", &["/bin/sh"]);
    session.input("echo up-$((40+2))\n");
    session.wait_for("up-42");
    unsafe { libc::kill(session.child.id() as libc::pid_t, libc::SIGTERM) };
    let code = session.exit_code();
    assert!(hung_up(code), "exit {code}");
}
