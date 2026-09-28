fn main() {
    let native = std::path::Path::new("native");
    if !native.exists() && std::env::var("PROFILE").as_deref() == Ok("debug") {
        // Development and Rust tests do not need credential binaries; releases must build them.
        std::fs::create_dir(native).expect("create native resource directory");
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        // Windows ships only the daemon and the ConPTY helper: no Swift
        // runtime helper, no dylib — those are macOS-only credential-runtime pieces.
        let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
        let files: &[&str] = if windows {
            &["real-bot-daemon.exe", "real-bot-pty.exe"]
        } else {
            &[
                "real-bot-daemon",
                "real-bot-runtime-helper",
                "real-bot-pty",
                "libRemoteCredentials.dylib",
            ]
        };
        for file in files {
            assert!(
                native.join(file).is_file(),
                "run pnpm --filter @real-bot/desktop build:native first"
            );
        }
    }
    tauri_build::build()
}
