//! The pty on Linux (and any other unix): a line-for-line port of the Swift helper
//! (`apps/runtime-helper/Sources/PtyHelper/main.swift`), which macOS keeps using. `forkpty` does
//! setsid, TIOCSCTTY and the dup2s in the child, so the shell gets a real controlling terminal and
//! `tcgetpgrp` names whatever runs in the foreground; signals go to that group, not to the shell.
//!
//! Two deliberate differences from the Swift original:
//! - Signal numbers arrive in Darwin numbering (the wire format, see `signal.rs`) and are
//!   translated to this host's own: on Linux, Darwin's SIGTSTP (18) would be SIGCONT.
//! - The child gets SIGPIPE back at its default before exec. Rust's runtime ignores SIGPIPE in
//!   this process (so a write to a closed stdout is an error, not a death), and an ignored signal
//!   survives exec — `yes | head -1` in the terminal would then print "Broken pipe" instead of
//!   ending quietly.

use crate::cli;
use crate::protocol::{self, ControlEvent};
use crate::signal;

use std::ffi::CString;
use std::io::{self, Read, Write};
use std::os::fd::FromRawFd;
use std::time::Duration;

/// Same `real-bot-pty: <message>` + exit code shape as the Swift helper (64 usage, 70 internal).
fn fail(message: &str, code: i32) -> ! {
    eprintln!("real-bot-pty: {message}");
    std::process::exit(code);
}

#[derive(Clone, Copy)]
struct Session {
    master: libc::c_int,
    child: libc::pid_t,
}

impl Session {
    /// Signals go to the tty's foreground process group, not to the shell: an interrupt is meant
    /// for whatever is running right now, and the shell should survive it.
    fn deliver(&self, signo: libc::c_int) {
        unsafe {
            let foreground = libc::tcgetpgrp(self.master);
            if foreground > 0 {
                libc::killpg(foreground, signo);
            } else {
                libc::kill(self.child, signo);
            }
        }
    }

    /// Ending the session, and meaning it. A hangup alone is a request — a login shell may have
    /// SIGHUP ignored — so ask, wait two seconds, and then insist. The child is its own session
    /// and process-group leader (forkpty saw to that), so its pgid is its pid.
    ///
    /// As in the Swift helper, whoever reaps the child says how the helper exits: here, 0; the
    /// output loop, which usually gets there first once the hangup lands, the child's own status.
    fn shutdown(&self) -> ! {
        self.deliver(libc::SIGHUP);
        unsafe { libc::kill(self.child, libc::SIGHUP) };
        for _ in 0..20 {
            match self.wait(libc::WNOHANG) {
                Wait::Reaped => std::process::exit(0),
                Wait::Gone => park(),
                Wait::Running => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        unsafe {
            libc::killpg(self.child, libc::SIGKILL);
            libc::kill(self.child, libc::SIGKILL);
        }
        match self.wait(0) {
            Wait::Reaped => std::process::exit(0),
            _ => park(),
        }
    }

    fn wait(&self, flags: libc::c_int) -> Wait {
        loop {
            let mut status = 0;
            let got = unsafe { libc::waitpid(self.child, &mut status, flags) };
            if got == self.child {
                return Wait::Reaped;
            }
            if got == 0 {
                return Wait::Running;
            }
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Wait::Gone;
        }
    }
}

enum Wait {
    Reaped,
    Running,
    /// Reaped by the other thread, which is exiting the process with the child's status.
    Gone,
}

/// Leaves the exit to the thread that reaped the child.
fn park() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn write_all_fd(fd: libc::c_int, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        let put = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if put < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return;
        }
        if put == 0 {
            return;
        }
        bytes = &bytes[put as usize..];
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let default_cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());
    let options = cli::parse(&args, &default_cwd).unwrap_or_else(|message| fail(&message, 64));

    // Everything the child touches between fork and exec has to exist before the fork: only
    // async-signal-safe calls are legal there, which rules out allocation.
    let to_c = |value: &str| CString::new(value).unwrap_or_else(|_| fail("argument holds a NUL byte", 64));
    let argv_owned: Vec<CString> = options.command.iter().map(|arg| to_c(arg)).collect();
    let mut argv: Vec<*const libc::c_char> = argv_owned.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(std::ptr::null());
    let cwd = to_c(&options.cwd);

    let mut master: libc::c_int = 0;
    let mut size = libc::winsize { ws_row: options.rows, ws_col: options.cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: every pointer is valid for the call; `name` and `termp` may be null.
    let child = unsafe {
        libc::forkpty(
            &mut master,
            std::ptr::null_mut(),
            std::ptr::null_mut::<libc::termios>() as _,
            &mut size as *mut libc::winsize as _,
        )
    };
    if child < 0 {
        fail(&format!("forkpty failed: {}", io::Error::last_os_error()), 70);
    }
    if child == 0 {
        // SAFETY: the child of a single-threaded parent, using only async-signal-safe calls.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            if libc::chdir(cwd.as_ptr()) != 0 {
                libc::_exit(126);
            }
            libc::execv(argv[0], argv.as_ptr());
            libc::_exit(127);
        }
    }
    let session = Session { master, child };

    // A daemon that is going away sends SIGTERM as well as closing the pipe; both mean the same
    // thing. Blocked here, before any thread exists, so every thread inherits the mask and only
    // the `sigwait` below ever sees them.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGHUP);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        std::thread::spawn(move || {
            let mut got: libc::c_int = 0;
            libc::sigwait(&set, &mut got);
            session.shutdown();
        });
    }

    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            match protocol::read_event(&mut stdin) {
                Ok(ControlEvent::Input(bytes)) => write_all_fd(session.master, &bytes),
                Ok(ControlEvent::Resize { rows, cols }) => {
                    let next = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
                    unsafe { libc::ioctl(session.master, libc::TIOCSWINSZ as _, &next) };
                }
                Ok(ControlEvent::Signal(signo)) => {
                    if let Some(native) = signal::unix_signal(signo) {
                        session.deliver(native);
                    }
                }
                Ok(ControlEvent::Ignored) => {}
                // The pipe closed: the daemon is gone, and an orphaned shell helps nobody.
                Ok(ControlEvent::Shutdown) | Ok(ControlEvent::EndOfStream) | Err(_) => session.shutdown(),
            }
        }
    });

    // SAFETY: `master` is ours alone; this `File` is the only reader, and it is never closed while
    // the session lives (the process exits first).
    let mut output = unsafe { std::fs::File::from_raw_fd(master) };
    let mut stdout = io::stdout().lock();
    let mut buffer = [0u8; 8192];
    loop {
        match output.read(&mut buffer) {
            Ok(0) => break,
            Ok(got) => {
                if stdout.write_all(&buffer[..got]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break, // EIO once the child is gone
        }
    }
    std::mem::forget(output);

    let mut status: libc::c_int = 0;
    loop {
        let got = unsafe { libc::waitpid(child, &mut status, 0) };
        if got < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if got < 0 {
            // A shut-down reaped it and exits 0; so does this, whichever gets there first.
            std::process::exit(0);
        }
        break;
    }
    if libc::WIFSIGNALED(status) {
        std::process::exit(128 + libc::WTERMSIG(status));
    }
    std::process::exit(libc::WEXITSTATUS(status));
}
