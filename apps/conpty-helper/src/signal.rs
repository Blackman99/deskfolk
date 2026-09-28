//! Maps the Darwin signal numbers the daemon sends (see `apps/daemon/src/pty.ts`'s `SIGNO`
//! table) into what this helper does with them on Windows, where there is no `kill()`. Contract
//! (§3 of the shared Windows plan): 2/3 are delivered as control bytes that ConPTY's
//! Win32-input-mode already turns into the right console event; 18 has no Windows analogue and
//! is dropped; 9/15 don't map to a specific per-signal behaviour on Windows, only to "make it
//! stop, all of it".

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

    #[test]
    fn unmapped_signals_are_ignored() {
        for signo in [0u8, 1, 4, 6, 19, 30, 255] {
            assert_eq!(windows_action(signo), SignalAction::Ignore, "signo {signo}");
        }
    }
}
