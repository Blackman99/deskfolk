mod daemon;
mod handoff;
mod installer;
mod launchd;
mod local_api;
pub(crate) mod notifications;
#[cfg(target_os = "macos")]
pub(crate) mod notifications_macos;
mod remote_native;
mod remote_setup;
mod supervisor;
mod updates;
mod window_state;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use installer::{InstallState, Installer, Phase};
use local_api::{endpoint_from_descriptor, probe_bind, stop_latch_present, BIND_PORT};
use supervisor::{launched_hidden, Action, Endpoint, Probe, QuitPlan, Supervisor};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalSize, RunEvent, Window, WindowEvent};
use updates::UpdateCheck;

struct AppState {
    supervisor: Supervisor,
    daemon: Option<std::process::Child>,
    stop_item: Option<MenuItem<tauri::Wry>>,
    quitting: bool,
    independent_bootstrapped: bool,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct LocalApiEndpoint {
    pub(crate) origin: String,
    pub(crate) token: String,
}

pub(crate) fn read_endpoint(state: &AppState) -> Option<LocalApiEndpoint> {
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

fn expand_home(raw: &str) -> std::path::PathBuf {
    if raw == "~" || raw.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            if raw == "~" {
                return std::path::PathBuf::from(home);
            }
            let mut path = std::path::PathBuf::from(home);
            path.push(&raw[2..]);
            return path;
        }
    }
    std::path::PathBuf::from(raw)
}

fn starting_directory(current: Option<&str>) -> Option<std::path::PathBuf> {
    let raw = current?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = expand_home(raw);
    if path.is_dir() {
        return Some(path);
    }
    let parent = path.parent()?;
    if parent.is_dir() && !parent.as_os_str().is_empty() {
        return Some(parent.to_path_buf());
    }
    None
}

#[tauri::command]
async fn pick_workspace_folder(
    app: AppHandle,
    current: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Choose folder")
        .to_string();
    app.run_on_main_thread(move || {
        let mut dialog = rfd::AsyncFileDialog::new()
            .set_title(&title)
            .set_can_create_directories(true);
        if let Some(dir) = starting_directory(current.as_deref()) {
            dialog = dialog.set_directory(dir);
        }
        let fut = dialog.pick_folder();
        std::thread::spawn(move || {
            let picked = tauri::async_runtime::block_on(fut);
            let _ = tx.send(picked.map(|handle| handle.path().to_string_lossy().into_owned()));
        });
    })
    .map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
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

/// Put the window away, the way the close button does. The messenger asks for this when ⌘W finds
/// no tab left to close, so 关窗 still means 隐藏到托盘 rather than quitting.
#[tauri::command]
fn hide_main_window(app: AppHandle) {
    persist_main_window(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_for_update(app: AppHandle, force: bool) -> Result<UpdateCheck, String> {
    let fresh = {
        let state = app.state::<Mutex<updates::UpdateCache>>();
        let cache = state
            .lock()
            .map_err(|_| "update cache poisoned".to_string())?;
        cache.fresh(Instant::now(), updates::CACHE_TTL)
    };
    if !force {
        if let Some(fresh) = fresh {
            return Ok(fresh);
        }
    }

    let current = app.package_info().version.clone();
    let user_agent = format!("real-bot-desktop/{current}");
    let url = updates::feed_url();
    let arch = updates::arch_tag();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<UpdateCheck, String> {
        let releases = updates::fetch_releases(&url, &user_agent)?;
        Ok(updates::pick_update(&current, &releases, arch))
    })
    .await
    .map_err(|e| e.to_string())??;

    {
        let state = app.state::<Mutex<updates::UpdateCache>>();
        let mut cache = state
            .lock()
            .map_err(|_| "update cache poisoned".to_string())?;
        cache.store(Instant::now(), result.clone());
    }

    Ok(result)
}

fn is_allowed_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed != url || url.is_empty() {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) && !updates::is_allowed_release_url(&url) {
        return Err("url not allowed".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-u")
            .arg(&url)
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
        Err("open with system is only on macOS".into())
    }
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Where a downloaded build would be installed: the `.app` this process is
/// running out of. `not-installed` for a dev build or a bare binary — the
/// About card then falls back to the browser download.
fn installable_bundle() -> Result<PathBuf, String> {
    if tauri::is_dev() {
        return Err("not-installed".into());
    }
    let exe = std::env::current_exe().map_err(|_| "not-installed".to_string())?;
    installer::bundle_root(&exe).ok_or_else(|| "not-installed".to_string())
}

/// Is an in-app install possible at all on this copy? The About card asks
/// before it offers the button, so an unwritable or un-bundled install offers
/// the browser download instead of a button that always fails.
#[tauri::command]
fn can_install_update() -> bool {
    installable_bundle()
        .map(|bundle| installer::can_replace_bundle(&bundle))
        .unwrap_or(false)
}

#[tauri::command]
fn update_install_state(app: AppHandle) -> InstallState {
    app.state::<Installer>().snapshot()
}

/// Cancel a running download, or clear a failed one. The partial `.dmg` is
/// dropped by the download loop when it sees the flag.
#[tauri::command]
fn cancel_update_install(app: AppHandle) -> InstallState {
    let installer = app.state::<Installer>();
    installer.reset();
    installer.snapshot()
}

/// Download `url` and, once it verifies, replace this bundle with what is
/// inside and relaunch. The preflight runs here so a refusal reaches the
/// button press rather than the progress bar.
#[tauri::command]
fn start_update_install(
    app: AppHandle,
    url: String,
    version: String,
) -> Result<InstallState, String> {
    let target = installable_bundle()?;
    if !installer::is_installable_asset_url(&url) {
        return Err("bad-url".into());
    }
    if !installer::can_replace_bundle(&target) {
        return Err("read-only".into());
    }
    let cancel = app.state::<Installer>().begin(&version)?;
    let worker = app.clone();
    std::thread::spawn(move || install_update(worker, url, version, target, cancel));
    Ok(app.state::<Installer>().snapshot())
}

fn update_staging_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("com.real-bot.desktop"))
}

/// Download, mount, verify, stage, swap. Each step reports its phase to the
/// About card and stops on the cancel flag; anything that fails leaves the
/// installed app untouched.
fn install_update(
    app: AppHandle,
    url: String,
    version: String,
    target: PathBuf,
    cancel: Arc<AtomicBool>,
) {
    let state = app.state::<Installer>();
    let paths = installer::staging_paths(&update_staging_dir(&app), &url);
    let _ = std::fs::remove_dir_all(&paths.root);
    if let Err(err) = std::fs::create_dir_all(&paths.root) {
        state.fail("install-failed", err.to_string());
        return;
    }

    let user_agent = format!("real-bot-desktop/{}", app.package_info().version);
    let (body, total) = match installer::open_asset(&url, &user_agent) {
        Ok(opened) => opened,
        Err(err) => return state.fail("download-failed", err),
    };
    state.update(|snapshot| snapshot.total = total);

    let mut last_tick = Instant::now();
    let downloaded = installer::stream_to_file(
        body,
        total,
        &paths.dmg,
        installer::MAX_DOWNLOAD_BYTES,
        |downloaded, total| {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            // The bar moves ten times a second at most; the rest of the chunks
            // would only be lock traffic behind a poll that reads far slower.
            if last_tick.elapsed() >= Duration::from_millis(100) || Some(downloaded) == total {
                last_tick = Instant::now();
                state.update(|snapshot| {
                    snapshot.downloaded = downloaded;
                    snapshot.total = total;
                });
            }
            true
        },
    );
    if let Err(err) = downloaded {
        let _ = std::fs::remove_dir_all(&paths.root);
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        return state.fail("download-failed", err);
    }

    state.advance(Phase::Verifying);
    let mount = match installer::attach_dmg(&paths.dmg, &paths.mount) {
        Ok(mount) => PathBuf::from(mount),
        Err(err) => {
            let _ = std::fs::remove_dir_all(&paths.root);
            return state.fail("verify-failed", err);
        }
    };
    let staged = match stage_from_mount(&app, &state, &version, &mount, &paths, &cancel) {
        Some(staged) => staged,
        None => {
            installer::detach_dmg(&mount);
            let _ = std::fs::remove_dir_all(&paths.root);
            return;
        }
    };
    installer::detach_dmg(&mount);

    state.advance(Phase::Restarting);
    let script = match installer::write_swap_script(&std::env::temp_dir()) {
        Ok(script) => script,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&paths.root);
            return state.fail("install-failed", err);
        }
    };
    if let Err(err) = installer::spawn_swap(&script, &target, &staged, &paths.root) {
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_dir_all(&paths.root);
        return state.fail("install-failed", err);
    }
    // The swap waits for this pid, so the app has to go down the ordinary way:
    // the daemon is told to quit and the window persists its size first.
    begin_quit(&app);
}

/// Check the mounted image and copy the app out of it. `None` means the job
/// stopped — the state carries why, unless the user cancelled.
fn stage_from_mount(
    app: &AppHandle,
    state: &tauri::State<'_, Installer>,
    version: &str,
    mount: &PathBuf,
    paths: &installer::StagingPaths,
    cancel: &Arc<AtomicBool>,
) -> Option<PathBuf> {
    let bundle = match installer::find_app_bundle(mount) {
        Some(bundle) => bundle,
        None => {
            state.fail("verify-failed", "the image holds no .app");
            return None;
        }
    };
    let plist = match installer::read_bundle_plist(&bundle) {
        Ok(plist) => plist,
        Err(err) => {
            state.fail("verify-failed", err);
            return None;
        }
    };
    if let Err(err) = installer::verify_bundle(&plist, &app.config().identifier, version) {
        state.fail("verify-failed", err);
        return None;
    }
    if cancel.load(Ordering::SeqCst) {
        return None;
    }

    state.advance(Phase::Installing);
    let name = bundle.file_name()?;
    let staged = paths.root.join(name);
    if let Err(err) = installer::copy_bundle(&bundle, &staged) {
        state.fail("install-failed", err);
        return None;
    }
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    Some(staged)
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
            independent_bootstrapped: false,
        }))
        .manage(Mutex::new(updates::UpdateCache::default()))
        .manage(remote_native::HelperState::default())
        .manage(Installer::default())
        .manage(notifications::NotificationState::new())
        .invoke_handler(tauri::generate_handler![
            local_api_endpoint,
            pick_workspace_folder,
            open_workspace_path,
            app_version,
            hide_main_window,
            check_for_update,
            open_external_url,
            set_launch_at_login,
            independent_runtime_status,
            independent_runtime,
            remote_native::remote_native_confirmation,
            remote_setup::remote_local_setup,
            can_install_update,
            start_update_install,
            update_install_state,
            cancel_update_install,
            notifications::notification_permission_state,
            notifications::request_notification_permission,
            notifications::take_notification_intent,
            notifications::report_notification_view
        ])
        .setup(|app| {
            install_menus(app.handle())?;
            install_tray(app.handle())?;
            register_login_item(app.handle());
            restore_independent_mode(app.handle(), &local_api::data_dir());
            restore_window_size(app.handle());
            notifications::setup_notifications(app.handle())?;
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
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                persist_current_window(window);
                let _ = window.hide();
                api.prevent_close();
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                persist_current_window(window);
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => begin_quit(app),
            "show" => show_main(app),
            "stop" => request_stop(app),
            // The pane commands belong to the messenger: it holds the arrangement, so it is the
            // only thing that can say what "close this" means right now.
            id if id.starts_with("pane-") => send_pane_command(app, id),
            _ => {}
        })
        .build(app_context())
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
        RunEvent::Exit => {
            app.state::<remote_native::HelperState>().stop();
            app.state::<notifications::NotificationState>().stop();
            persist_main_window(app);
            last_chance_quit(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}

/**
 * Hand a pane command to the messenger.
 *
 * Nothing is decided here: the window does not know how many panes there are or which one the
 * keyboard is in. When ⌘W finds nothing left to close the messenger asks for the window to hide,
 * which is the behaviour 关窗 has always had.
 */
fn send_pane_command(app: &AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("pane-command", id);
    }
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
    let view = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(app, "pane-split-right", "向右分割", true, Some("CmdOrCtrl+\\"))?,
            &MenuItem::with_id(app, "pane-split-down", "向下分割", true, Some("CmdOrCtrl+Shift+\\"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "pane-close", "关闭窗格", true, None::<&str>)?,
            &MenuItem::with_id(app, "pane-equalise", "平分", true, None::<&str>)?,
            &MenuItem::with_id(app, "pane-reset", "重置布局", true, None::<&str>)?,
        ],
    )?;
    // ⌘W closes the tab in front of you. The window still hides to the tray, but only once there
    // is nothing left to close — the webview answers first and asks for the hide itself, so the
    // locked behaviour of 关窗 survives with a step in front of it.
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "pane-close-tab", "关闭标签页", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &view, &window])?)?;
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

#[tauri::command]
fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if tauri::is_dev() {
        return Ok(false);
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        if enabled {
            app.autolaunch().enable().map_err(|err| err.to_string())?;
        } else {
            app.autolaunch().disable().map_err(|err| err.to_string())?;
        }
        return Ok(app.autolaunch().is_enabled().unwrap_or(enabled));
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(enabled)
    }
}

fn independent_policy() -> launchd::IndependentPolicy {
    launchd::IndependentPolicy::production(cfg!(debug_assertions) || tauri::is_dev())
}

#[derive(serde::Deserialize)]
struct IndependentRequest {
    operation: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndependentStatusDto {
    enabled: bool,
    available: bool,
    diagnostic: String,
    supervising: bool,
    writer: String,
    drain: DrainDto,
    error: Option<String>,
    warning: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DrainDto {
    phase: String,
    remaining: Vec<String>,
    forced: bool,
}

fn writer_label(writer: handoff::Writer) -> String {
    match writer {
        handoff::Writer::Window => "window".into(),
        handoff::Writer::Agent => "agent".into(),
        handoff::Writer::Down => "down".into(),
    }
}

fn snapshot_independent_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    error: Option<String>,
    warning: Option<String>,
) -> IndependentStatusDto {
    let policy = independent_policy();
    let probe = probe_bind(BIND_PORT);
    let marker = local_api::data_dir().join(launchd::MARKER_NAME);
    let supervising = is_supervising(app);
    let state = app.state::<Mutex<AppState>>();
    let snapshot = {
        let locked = state.lock();
        match locked {
            Ok(guard) => handoff::status(
                &guard.supervisor,
                handoff::DrainState {
                    phase: handoff::DrainPhase::Running,
                    remaining: Vec::new(),
                    forced: false,
                },
                &policy,
                probe,
                marker,
                error.clone(),
            ),
            Err(_) => handoff::HandoffStatus {
                enabled: false,
                available: policy.available,
                diagnostic: policy.diagnostic.clone(),
                supervising,
                drain: handoff::DrainState {
                    phase: handoff::DrainPhase::Running,
                    remaining: Vec::new(),
                    forced: false,
                },
                writer: handoff::Writer::Down,
                error: error.clone(),
            },
        }
    };
    IndependentStatusDto {
        enabled: snapshot.enabled,
        available: snapshot.available,
        diagnostic: snapshot.diagnostic,
        supervising: snapshot.supervising,
        writer: writer_label(snapshot.writer),
        drain: DrainDto {
            phase: match snapshot.drain.phase {
                handoff::DrainPhase::Running => "running".into(),
                handoff::DrainPhase::Draining => "draining".into(),
                handoff::DrainPhase::Drained => "drained".into(),
            },
            remaining: snapshot.drain.remaining,
            forced: snapshot.drain.forced,
        },
        error: snapshot.error.or(error),
        warning,
    }
}

#[tauri::command]
fn independent_runtime_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<IndependentStatusDto, String> {
    Ok(snapshot_independent_status(&app, None, None))
}

fn independent_runtime_op<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: IndependentRequest,
) -> Result<IndependentStatusDto, String> {
    let policy = independent_policy();
    match request.operation.as_str() {
        "enable" | "wait" | "force" => {
            let reason = handoff::refuse_unqualified_enable(&policy)
                .err()
                .unwrap_or_else(|| "g_pack_not_verified".into());
            Ok(snapshot_independent_status(&app, Some(reason), None))
        }
        "disable" => {
            recover_stale_independent_marker(&app);
            let reason = handoff::refuse_unqualified_enable(&policy)
                .err()
                .unwrap_or_else(|| "g_pack_not_verified".into());
            Ok(snapshot_independent_status(&app, Some(reason), None))
        }
        "cancel" => {
            restore_window_supervision_unless_adopted(&app);
            Ok(snapshot_independent_status(&app, None, None))
        }
        _ => Err("malformed".into()),
    }
}

#[tauri::command]
fn independent_runtime<R: tauri::Runtime>(
    _caller: remote_native::BundledNativeCaller,
    app: tauri::AppHandle<R>,
    request: IndependentRequest,
) -> Result<IndependentStatusDto, String> {
    independent_runtime_op(app, request)
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn window_state_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(".").join("real-bot-window"))
}

fn restore_window_size(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let size = window_state::load(&window_state_dir(app));
    let _ = window.set_min_size(Some(LogicalSize::new(
        window_state::MIN_WIDTH,
        window_state::MIN_HEIGHT,
    )));
    let _ = window.set_size(LogicalSize::new(size.width, size.height));
    if size.maximized {
        let _ = window.maximize();
    }
    window_state::mark_ready();
}

fn persist_current_window(window: &Window) {
    let Ok(physical) = window.inner_size() else {
        return;
    };
    persist_window_size(
        window.app_handle(),
        physical,
        window.scale_factor().unwrap_or(1.0),
        window.is_minimized().unwrap_or(false),
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false),
    );
}

fn persist_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(physical) = window.inner_size() else {
        return;
    };
    persist_window_size(
        app,
        physical,
        window.scale_factor().unwrap_or(1.0),
        window.is_minimized().unwrap_or(false),
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false),
    );
}

fn persist_window_size(
    app: &AppHandle,
    physical: PhysicalSize<u32>,
    scale: f64,
    minimized: bool,
    zoomed: bool,
) {
    if !window_state::is_ready() || minimized {
        return;
    }
    let dir = window_state_dir(app);
    let previous = window_state::load(&dir);
    let size = window_state::snapshot(physical.width, physical.height, scale, zoomed, &previous);
    let _ = window_state::save(&dir, &size);
}

fn tick(app: &AppHandle) {
    let data_dir = local_api::data_dir();
    restore_independent_mode(app, &data_dir);
    if is_supervising(app) && !independent_mode_adopted(app, &data_dir) {
        let _ = local_api::clear_stop_latch(&data_dir);
    }
    let desc = local_api::read_descriptor(&data_dir);
    let holder_alive = desc
        .as_ref()
        .map(|d| local_api::pid_alive(d.pid))
        .unwrap_or(false);
    let probe = probe_bind(BIND_PORT);
    let endpoint = if probe == Probe::Ours {
        desc.map(|d| endpoint_from_descriptor(&d))
    } else {
        None
    };
    let state = app.state::<Mutex<AppState>>();
    let should_spawn = apply_probe(&state, probe, endpoint, holder_alive, |item, connected| {
        if let Some(item) = item {
            let _ = item.set_enabled(connected);
        }
    });
    let latched = stop_latch_present(&data_dir);
    if should_spawn && !latched && probe_bind(BIND_PORT) == Probe::Down {
        let child = app
            .path()
            .resource_dir()
            .ok()
            .and_then(|dir| daemon::spawn(&dir));
        adopt_spawned_daemon(app, child);
    }
}

fn independent_adoption<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> (launchd::IndependentPolicy, bool, bool) {
    let policy = independent_policy();
    let bootstrapped = is_independent_bootstrapped(app);
    let agent_loaded = policy.available && launchd::agent_loaded_in_gui_domain();
    (policy, bootstrapped, agent_loaded)
}

fn independent_mode_adopted<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    data_dir: &std::path::Path,
) -> bool {
    let marker = data_dir.join(launchd::MARKER_NAME);
    let (policy, bootstrapped, agent_loaded) = independent_adoption(app);
    launchd::adopt_independent_marker(&policy, &marker, bootstrapped, agent_loaded)
}

fn restore_independent_mode<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    data_dir: &std::path::Path,
) {
    let marker = data_dir.join(launchd::MARKER_NAME);
    let (policy, bootstrapped, agent_loaded) = independent_adoption(app);
    let state = app.state::<Mutex<AppState>>();
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let _ = handoff::restore_independent_mode(
        &mut guard.supervisor,
        &policy,
        &marker,
        bootstrapped,
        agent_loaded,
    );
}

fn recover_stale_independent_marker<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let data_dir = local_api::data_dir();
    let marker = data_dir.join(launchd::MARKER_NAME);
    if independent_mode_adopted(app, &data_dir) {
        return;
    }
    let state = app.state::<Mutex<AppState>>();
    if let Ok(mut guard) = state.lock() {
        guard.supervisor.set_supervising(true);
        guard.independent_bootstrapped = false;
    };
    let _ = launchd::remove_file_if_exists(&marker);
    let _ = launchd::remove_file_if_exists(&data_dir.join(launchd::PLIST_NAME));
}

fn restore_window_supervision_unless_adopted<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let data_dir = local_api::data_dir();
    if independent_mode_adopted(app, &data_dir) {
        return;
    }
    let state = app.state::<Mutex<AppState>>();
    if let Ok(mut guard) = state.lock() {
        guard.supervisor.set_supervising(true);
    };
}

fn is_independent_bootstrapped<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let state = app.state::<Mutex<AppState>>();
    state
        .lock()
        .map(|s| s.independent_bootstrapped)
        .unwrap_or(false)
}

/// Update supervisor under the lock, then call `set_menu` after release.
/// Tauri `MenuItem::set_enabled` waits on the UI thread, which locks AppState.
fn apply_probe(
    state: &Mutex<AppState>,
    probe: Probe,
    endpoint: Option<Endpoint>,
    holder_alive: bool,
    set_menu: impl FnOnce(Option<MenuItem<tauri::Wry>>, bool),
) -> bool {
    let mut should_spawn = false;
    let (stop_item, connected) = {
        let mut state = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if state.quitting {
            return false;
        }
        let supervising = state.supervisor.is_supervising();
        let action = state.supervisor.on_probe(probe, holder_alive);
        if probe == Probe::Ours {
            if let Some(endpoint) = endpoint {
                state.supervisor.remember(endpoint);
            }
        }
        if supervising && action == Action::Spawn {
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

fn is_supervising<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
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
    persist_main_window(app);
    app.state::<notifications::NotificationState>().stop();
    let state = app.state::<Mutex<AppState>>();
    let (plan, child, was_supervising) = {
        let mut state = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if state.quitting {
            return;
        }
        state.quitting = true;
        let was_supervising = state.supervisor.is_supervising();
        (
            state.supervisor.quit(),
            state.daemon.take(),
            was_supervising,
        )
    };
    let plan = match plan {
        QuitPlan::JustExit if was_supervising => descriptor_quit_fallback(),
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
            independent_bootstrapped: false,
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
    fn starting_directory_prefers_an_existing_folder() {
        let dir = std::env::temp_dir();
        assert_eq!(
            starting_directory(Some(dir.to_str().unwrap())),
            Some(dir.clone())
        );
        assert_eq!(starting_directory(Some("")), None);
        assert_eq!(starting_directory(None), None);
        let nested = dir.join("real-bot-missing-workspace-picker");
        assert_eq!(
            starting_directory(Some(nested.to_str().unwrap())),
            Some(dir)
        );
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(
                starting_directory(Some("~")),
                Some(std::path::PathBuf::from(home))
            );
        }
    }

    #[test]
    fn is_allowed_external_url_validates_scheme_and_rejects_unsafe() {
        assert!(is_allowed_external_url("https://example.com"));
        assert!(is_allowed_external_url("http://example.com/path?q=1#frag"));
        assert!(is_allowed_external_url("mailto:dev@real-bot.local"));
        assert!(!is_allowed_external_url("file:///etc/passwd"));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("data:text/html,x"));
        assert!(!is_allowed_external_url(""));
        assert!(!is_allowed_external_url("   https://example.com"));
        assert!(!is_allowed_external_url("https://example.com   "));
        assert!(!is_allowed_external_url("https://example.com\nevil"));
        assert!(!is_allowed_external_url("https://example.com evil"));
    }

    #[test]
    fn apply_probe_releases_lock_before_menu_callback() {
        let state = test_state();
        let mut menu_called = false;
        let should_spawn = apply_probe(&state, Probe::Down, None, false, |item, connected| {
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
        let should_spawn = apply_probe(&state, Probe::Ours, None, false, |_item, connected| {
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
            false,
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
    fn apply_probe_down_while_holder_alive_does_not_spawn() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "tok"));
        let mut menu_called = false;
        let should_spawn = apply_probe(&state, Probe::Down, None, true, |_, connected| {
            menu_called = true;
            assert!(!connected);
            assert_main_thread_can_read(&state, false);
        });
        assert!(menu_called);
        assert!(!should_spawn);
        assert!(!state.lock().unwrap().supervisor.is_connected());
    }

    #[test]
    fn apply_probe_occupied_clears_endpoint_without_spawn() {
        let state = test_state();
        state
            .lock()
            .unwrap()
            .supervisor
            .remember(Endpoint::new(17890, "tok"));
        let should_spawn = apply_probe(
            &state,
            Probe::OccupiedByOther,
            None,
            false,
            |_item, connected| {
                assert!(!connected);
                assert_main_thread_can_read(&state, false);
            },
        );
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
        state.lock().unwrap().quitting = true;
        assert!(matches!(plan, QuitPlan::PostThenExit { .. }));
        let mut menu_called = false;
        let should_spawn = apply_probe(&state, Probe::Down, None, false, |_, _| {
            menu_called = true;
        });
        assert!(!should_spawn);
        assert!(!menu_called);
        let guard = state.lock().unwrap();
        assert!(!guard.supervisor.is_supervising());
        assert!(!guard.supervisor.is_connected());
    }

    #[test]
    fn apply_probe_while_independent_tracks_the_agent_without_spawning() {
        let state = test_state();
        state.lock().unwrap().supervisor.set_supervising(false);
        let should_spawn = apply_probe(
            &state,
            Probe::Ours,
            Some(Endpoint::new(17890, "agent")),
            true,
            |_, connected| {
                assert!(connected);
                assert_main_thread_can_read(&state, true);
            },
        );
        assert!(!should_spawn);
        assert!(state.lock().unwrap().supervisor.is_connected());
        let down = apply_probe(&state, Probe::Down, None, false, |_, connected| {
            assert!(!connected);
        });
        assert!(!down);
    }

    struct IndependentRuntimeCaller;
    impl<'a, R: tauri::Runtime> tauri::ipc::CommandArg<'a, R> for IndependentRuntimeCaller {
        fn from_command(
            command: tauri::ipc::CommandItem<'a, R>,
        ) -> Result<Self, tauri::ipc::InvokeError> {
            remote_native::BundledNativeCaller::from_item(command, false).map(|_| Self)
        }
    }

    #[tauri::command]
    fn independent_runtime_release_fixture<R: tauri::Runtime>(
        _caller: IndependentRuntimeCaller,
        app: tauri::AppHandle<R>,
        request: IndependentRequest,
    ) -> Result<IndependentStatusDto, String> {
        independent_runtime_op(app, request)
    }

    #[test]
    fn independent_runtime_mutators_use_bundled_frame_acl() {
        use serde_json::json;
        use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
        let mut context = crate::app_context();
        context.config_mut().app.windows.clear();
        for command in [
            "independent_runtime_status",
            "independent_runtime_release_fixture",
            "independent_runtime",
        ] {
            context
                .runtime_authority_mut()
                .__allow_command(command.into(), tauri::utils::acl::ExecutionContext::Local);
        }
        let app = mock_builder()
            .manage(test_state())
            .invoke_handler(tauri::generate_handler![
                independent_runtime_status,
                independent_runtime_release_fixture,
                independent_runtime
            ])
            .build(context)
            .unwrap();
        let bundled = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("tauri://localhost/index.html".parse().unwrap()),
        )
        .build()
        .unwrap();
        let invoke = |command: &str, frame: &str, operation: Option<&str>| {
            let body = match operation {
                Some(operation) => json!({ "request": { "operation": operation } }),
                None => json!({}),
            };
            get_ipc_response(
                &bundled,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: frame.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        };
        let status = invoke(
            "independent_runtime_status",
            "tauri://localhost/index.html",
            None,
        )
        .expect("status from bundled main");
        let status: serde_json::Value = match status {
            tauri::ipc::InvokeResponseBody::Json(body) => serde_json::from_str(&body).unwrap(),
            other => panic!("expected json status, got {other:?}"),
        };
        assert_eq!(status["available"], json!(false));
        assert_eq!(status["supervising"], json!(true));
        assert!(invoke(
            "independent_runtime",
            "tauri://localhost/index.html",
            Some("enable")
        )
        .is_err());
        for operation in ["enable", "wait", "force", "disable", "cancel"] {
            let ok = invoke(
                "independent_runtime_release_fixture",
                "tauri://localhost/index.html",
                Some(operation),
            );
            assert!(ok.is_ok(), "{operation}: {ok:?}");
        }
        for frame in [
            "blob:tauri://localhost/fixture",
            "about:srcdoc",
            "https://evil.example/",
        ] {
            assert!(
                invoke("independent_runtime_release_fixture", frame, Some("enable")).is_err(),
                "{frame}"
            );
        }
        bundled
            .navigate("http://localhost:5173/".parse().unwrap())
            .unwrap();
        for operation in ["enable", "wait", "force", "disable", "cancel"] {
            assert!(
                invoke(
                    "independent_runtime_release_fixture",
                    "http://localhost:5173/",
                    Some(operation)
                )
                .is_err(),
                "{operation}"
            );
            assert!(
                invoke(
                    "independent_runtime",
                    "http://localhost:5173/",
                    Some(operation)
                )
                .is_err(),
                "{operation}"
            );
        }
    }
}
