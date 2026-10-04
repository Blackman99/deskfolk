//! `real-bot-rtc stay-awake`: Windows' stand-in for `caffeinate -d -u` while a phone has the
//! remote screen open. A PC left alone turns its display off and then sleeps, and a sleeping PC
//! drops the phone mid-session. `SetThreadExecutionState` with `ES_CONTINUOUS` holds both for as
//! long as this thread asks; Windows lets go of the request when the process ends, however it
//! ends, so the daemon closing stdin (or dying) gives the PC its own timers back.

use std::io::Read;

/// Holds until stdin closes. Returns the process's exit code: 1 where there is nothing to hold.
pub fn stay_awake() -> i32 {
    if !power::hold() {
        return 1;
    }
    let mut stdin = std::io::stdin().lock();
    let mut sink = [0u8; 256];
    while matches!(stdin.read(&mut sink), Ok(read) if read > 0) {}
    power::release();
    0
}

#[cfg(windows)]
mod power {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    pub fn hold() -> bool {
        // SAFETY: takes and returns plain flags; no pointers.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED) != 0
        }
    }

    pub fn release() {
        // SAFETY: as above.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

/// macOS keeps its display on with `caffeinate`, which the daemon runs itself.
#[cfg(not(windows))]
mod power {
    pub fn hold() -> bool {
        false
    }

    pub fn release() {}
}
