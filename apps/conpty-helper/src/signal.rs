//! Maps the Darwin signal numbers the daemon sends (see `apps/daemon/src/pty.ts`'s `SIGNO`
//! table) — the wire format on every platform — into what this helper does with them.
//!
//! On Windows, where there is no `kill()`: 2/3 are typed as the control keys they stand for (see
//! `input` for how Ctrl+C reaches conhost); 18 has no Windows analogue and is dropped; 9/15 don't
//! map to a specific per-signal behaviour on Windows, only to "make it stop, all of it".
//!
//! On unix they become this host's own numbers (`unix_signal`): the same values on macOS, but on
//! Linux Darwin's SIGTSTP (18) is SIGCONT, so passing the number through would resume instead of
//! suspend.

/// What a `signal` control frame (see `protocol.rs`) asks the Windows side to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalAction {
    /// Write this single byte to the pty's input, as if it had been typed.
    WriteByte(u8),
    /// No Windows equivalent; drop it.
    Ignore,
    /// Terminate the child's whole process tree. `exit_code` is what `TerminateJobObject`
    /// (or the direct-child fallback) reports back through `GetExitCodeProcess` — chosen to
    /// read the same way the Swift helper's `128 + signal` exit code does for a process that
    /// was killed rather than one that exited on its own.
    KillTree { exit_code: u32 },
}

pub fn windows_action(signo: u8) -> SignalAction {
    match signo {
        2 => SignalAction::WriteByte(0x03),  // SIGINT -> Ctrl-C
        3 => SignalAction::WriteByte(0x1c),  // SIGQUIT -> Ctrl-\
        18 => SignalAction::Ignore,          // SIGTSTP: no stop/continue concept on Windows
        9 | 15 => SignalAction::KillTree { exit_code: 128 + signo as u32 }, // SIGKILL / SIGTERM
        _ => SignalAction::Ignore,
    }
}

/// The host's own number for a Darwin-numbered signal the daemon sends; `None` for any other
/// number, which is dropped, as on Windows.
#[cfg(unix)]
pub fn unix_signal(signo: u8) -> Option<libc::c_int> {
    match signo {
        2 => Some(libc::SIGINT),
        3 => Some(libc::SIGQUIT),
        9 => Some(libc::SIGKILL),
        15 => Some(libc::SIGTERM),
        18 => Some(libc::SIGTSTP),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigint_writes_ctrl_c() {
        assert_eq!(windows_action(2), SignalAction::WriteByte(0x03));
    }

    #[test]
    fn sigquit_writes_ctrl_backslash() {
        assert_eq!(windows_action(3), SignalAction::WriteByte(0x1c));
    }

    #[test]
    fn sigtstp_is_ignored() {
        assert_eq!(windows_action(18), SignalAction::Ignore);
    }

    #[test]
    fn sigkill_kills_the_tree() {
        assert_eq!(windows_action(9), SignalAction::KillTree { exit_code: 137 });
    }

    #[test]
    fn sigterm_kills_the_tree() {
        assert_eq!(windows_action(15), SignalAction::KillTree { exit_code: 143 });
    }

    #[cfg(unix)]
    #[test]
    fn darwin_numbers_become_this_hosts_own() {
        assert_eq!(unix_signal(2), Some(libc::SIGINT));
        assert_eq!(unix_signal(3), Some(libc::SIGQUIT));
        assert_eq!(unix_signal(9), Some(libc::SIGKILL));
        assert_eq!(unix_signal(15), Some(libc::SIGTERM));
        assert_eq!(unix_signal(18), Some(libc::SIGTSTP));
        #[cfg(target_os = "linux")]
        assert_eq!(libc::SIGTSTP, 20, "Linux numbers SIGTSTP differently from Darwin");
        for signo in [0u8, 1, 4, 6, 19, 20, 30, 255] {
            assert_eq!(unix_signal(signo), None, "signo {signo}");
        }
    }

    #[test]
    fn unmapped_signals_are_ignored() {
        for signo in [0u8, 1, 4, 6, 19, 30, 255] {
            assert_eq!(windows_action(signo), SignalAction::Ignore, "signo {signo}");
        }
    }
}
