// A ConPTY pty for one terminal session, and nothing else.
//
// This is the Windows sibling of `apps/runtime-helper/Sources/PtyHelper/main.swift`; it speaks
// the exact same protocol so the daemon only has to change which binary it launches. Where the
// Swift helper exists because a controlling terminal can only be acquired between fork and
// exec, this one exists because attaching a pseudo console (ConPTY) is likewise something only
// `CreateProcess` can do, via a process-thread attribute set up before the child starts — there
// is no way to retrofit a running process onto a pseudo console afterwards. `portable-pty`
// (wezterm's crate) does the ConPTY/`CreateProcess` dance; what is left here is the wire
// protocol, the signal-to-Windows mapping, and the Job Object plumbing that keeps a tree of
// child processes killable as one unit. See `windows_impl.rs` for all of that.
//
// It holds no credentials and asks for no elevation. Spawning a shell is something the person
// can already do from a Command Prompt, so there is nothing here to escalate; that is also why
// it is its own binary rather than a subcommand of anything else.
//
//   real-bot-pty --rows 24 --cols 80 --cwd C:\path -- pwsh.exe -NoLogo
//
// stdin  — control frames: [type:u8][len:u32be][payload]
//            1 input (raw bytes)  2 resize (rows:u16be, cols:u16be)  3 signal (signo:u8,
//            Darwin numbers — the same table the daemon already sends on macOS)
//            4 shut down (empty)
//          EOF means the daemon is gone, and means the same thing as frame 4. So does a frame
//          whose declared length is over 1 MiB — the Swift helper treats that as fatal too, and
//          this one matches it (see `protocol::ControlEvent::EndOfStream`).
// stdout — raw ConPTY output, unframed, flushed after every read so the daemon can stream it
//          into xterm.js promptly.
// exit   — the child's exit code, except for an explicit shut-down (frame 4 or EOF), which
//          always exits 0 once the tree is down — there is no shell left to have an opinion
//          about its own exit status.
//
// Signals have no Windows equivalent, so they are reinterpreted (see `signal.rs`):
//   SIGINT (2)   -> write 0x03 to the pty input; ConPTY's Win32-input-mode turns that into a
//                   real CTRL_C_EVENT for whatever is attached, same as a physical Ctrl-C
//                   keypress would.
//   SIGQUIT (3)  -> write 0x1c (Ctrl-\), for whatever the foreground program makes of it.
//   SIGTSTP (18) -> ignored; Windows consoles have no stop/continue concept.
//   SIGKILL/SIGTERM (9, 15) -> terminate the whole Job Object (see below), not just the shell.
//
// Every child goes into its own Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: killing
// the tree is one `TerminateJobObject` call, and if this helper itself dies for any other
// reason, the OS tears down every descendant the moment our last handle to the job closes — no
// orphaned shells, no separate watchdog needed. Job nesting has been unconditionally allowed
// since Windows 8, so this still works even if something upstream already put us in a job of
// its own; if assigning the job fails anyway, we fall back to killing only the direct child.
//
// ConPTY has a well-known quirk: the output pipe does not EOF just because the child exited —
// the pseudo console's own host keeps its duplicate of the write end open until
// `ClosePseudoConsole` runs. So the shutdown order is: wait for the child, close/drop the
// pseudo console, *then* drain the output pipe to EOF, then exit. See `windows_impl::run`.

// These three modules are the platform-independent core (see the module docs), unit tested
// everywhere via `cargo test`, but only ever *called* from `windows_impl`, which doesn't exist
// on this build. Real dead code on Windows would still be a real warning there.
#![cfg_attr(not(windows), allow(dead_code))]

mod cli;
mod protocol;
mod signal;

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
fn main() {
    windows_impl::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("real-bot-pty: the ConPTY helper only runs on Windows");
    std::process::exit(70);
}
