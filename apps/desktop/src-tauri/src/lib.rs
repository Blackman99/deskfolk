mod daemon;
mod local_api;
mod supervisor;

use std::sync::Mutex;
use std::time::Duration;

use local_api::{endpoint_from_descriptor, probe_bind, BIND_PORT};
use supervisor::{launched_hidden, Action, Endpoint, Probe, QuitPlan, Supervisor};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

struct AppState {
    supervisor: Supervisor,
    daemon: Option<std::process::Child>,
    stop_item: Option<MenuItem<tauri::Wry>>,
    quitting: bool,
}

#[derive(serde::Serialize, Clone)]
struct LocalApiEndpoint {
    origin: String,
    token: String,
}

fn read_endpoint(state: &AppState) -> Option<LocalApiEndpoint> {
    state.supervisor.endpoint().map(|ep| LocalApiEndpoint {
        origin: ep.origin.clone(),
        token: ep.token.clone(),
    })
}

#[tauri::command]
fn local_api_endpoint(state: tauri::State<'_, Mutex<AppState>>) -> Option<LocalApiEndpoint> {
    let guard = state.lock().ok()?;
    read_endpoint(&guard)
}

#[tauri::command]
fn open_workspace_path(path: String, reveal: bool) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    if !target.exists() {
        return Err("path does not exist".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(&path)
            .status()
            .map_err(|err| err.to_string())
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("open failed".into())
                }
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reveal;
        Err("open with system is only on macOS".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
        let mut autostart = tauri_plugin_autostart::Builder::new()
            .args(["--hidden"])
            .app_name("Real Bot");
        #[cfg(target_os = "macos")]
        {
            autostart =
                autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::AppleScript);
        }
        builder = builder.plugin(autostart.build());
    }

    let app = builder
        .manage(Mutex::new(AppState {
            supervisor: Supervisor::new(),
            daemon: None,
            stop_item: None,
            quitting: false,
        }))
        .invoke_handler(tauri::generate_handler![local_api_endpoint, open_workspace_path])
        .setup(|app| {
            install_menus(app.handle())?;
            install_tray(app.handle())?;
            register_login_item(app.handle());
            if !launched_hidden(&std::env::args().collect::<Vec<_>>()) {
                show_main(app.handle());
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                tick(&handle);
                std::thread::sleep(Duration::from_millis(800));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => begin_quit(app),
            "show" => show_main(app),
            "stop" => request_stop(app),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Real Bot");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_some() {
                return;
            }
            if is_supervising(app) {
                api.prevent_exit();
                begin_quit(app);
            }
        }
        RunEvent::Exit => last_chance_quit(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}

fn install_menus(app: &AppHandle) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, None, None)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Real Bot", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Real Bot",
        true,
        &[&about, &sep, &hide, &hide_others, &sep, &quit],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &window])?)?;
    Ok(())
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon");

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(false)
        .tooltip("Real Bot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    let state = app.state::<Mutex<AppState>>();
    if let Ok(mut state) = state.lock() {
        state.stop_item = Some(stop);
    }
    Ok(())
}

fn register_login_item(app: &AppHandle) {
    if tauri::is_dev() {
        return;
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let _ = app.autolaunch().enable();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn tick(app: &AppHandle) {
    let probe = probe_bind(BIND_PORT);
    let endpoint = if probe == Probe::Ours {
        local_api::read_descriptor(&local_api::data_dir())
            .map(|desc| endpoint_from_descriptor(&desc))
    } else {
        None
    };
    let state = app.state::<Mutex<AppState>>();
    let should_spawn = apply_probe(&state, probe, endpoint, |item, connected| {
        if let Some(item) = item {
            let _ = item.set_enabled(connected);
        }
    });
    if should_spawn && probe_bind(BIND_PORT) == Probe::Down {
        let child = daemon::spawn();
        adopt_spawned_daemon(app, child);
    }
}

/// Update supervisor under the lock, then call `set_menu` after release.
/// Tauri `MenuItem::set_enabled` waits on the UI thread, which locks AppState.
fn apply_probe(
    state: &Mutex<AppState>,
    probe: Probe,
    endpoint: Option<Endpoint>,
    set_menu: impl FnOnce(Option<MenuItem<tauri::Wry>>, bool),
) -> bool {
    let mut should_spawn = false;
    let (stop_item, connected) = {
        let mut state = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if !state.supervisor.is_supervising() {
            return false;
        }
        let action = state.supervisor.on_probe(probe);
        if probe == Probe::Ours {
            if let Some(endpoint) = endpoint {
                state.supervisor.remember(endpoint);
            }
        }
        if action == Action::Spawn {
            let alive = state
                .daemon
                .as_mut()
                .map(daemon::child_alive)
                .unwrap_or(false);
            should_spawn = !alive;
        }
        (state.stop_item.clone(), state.supervisor.is_connected())
    };
    // Menu updates wait for the main thread, which also reads AppState.
    set_menu(stop_item, connected);
    should_spawn
}

fn is_supervising(app: &AppHandle) -> bool {
    let state = app.state::<Mutex<AppState>>();
    state
        .lock()
        .map(|s| s.supervisor.is_supervising())
        .unwrap_or(false)
}

fn last_chance_quit(app: &AppHandle) {
    if !is_supervising(app) {
        return;
    }
    if let QuitPlan::PostThenExit { origin, token } = descriptor_quit_fallback() {
        let _ = local_api::post_quit(&Endpoint { origin, token });
    }
}

fn adopt_spawned_daemon(app: &AppHandle, child: Option<std::process::Child>) {
    let state = app.state::<Mutex<AppState>>();
    let mut state = match state.lock() {
        Ok(guard) => guard,
        Err(_) => {
            if let Some(mut child) = child {
                let _ = child.kill();
            }
            return;
        }
    };
    if state.supervisor.is_supervising() {
        state.daemon = child;
    } else if let Some(mut child) = child {
        let _ = child.kill();
    }
}

fn request_stop(app: &AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let endpoint = state
        .lock()
        .ok()
        .and_then(|s| s.supervisor.endpoint().cloned());
    if let Some(endpoint) = endpoint {
        std::thread::spawn(move || {
            let _ = local_api::post_stop(&endpoint);
        });
    }
}

fn begin_quit(app: &AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let (plan, child) = {
        let mut state = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if state.quitting {
            return;
        }
        state.quitting = true;
        (state.supervisor.quit(), state.daemon.take())
    };
    let plan = match plan {
        QuitPlan::JustExit => descriptor_quit_fallback(),
        other => other,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if let QuitPlan::PostThenExit { origin, token } = plan {
            let _ = local_api::post_quit(&Endpoint { origin, token });
        }
        if let Some(mut child) = child {
            let _ = child.try_wait();
            std::thread::sleep(Duration::from_millis(200));
            if daemon::child_alive(&mut child) {
                let _ = child.kill();
            }
        }
        app.exit(0);
    });
}

fn descriptor_quit_fallback() -> QuitPlan {
    let Some(desc) = local_api::read_descriptor(&local_api::data_dir()) else {
        return QuitPlan::JustExit;
    };
    let endpoint = endpoint_from_descriptor(&desc);
    if probe_bind(desc.port) == Probe::Ours {
        QuitPlan::PostThenExit {
            origin: endpoint.origin,
            token: endpoint.token,
        }
    } else {
        QuitPlan::JustExit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> Mutex<AppState> {
        Mutex::new(AppState {
            supervisor: Supervisor::new(),
            daemon: None,
            stop_item: None,
            quitting: false,
        })
    }

    /// `MenuItem::set_enabled` waits on the UI thread, which then locks AppState
    /// for `local_api_endpoint` / Stop / Quit. The callback must not run under
    /// that lock.
    fn assert_main_thread_can_read(state: &Mutex<AppState>, connected: bool) {
        let guard = state
            .try_lock()
            .expect("main-thread IPC must acquire AppState during menu update");
        assert_eq!(guard.supervisor.is_connected(), connected);
        assert_eq!(read_endpoint(&guard).is_some(), connected);
        assert!(!guard.quitting);
    }

    #[test]
    fn apply_probe_releases_lock_before_menu_callback() {
        let state = test_state();
        let mut menu_called = false;
        let should_spawn = apply_probe(&state, Probe::Down, None, |item, connected| {
            menu_called = true;
            assert!(item.is_none());
            assert!(!connected);
            assert_main_thread_can_read(&state, false);
        });
        assert!(menu_called);
        assert!(should_spawn);
        let guard = state.lock().unwrap();
        assert!(guard.supervisor.is_supervising());
        assert!(!guard.supervisor.is_connected());
    }

    #[test]
    fn apply_probe_ours_keeps_endpoint_and_does_not_spawn() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "tok"));
        let mut menu_connected = None;
        let should_spawn = apply_probe(&state, Probe::Ours, None, |_item, connected| {
            menu_connected = Some(connected);
            assert_main_thread_can_read(&state, true);
            let guard = state.try_lock().expect("Stop/Quit must acquire AppState");
            let ep = read_endpoint(&guard).expect("endpoint");
            assert_eq!(ep.origin, "http://127.0.0.1:17890");
            assert_eq!(ep.token, "tok");
        });
        assert_eq!(menu_connected, Some(true));
        assert!(!should_spawn);
        assert!(state.lock().unwrap().supervisor.is_connected());
    }

    #[test]
    fn apply_probe_ours_refreshes_endpoint_before_menu_update() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "old"));
        let should_spawn = apply_probe(
            &state,
            Probe::Ours,
            Some(Endpoint::new(17890, "new")),
            |_, connected| {
                assert!(connected);
                let guard = state
                    .try_lock()
                    .expect("IPC can read the refreshed endpoint");
                assert_eq!(read_endpoint(&guard).unwrap().token, "new");
            },
        );
        assert!(!should_spawn);
    }

    #[test]
    fn apply_probe_occupied_clears_endpoint_without_spawn() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "tok"));
        let should_spawn = apply_probe(&state, Probe::OccupiedByOther, None, |_item, connected| {
            assert!(!connected);
            assert_main_thread_can_read(&state, false);
        });
        assert!(!should_spawn);
        assert!(!state.lock().unwrap().supervisor.is_connected());
    }

    #[test]
    fn apply_probe_after_quit_does_not_spawn_or_update_menu() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "tok"));
        let plan = state.lock().unwrap().supervisor.quit();
        assert!(matches!(plan, QuitPlan::PostThenExit { .. }));
        let mut menu_called = false;
        let should_spawn = apply_probe(&state, Probe::Down, None, |_, _| {
            menu_called = true;
        });
        assert!(!should_spawn);
        assert!(!menu_called);
        let guard = state.lock().unwrap();
        assert!(!guard.supervisor.is_supervising());
        assert!(!guard.supervisor.is_connected());
    }
}
