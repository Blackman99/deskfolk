fn main() {
    let native = std::path::Path::new("native");
    if !native.exists() && std::env::var("PROFILE").as_deref() == Ok("debug") {
        // Development and Rust tests do not need credential binaries; releases must build them.
        std::fs::create_dir(native).expect("create native resource directory");
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        for file in [
            "real-bot-daemon",
            "real-bot-runtime-helper",
            "libRemoteCredentials.dylib",
        ] {
            assert!(
                native.join(file).is_file(),
                "run pnpm --filter @real-bot/desktop build:native first"
            );
        }
    }
    tauri_build::build()
}
