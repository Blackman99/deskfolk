//! Whether this copy of the shell is a development build, and what it is called. The Tauri app
//! asks `tauri::is_dev()`; the NSH shell has no such flag, so a copy is a dev build when its
//! bundle id ends in `.nsh-dev` (every packaged build today: `scripts/package.ts`) or when the
//! binary does not run out of an `.app` at all (`cargo run`, `scripts/dev.ts`).
//!
//! Everything that would touch the machine beyond this process (login items, replacing a bundle,
//! the independent runtime's launchd agent, remote pairing) is refused for a dev build.

use std::path::{Path, PathBuf};

/// The suffix of the dev instance's bundle id (`scripts/dev-instance.ts`).
pub const DEV_SUFFIX: &str = ".nsh-dev";

/// What a handler needs to know about the shell it answers for.
#[derive(Clone, Debug)]
pub struct Identity {
    pub bundle_id: String,
    pub data_dir: PathBuf,
    /// The port of the runtime this shell talks to (17890 only with `--stable-instance`).
    pub port: u16,
    pub version: &'static str,
}

impl Identity {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            bundle_id: config.bundle_id.clone(),
            data_dir: config.data_dir.clone(),
            port: config.endpoint.port,
            version: crate::config::product_version(),
        }
    }

    pub fn is_dev(&self) -> bool {
        std::env::current_exe().map(|exe| is_dev(&self.bundle_id, &exe)).unwrap_or(true)
    }
}

pub fn is_dev(bundle_id: &str, exe: &Path) -> bool {
    bundle_id.ends_with(DEV_SUFFIX) || crate::installer::bundle_root(exe).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_is_the_dev_bundle_id_or_a_bare_binary() {
        let in_app = Path::new("/Applications/Deskfolk Dev.app/Contents/MacOS/deskfolk-nsh");
        let bare = Path::new("/work/target/debug/deskfolk-nsh");
        assert!(is_dev("com.real-bot.desktop.nsh-dev", in_app));
        assert!(!is_dev("com.real-bot.desktop", in_app));
        assert!(is_dev("com.real-bot.desktop", bare));
        assert!(is_dev("com.real-bot.desktop.nsh-dev", bare));
    }
}
