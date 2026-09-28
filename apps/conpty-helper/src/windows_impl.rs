//! The actual ConPTY + Job Object plumbing. Only compiled on Windows — `portable-pty`'s ConPTY
//! backend and the Job Object bindings are Windows-only dependencies (see Cargo.toml's
//! `[target.'cfg(windows)']` section) — so nothing here has to build, let alone be exercised, on
//! macOS. The wire protocol, CLI parsing and signal mapping it calls into all live in sibling
//! modules that *do* build and get unit tested everywhere; this file is the untested glue that
//! wires them to real Win32 objects.

use crate::cli;
use crate::protocol::{self, ControlEvent};
use crate::signal::{self, SignalAction};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::TerminateProcess;

/// A CLI/argument problem: same `real-bot-pty: <message>` + exit 64 the Swift helper uses.
fn fail_usage(message: &str) -> ! {
    eprintln!("real-bot-pty: {message}");
    std::process::exit(64);
}

/// Something on our side of the fence (ConPTY, CreateProcess, the Job Object) failed. There's
/// no Darwin `forkpty`-failure precedent to match exactly, so this reuses the Swift helper's
/// "internal error" exit code (70, `EX_SOFTWARE`) rather than inventing a new one.
fn fail_internal(message: &str) -> ! {
    eprintln!("real-bot-pty: {message}");
    std::process::exit(70);
}

/// How to end the whole tree: the normal path (a Job Object, so one call takes down every
/// descendant), or the fallback if we couldn't put the child in a job — kill just the direct
/// child; anything it spawned is then this Windows install's problem, same as it would be for
/// any terminal that never had a Job Object at all.
///
/// Holds a raw `HANDLE` across threads deliberately: every use of it goes through
/// `TerminateJobObject`/`TerminateProcess`, which are safe to call at any time, concurrently
/// with anything else happening to the same handle (the child exiting on its own included —
/// terminating an already-exited process/job is simply a no-op error we ignore).
#[derive(Clone, Copy)]
enum TreeKiller {
    Job(HANDLE),
    DirectChild(HANDLE),
}

// SAFETY: a `HANDLE` is just an opaque numeric id as far as this process is concerned; nothing
// here dereferences it, only passes it to Win32 calls that are themselves thread-safe.
unsafe impl Send for TreeKiller {}

impl TreeKiller {
    fn kill(&self, exit_code: u32) {
        unsafe {
            match *self {
                TreeKiller::Job(job) => {
                    TerminateJobObject(job, exit_code);
                }
                TreeKiller::DirectChild(handle) => {
                    TerminateProcess(handle, exit_code);
                }
            }
        }
    }
}

/// Puts `child` in a fresh Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so terminating
/// the tree is one `TerminateJobObject` call, and a helper that dies for any other reason takes
/// its whole tree down with it when the OS closes our last handle to the job. Falls back to
/// tracking only the direct child if anything here fails (job nesting has been unconditionally
/// allowed since Windows 8, so in practice this only fails on much older systems, or if some
/// outer job explicitly forbids nesting).
fn assign_job_object(child: &(dyn Child + Send + Sync)) -> TreeKiller {
    let handle = match child.as_raw_handle() {
        Some(handle) => handle as HANDLE,
        None => {
            eprintln!(
                "real-bot-pty: no process handle for the child; signals will only reach it, not its descendants"
            );
            return TreeKiller::DirectChild(std::ptr::null_mut());
        }
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!(
                "real-bot-pty: CreateJobObjectW failed ({}); falling back to killing only the direct child",
                io::Error::last_os_error()
            );
            return TreeKiller::DirectChild(handle);
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set_ok == 0 {
            eprintln!(
                "real-bot-pty: SetInformationJobObject failed ({}); falling back to killing only the direct child",
                io::Error::last_os_error()
            );
            return TreeKiller::DirectChild(handle);
        }

        if AssignProcessToJobObject(job, handle) == 0 {
            eprintln!(
                "real-bot-pty: AssignProcessToJobObject failed ({}); falling back to killing only the direct child",
                io::Error::last_os_error()
            );
            return TreeKiller::DirectChild(handle);
        }

        // Deliberately not closed here: for as long as this process is alive, this handle is
        // exactly what makes `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` mean "and if *we* die, so does
        // the tree". It gets reclaimed, and the limit fires, whenever this process exits for any
        // reason — including the normal exit at the end of `run()`.
        TreeKiller::Job(job)
    }
}

pub fn run() -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let default_cwd = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());
    let options = match cli::parse(&args, &default_cwd) {
        Ok(options) => options,
        Err(message) => fail_usage(&message),
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows,
            cols: options.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap_or_else(|err| fail_internal(&format!("openpty failed: {err}")));

    let mut builder = CommandBuilder::new(&options.command[0]);
    builder.args(&options.command[1..]);
    builder.cwd(&options.cwd);

    let mut child = pair
        .slave
        .spawn_command(builder)
        .unwrap_or_else(|err| fail_internal(&format!("spawn failed: {err}")));
    // The slave side has done its job; only the master (resize/read/write) is used from here.
    drop(pair.slave);

    let tree_killer = assign_job_object(child.as_ref());

    let reader = pair
        .master
        .try_clone_reader()
        .unwrap_or_else(|err| fail_internal(&format!("could not open a reader on the pty: {err}")));
    let writer = pair
        .master
        .take_writer()
        .unwrap_or_else(|err| fail_internal(&format!("could not open a writer on the pty: {err}")));
    let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> = Arc::new(Mutex::new(Some(pair.master)));

    // Thread 1: pty output -> stdout, unframed, byte for byte, flushed after every read so the
    // daemon sees it promptly.
    let (output_done, output_finished) = std::sync::mpsc::channel::<()>();
    {
        let mut reader = reader;
        std::thread::spawn(move || {
            let mut stdout = io::stdout();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stdout.write_all(&buffer[..n]).is_err() {
                            break;
                        }
                        let _ = stdout.flush();
                    }
                    Err(_) => break,
                }
            }
            let _ = output_done.send(());
        });
    }

    // Thread 2: stdin control frames -> the pty / the job. A shut-down (frame 4, or stdin EOF,
    // or an oversized frame — `protocol::ControlEvent::EndOfStream` covers all three) exits the
    // whole process directly from here rather than returning: the main thread may be blocked in
    // `child.wait()` with nothing that would ever wake it up on its own, and this thread must
    // never be joined in that case either, since a daemon that only ever closes its write end
    // has nothing left to send. `process::exit` tears down every thread at once, so there is
    // nothing to deadlock on.
    {
        let master = Arc::clone(&master);
        let mut writer = writer;
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            loop {
                let event = protocol::read_event(&mut stdin).unwrap_or(ControlEvent::EndOfStream);
                match event {
                    ControlEvent::Input(bytes) => {
                        let _ = writer.write_all(&bytes);
                        let _ = writer.flush();
                    }
                    ControlEvent::Resize { rows, cols } => {
                        if let Some(master) = master.lock().unwrap().as_ref() {
                            let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                        }
                    }
                    ControlEvent::Signal(signo) => match signal::windows_action(signo) {
                        SignalAction::WriteByte(byte) => {
                            let _ = writer.write_all(&[byte]);
                            let _ = writer.flush();
                        }
                        SignalAction::Ignore => {}
                        SignalAction::KillTree { exit_code } => tree_killer.kill(exit_code),
                    },
                    ControlEvent::Ignored => {}
                    ControlEvent::Shutdown | ControlEvent::EndOfStream => {
                        tree_killer.kill(1);
                        std::process::exit(0);
                    }
                }
            }
        });
    }

    let status = child.wait();

    // However the child ended, the pseudo console must close before the output thread can ever
    // see EOF: ConPTY's own host process keeps its duplicate of the output pipe's write end open
    // for as long as the pseudo console handle exists, even after every process attached to it
    // has exited. Dropping `master` here (the only owner of the `PsuedoCon`) runs
    // `ClosePseudoConsole`, which releases that duplicate — only then does the reader thread's
    // own, separately-duplicated, read handle actually reach EOF.
    //
    // Bounded, not a plain join: if some Windows build keeps that pipe open anyway, a session
    // whose shell has exited must still end, so its last output gets two seconds to drain.
    *master.lock().unwrap() = None;
    let _ = output_finished.recv_timeout(std::time::Duration::from_secs(2));
    let _ = io::stdout().flush();

    match status {
        Ok(status) => std::process::exit(status.exit_code() as i32),
        Err(_) => std::process::exit(70),
    }
}
