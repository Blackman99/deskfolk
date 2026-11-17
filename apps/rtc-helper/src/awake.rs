//! `real-bot-rtc stay-awake`: the Windows and Linux stand-in for `caffeinate -d -u` while a phone
//! has the remote screen open. A PC left alone turns its display off and then sleeps, and a sleeping PC
//! drops the phone mid-session. `SetThreadExecutionState` with `ES_CONTINUOUS` holds both for as
//! long as this thread asks; Windows lets go of the request when the process ends, however it
//! ends, so the daemon closing stdin (or dying) gives the PC its own timers back.
//!
//! Linux has no single call: the desktop's screensaver (`org.freedesktop.ScreenSaver.Inhibit` on
//! the session bus) keeps the display on, and logind (`Inhibit("sleep:idle")` on the system bus)
//! keeps the machine from suspending or idling off. Each holds only while its bus connection or
//! file descriptor lives, so both go when this process ends, however it ends.

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

#[cfg(target_os = "linux")]
mod power {
    use std::sync::Mutex;
    use zbus::blocking::Connection;
    use zbus::zvariant::OwnedFd;

    const APP: &str = "Deskfolk";
    const REASON: &str = "A phone is viewing this screen";

    /// What is held: the session-bus connection with the screensaver's cookie, and logind's fd.
    struct Held {
        screensaver: Option<(Connection, u32)>,
        _logind: Option<OwnedFd>,
    }

    static HELD: Mutex<Option<Held>> = Mutex::new(None);

    fn screensaver() -> Result<(Connection, u32), zbus::Error> {
        let connection = Connection::session()?;
        let reply = connection.call_method(
            Some("org.freedesktop.ScreenSaver"),
            "/org/freedesktop/ScreenSaver",
            Some("org.freedesktop.ScreenSaver"),
            "Inhibit",
            &(APP, REASON),
        )?;
        let cookie: u32 = reply.body().deserialize()?;
        Ok((connection, cookie))
    }

    fn logind() -> Result<OwnedFd, zbus::Error> {
        let connection = Connection::system()?;
        let reply = connection.call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "Inhibit",
            &("sleep:idle", APP, REASON, "block"),
        )?;
        Ok(reply.body().deserialize()?)
    }

    /// True when at least one of the two holds took; a missing bus only costs its own hold.
    pub fn hold() -> bool {
        let screensaver = screensaver()
            .map_err(|error| eprintln!("stay-awake: no screensaver inhibitor: {error}"))
            .ok();
        let logind = logind()
            .map_err(|error| eprintln!("stay-awake: no logind inhibitor: {error}"))
            .ok();
        let any = screensaver.is_some() || logind.is_some();
        if any {
            *HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some(Held { screensaver, _logind: logind });
        }
        any
    }

    pub fn release() {
        let held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(Held { screensaver: Some((connection, cookie)), .. }) = &held {
            let _ = connection.call_method(
                Some("org.freedesktop.ScreenSaver"),
                "/org/freedesktop/ScreenSaver",
                Some("org.freedesktop.ScreenSaver"),
                "UnInhibit",
                &(*cookie,),
            );
        }
        // Dropping `held` closes the logind fd and the session connection.
    }
}

/// macOS keeps its display on with `caffeinate`, which the daemon runs itself.
#[cfg(not(any(windows, target_os = "linux")))]
mod power {
    pub fn hold() -> bool {
        false
    }

    pub fn release() {}
}
