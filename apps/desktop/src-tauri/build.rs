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
    // tauri-build embeds its Common Controls v6 manifest into the app binary only. The unit-test
    // binary links the same comctl32 imports (TaskDialogIndirect) and, without that manifest,
    // Windows refuses to start it (STATUS_ENTRYPOINT_NOT_FOUND). So on MSVC the linker embeds the
    // same manifest into every binary instead, and tauri-build leaves its own copy out (two would
    // collide as duplicate resources).
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Not `canonicalize`: on Windows that yields a `\\?\` path, which link.exe may not take.
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}
