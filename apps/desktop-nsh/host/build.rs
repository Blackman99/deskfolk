//! The Windows executable's own resources, which a Rust binary is built without: the app's icon, the
//! version information Explorer's Details tab and Task Manager read, and the manifest
//! (`windows/deskfolk.exe.manifest`). Without them Explorer, the Start menu and desktop shortcuts, a
//! taskbar pin and the uninstall entry all show the system's blank program icon.
//!
//! The icon is resource 1: the one Explorer shows for the file, and the one NSH's window class and
//! `has_own_icon` load. The version is the product's (`../package.json`, read as
//! `config::product_version` and `scripts/package.ts` read it), the name the build's (`config::APP_NAME`:
//! `DESKFOLK_RELEASE` makes it Deskfolk). They are compiled with the Windows SDK's `rc.exe`, which
//! embed-resource finds (Visual Studio Build Tools' "Desktop development with C++" brings it), into the
//! binary only; `tests/windows_resources.rs` reads them back. Builds for macOS and Linux get nothing.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=windows/deskfolk.exe.manifest");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../assets/icons/icon.ico");
    println!("cargo:rerun-if-env-changed=DESKFOLK_RELEASE");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    #[cfg(windows)]
    resources::embed();
    #[cfg(not(windows))]
    println!("cargo:warning=a Windows build made on another system gets no icon, version information or manifest");
}

#[cfg(windows)]
mod resources {
    use std::path::PathBuf;

    pub fn embed() {
        let here = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
        let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
        let package = std::fs::read_to_string(here.join("../package.json")).expect("apps/desktop-nsh/package.json");
        let package: serde_json::Value = serde_json::from_str(&package).expect("package.json is JSON");
        let version = package["version"].as_str().expect("package.json names the product's version");
        let name = if std::env::var_os("DESKFOLK_RELEASE").is_some() { "Deskfolk" } else { "Deskfolk Dev" };
        let script = out.join("deskfolk.rc");
        std::fs::write(&script, resource_script(name, version)).expect("the resource script");
        if let Err(why) = embed_resource::compile(&script, embed_resource::NONE).manifest_required() {
            panic!("the exe's icon, version information and manifest: {why}");
        }
    }

    /// The resource script. The icon and the manifest are named relative to this package's folder, the
    /// working directory of a build script and of the `rc.exe` it runs: rc.exe reads the script in the
    /// ANSI code page, so a full path through a folder named in another script would not survive it.
    fn resource_script(name: &str, version: &str) -> String {
        for text in [name, version] {
            assert!(text.is_ascii() && !text.contains(['"', '\\']), "{text:?} cannot go into the resource script as it is");
        }
        let numbers = file_version(version);
        format!(
            r#"// Written by build.rs.
1 ICON "..\\assets\\icons\\icon.ico"
1 24 "windows\\deskfolk.exe.manifest"

1 VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEFLAGSMASK 0x3F
FILEFLAGS 0x0
FILEOS 0x40004
FILETYPE 0x1
FILESUBTYPE 0x0
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904B0"
        BEGIN
            VALUE "CompanyName", "Deskfolk"
            VALUE "FileDescription", "{name}"
            VALUE "FileVersion", "{version}"
            VALUE "InternalName", "{name}"
            VALUE "LegalCopyright", "Copyright (c) Deskfolk contributors. MIT License."
            VALUE "OriginalFilename", "Deskfolk.exe"
            VALUE "ProductName", "{name}"
            VALUE "ProductVersion", "{version}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
"#
        )
    }

    /// The four numbers of a version (`FILEVERSION`): the release's three, a pre-release tag or build
    /// dropped, and 0, as `windowsFileVersion` in `scripts/package.ts` gives the installer's.
    fn file_version(version: &str) -> String {
        let release = version.split(['-', '+']).next().unwrap_or_default();
        let mut parts = release.split('.').map(|part| part.parse::<u16>().unwrap_or(0));
        let mut next = || parts.next().unwrap_or(0);
        format!("{},{},{},0", next(), next(), next())
    }
}
