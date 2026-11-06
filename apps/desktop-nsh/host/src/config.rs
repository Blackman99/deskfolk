//! What the shell was started with.

use std::path::PathBuf;

use crate::endpoint::Endpoint;

pub struct Config {
    pub bundle: PathBuf,
    pub data_dir: PathBuf,
    pub endpoint: Endpoint,
    pub app_name: String,
    pub bundle_id: String,
    /// Load the bundle again whenever its file changes (`scripts/dev.ts` rebuilds it on save).
    pub watch: bool,
    /// Show windows without activating the app or taking the keyboard (checks run beside the
    /// person's own work).
    pub background: bool,
    /// Development only: where windows draw themselves on request (`snapshot.rs`).
    pub snapshots: Option<PathBuf>,
    /// Development checks: the conversation and pane the first window opens on.
    pub open_session: Option<String>,
    pub pane: Option<String>,
    pub pdf: Option<String>,
    /// NSH's performance monitor, logged once a second (target `nsh::perf`).
    pub fps: bool,
    /// Development checks: the open conversation scrolls itself end to end (with `fps`).
    pub scroll_probe: bool,
}

pub const USAGE: &str = "deskfolk-nsh [--bundle <bundle.js|bundle.nshc>] [--data-dir <runtime data dir>] [--watch] [--background] [--snapshots <dir>] [--open-session <id>] [--pane chat|terminal|pdf] [--pdf <path>] [--fps] [--scroll-probe]";

pub fn from_args(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut bundle = None;
    let mut data_dir = None;
    let mut watch = false;
    let mut background = false;
    let mut snapshots = None;
    let mut open_session = None;
    let mut pane = None;
    let mut pdf = None;
    let mut fps = false;
    let mut scroll_probe = false;
    let mut args = args.skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bundle" => bundle = args.next().map(PathBuf::from),
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--watch" => watch = true,
            "--background" => background = true,
            "--snapshots" => snapshots = args.next().map(PathBuf::from),
            "--open-session" => open_session = args.next(),
            "--pane" => pane = args.next(),
            "--pdf" => pdf = args.next(),
            "--fps" => fps = true,
            "--scroll-probe" => scroll_probe = true,
            // AppKit's own (`-NSDocumentRevisionsDebugMode YES`, …).
            other if other.starts_with('-') && !other.starts_with("--") => {
                args.next();
            }
            other => return Err(format!("unknown argument {other}\nusage: {USAGE}")),
        }
    }
    // A packaged app carries its bundle; a dev build names it.
    let bundle = bundle.or_else(packaged_bundle).ok_or_else(|| format!("--bundle is required outside the .app\nusage: {USAGE}"))?;
    let data_dir = data_dir.unwrap_or_else(dev_data_dir);
    crate::runtime::ensure(&data_dir)?;
    let endpoint = crate::endpoint::read(&data_dir).map_err(|e| e.to_string())?;
    Ok(Config {
        bundle,
        data_dir,
        endpoint,
        app_name: "Deskfolk Dev".into(),
        bundle_id: "com.real-bot.desktop.nsh-dev".into(),
        watch,
        background,
        snapshots,
        open_session,
        pane,
        pdf,
        fps,
        scroll_probe,
    })
}

/// `Contents/Resources/app/bundle.nshc` beside the executable in `Contents/MacOS`.
fn packaged_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.join("Resources").join("app").join("bundle.nshc");
    bundle.exists().then_some(bundle)
}

/// The dev instance's data directory (`scripts/dev-instance.ts`), never the stable one.
fn dev_data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library").join("Application Support").join("real-bot-nsh-dev")
}
