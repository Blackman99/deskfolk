//! The Windows shell: NSH's own standalone window (`run_app`), running the same bundle and the same
//! launch parameters as on macOS. NSH makes the window, so the app hides its title bar and has the
//! caption buttons drawn over it, as the traffic lights are on macOS; a view embedded in a window of
//! ours could not. Closing the window ends the run. The tray, toast notifications and the installer
//! come after this skeleton.
//!
//! The window's look is set before it is made (`with_main_window`, what `nsh.json` `"window"` would
//! say, for Windows only): the title bar hidden, and on Windows 11 22H2 and later Mica behind the
//! app, as the Tauri window had. A window with a system backdrop is drawn by a composition (no
//! redirection bitmap), which is chosen when the window is made, so Mica cannot be turned on later
//! from the TSX. The window keeps its system frame: its shadow, its resize borders and, on Windows
//! 11, its rounded corners (square while maximized, as the system draws them). The app is told
//! whether the material is there (`host.params.material`, `window_material`) and lets it through
//! (`ui/glass.ts`).

use std::path::Path;

use nsh_platform_windows::{AppOptions, AppSource, AssetBase, Bundle, Limits, set_ui_sets};
use serde_json::json;

use crate::config::Config;

/// The first Windows build with `DWMWA_SYSTEMBACKDROP_TYPE` (Windows 11 22H2), where NSH maps
/// `backdrop` to Mica; before it the attribute is refused and the window stays solid.
const SYSTEM_BACKDROP_BUILD: u32 = 22621;

pub fn run(config: Config) -> std::process::ExitCode {
    // Once, before the first view: what the app's TSX may import, NSH's and the app's own crate.
    set_ui_sets(vec![nsh_base::registry(), deskfolk_app_native::registry()]);
    let bundle = match read_bundle(&config.bundle) {
        Ok(bundle) => bundle,
        Err(why) => {
            eprintln!("deskfolk-nsh: {why}");
            crate::runtime::stop();
            return std::process::ExitCode::FAILURE;
        }
    };
    let options = AppOptions {
        app_id: config.bundle_id.clone(),
        title: config.app_name.clone(),
        size: (1100, 760),
        limits: Limits::standalone(),
        data_dir: Some(config.data_dir.join("nsh")),
        asset_base: config.bundle.parent().map(|dir| AssetBase::Directory(dir.join("assets"))),
        host: crate::launch::channel(&config, 1),
        fps: config.fps,
        ..AppOptions::default()
    };
    // NSH's runner: DPI awareness, OLE, the window made with the options above, its message loop.
    let code = nsh_platform_windows::run_app(AppSource::Bundle(bundle), options);
    crate::runtime::stop();
    code
}

/// Whether the window gets Mica behind the app: Windows 11 22H2 or later, with transparency
/// effects on and a graphics adapter of the hardware's. DWM accepts the backdrop everywhere from
/// 22H2 on but draws it only with both: without them (a server's display controller, a VM with
/// no GPU, transparency effects off) what shows through the app's clear parts is black, under the
/// glass's thin ground, so there the window and the app stay solid. Read once: the window is made
/// composed or not for good. `DESKFOLK_WINDOW_MATERIAL=mica|none` overrides it, to see either look.
pub fn has_material() -> bool {
    static MATERIAL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MATERIAL.get_or_init(|| match std::env::var("DESKFOLK_WINDOW_MATERIAL").as_deref() {
        Ok("mica") => true,
        Ok("none") => false,
        _ => {
            windows_build().is_some_and(|build| build >= SYSTEM_BACKDROP_BUILD)
                && transparency_effects()
                && hardware_adapter()
        }
    })
}

fn read_bundle(path: &Path) -> Result<Bundle, String> {
    // SAFETY: the bundle is this app's own build output (`nsh build`), named on our command line.
    let bundle = unsafe { Bundle::read_trusted(path) }.map_err(|e| format!("cannot read bundle {}: {e}", path.display()))?;
    Ok(bundle.with_main_window(Some(&main_window(has_material()).to_string())))
}

/// The main window's launch options on Windows (`nsh.json` `"window"`'s shape).
fn main_window(material: bool) -> serde_json::Value {
    json!({
        "titleBar": { "style": "hidden" },
        "backdrop": if material { "window" } else { "none" },
    })
}

/// The running system's build number (`CurrentBuildNumber`; `GetVersionEx` answers 8 to an
/// executable without a compatibility manifest).
fn windows_build() -> Option<u32> {
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::w;
    let mut buffer = [0u16; 16];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the value is written into a local buffer of the size given.
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let text = String::from_utf16_lossy(&buffer);
    text.trim_end_matches('\0').trim().parse().ok()
}

/// Settings › Personalisation › Colours › Transparency effects (on when the value is missing).
fn transparency_effects() -> bool {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    use windows::core::w;
    let mut value = 1u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: a DWORD written into a local of its size.
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("EnableTransparency"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
    };
    read.is_err() || value != 0
}

/// Whether a graphics adapter of the hardware's is there: one not flagged software and not the
/// Microsoft Basic Render Driver (vendor 0x1414, device 0x8c), which DWM falls back to without one.
fn hardware_adapter() -> bool {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    // SAFETY: plain DXGI queries; the descriptions are returned by value.
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return false;
        };
        (0..).map_while(|i| factory.EnumAdapters1(i).ok()).any(|adapter| {
            adapter.GetDesc1().is_ok_and(|desc| {
                let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
                let basic_render = desc.VendorId == 0x1414 && desc.DeviceId == 0x8c;
                !software && !basic_render
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_hides_its_title_bar_and_asks_for_mica_only_where_there_is_some() {
        assert_eq!(main_window(true), json!({ "titleBar": { "style": "hidden" }, "backdrop": "window" }));
        assert_eq!(main_window(false)["backdrop"], "none");
        assert_eq!(main_window(false)["titleBar"]["style"], "hidden");
    }

    #[test]
    fn the_launch_options_are_ones_nsh_reads() {
        for material in [true, false] {
            assert!(nsh_core::desktop::MainWindowOptions::from_json(&main_window(material)).is_ok());
        }
    }

    #[test]
    fn this_system_has_a_build_number() {
        assert!(windows_build().is_some_and(|build| build >= 10240));
    }
}
