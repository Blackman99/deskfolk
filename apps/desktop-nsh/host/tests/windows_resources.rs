//! The Windows executable's own resources (`build.rs`), read back from the built exe: the app's icon
//! as resource 1 (what Explorer shows for the file, its shortcuts, a taskbar pin and the uninstall
//! entry, and what NSH's window class loads), the name and version Explorer's Details tab and Task
//! Manager show, and a manifest the program still starts with.
#![cfg(windows)]

use windows::Win32::Foundation::{FreeLibrary, HMODULE};
use windows::Win32::System::LibraryLoader::{
    FindResourceW, LOAD_LIBRARY_AS_DATAFILE, LOAD_LIBRARY_AS_IMAGE_RESOURCE, LoadLibraryExW, LoadResource, LockResource,
    SizeofResource,
};
use windows::core::{HSTRING, PCWSTR};

const EXE: &str = env!("CARGO_BIN_EXE_deskfolk-nsh");
const APP_ICON: &[u8] = include_bytes!("../../assets/icons/icon.ico");

const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;
const RT_VERSION: u16 = 16;
const RT_MANIFEST: u16 = 24;

/// The name this build goes by (`config::APP_NAME`).
const NAME: &str = if option_env!("DESKFOLK_RELEASE").is_some() { "Deskfolk" } else { "Deskfolk Dev" };

/// The exe mapped as data (nothing of it runs), unmapped when dropped.
struct Image(HMODULE);

impl Image {
    fn open() -> Image {
        // SAFETY: a wide path that outlives the call; the file is mapped as data only.
        let module = unsafe {
            LoadLibraryExW(&HSTRING::from(EXE), None, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)
        };
        Image(module.unwrap_or_else(|why| panic!("{EXE}: {why}")))
    }

    /// The bytes of the resource of type `kind` numbered `id`, if the exe has it.
    fn resource(&self, kind: u16, id: u16) -> Option<&[u8]> {
        // SAFETY: integer ids passed as `MAKEINTRESOURCE` does; the data stays mapped while `self` lives.
        unsafe {
            let found = FindResourceW(Some(self.0), PCWSTR(id as usize as *const u16), PCWSTR(kind as usize as *const u16));
            if found.is_invalid() {
                return None;
            }
            let size = SizeofResource(Some(self.0), found) as usize;
            let start = LockResource(LoadResource(Some(self.0), found).ok()?) as *const u8;
            (!start.is_null()).then(|| std::slice::from_raw_parts(start, size))
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        // SAFETY: the module `open` mapped, unmapped once.
        let _ = unsafe { FreeLibrary(self.0) };
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The images of `icon.ico`: (width, height, bytes), 0 in a side being 256 (`ICONDIRENTRY`).
fn ico_images() -> Vec<(u8, u8, &'static [u8])> {
    (0..u16_at(APP_ICON, 4) as usize)
        .map(|i| {
            let entry = 6 + 16 * i;
            let (size, offset) = (u32_at(APP_ICON, entry + 8) as usize, u32_at(APP_ICON, entry + 12) as usize);
            (APP_ICON[entry], APP_ICON[entry + 1], &APP_ICON[offset..offset + size])
        })
        .collect()
}

/// The product's version (`apps/desktop-nsh/package.json`, as `config::product_version` reads it).
fn product_version() -> String {
    let package: serde_json::Value = serde_json::from_str(include_str!("../../package.json")).expect("package.json");
    package["version"].as_str().expect("a version").to_owned()
}

/// A string of the version resource's `StringFileInfo`: the key, its terminating zero and the padding
/// up to the value are zeros between them (`VS_VERSIONINFO`'s `String`).
fn version_string(resource: &[u8], key: &str) -> Option<String> {
    let units: Vec<u16> = resource.as_chunks::<2>().0.iter().map(|&pair| u16::from_le_bytes(pair)).collect();
    let mut wanted: Vec<u16> = key.encode_utf16().collect();
    wanted.push(0);
    let at = units.windows(wanted.len()).position(|window| window == wanted)? + wanted.len();
    let start = at + units[at..].iter().position(|&unit| unit != 0)?;
    let end = start + units[start..].iter().position(|&unit| unit == 0)?;
    String::from_utf16(&units[start..end]).ok()
}

#[test]
fn the_exe_carries_the_app_icon_as_resource_1() {
    let image = Image::open();
    let group = image.resource(RT_GROUP_ICON, 1).expect("an icon group numbered 1, the one Explorer and NSH load");
    // GRPICONDIR: reserved 0, type 1 (icon), the count, then 14-byte entries ending in the image's id.
    assert_eq!(&group[..4], &[0, 0, 1, 0]);
    let count = u16_at(group, 4) as usize;
    let images = ico_images();
    assert_eq!(count, images.len(), "every image of icon.ico");
    for i in 0..count {
        let entry = 6 + 14 * i;
        let (width, height, id) = (group[entry], group[entry + 1], u16_at(group, entry + 12));
        let data = image.resource(RT_ICON, id).unwrap_or_else(|| panic!("icon image {id}"));
        assert!(
            images.iter().any(|&(w, h, bytes)| (w, h) == (width, height) && bytes == data),
            "image {id} ({width}x{height}) is icon.ico's"
        );
    }
}

#[test]
fn the_exe_says_its_name_and_version() {
    let image = Image::open();
    let resource = image.resource(RT_VERSION, 1).expect("version information");
    let version = product_version();
    let pairs = [("ProductName", NAME), ("FileDescription", NAME), ("ProductVersion", version.as_str()), ("FileVersion", version.as_str())];
    for (key, value) in pairs {
        assert_eq!(version_string(resource, key).as_deref(), Some(value), "{key}");
    }
    // VS_FIXEDFILEINFO, after its signature: the struct version, then the file version's high and low halves.
    let fixed = resource.windows(4).position(|window| window == 0xFEEF04BDu32.to_le_bytes()).expect("VS_FIXEDFILEINFO");
    let (high, low) = (u32_at(resource, fixed + 8), u32_at(resource, fixed + 12));
    let release: Vec<u32> = version.split(['-', '+']).next().unwrap().split('.').map(|n| n.parse().unwrap()).collect();
    assert_eq!([high >> 16, high & 0xFFFF, low >> 16, low & 0xFFFF], [release[0], release[1], release[2], 0]);
}

#[test]
fn the_exe_starts_with_its_manifest() {
    let manifest = Image::open().resource(RT_MANIFEST, 1).map(|bytes| String::from_utf8_lossy(bytes).into_owned());
    let manifest = manifest.expect("a manifest numbered 1, the one Windows reads as the program starts");
    assert!(manifest.contains("PerMonitorV2") && manifest.contains("asInvoker"), "{manifest}");
    // A manifest Windows refuses stops the program before its first line ("side-by-side configuration").
    let ran = std::process::Command::new(EXE).arg("--identity").output().expect("the exe starts");
    assert!(ran.status.success(), "{ran:?}");
    let said: serde_json::Value = serde_json::from_slice(&ran.stdout).expect("--identity says JSON");
    assert_eq!(said["name"], NAME);
}
