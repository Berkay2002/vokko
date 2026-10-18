#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod appicon;
mod appinfo;
mod crash;
mod games;
mod links;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod native_voice;
mod notifications;
mod overlay;
mod popups;
mod prefs;
mod sharebar;
mod shortcuts;
mod spotify;
mod streamer;
mod tray;
mod updates;
mod window;

use prefs::{AUTOSTART_ARG, DesktopPrefs, PrefsPatch, PrefsStore};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt as _;
use vokko_engine::Session;
use vokko_platform::{app_dirs, logging};
use vokko_protocol::CommandRequest;

#[tauri::command]
fn dispatch(request: CommandRequest, session: State<'_, Mutex<Session>>) -> Result<serde_json::Value, String> {
    let mut session = session.lock().map_err(|_| "session unavailable; please restart Vokko".to_owned())?;
    session.dispatch(request).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_get_prefs(store: State<'_, PrefsStore>) -> DesktopPrefs {
    store.get()
}

#[tauri::command]
fn desktop_set_prefs(store: State<'_, PrefsStore>, patch: PrefsPatch) -> Result<DesktopPrefs, String> {
    store.update(patch)
}

/// Whether Vokko is registered to start with the OS.
#[tauri::command]
fn desktop_autostart_status(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|error| error.to_string())?;
    launcher.is_enabled().map_err(|error| error.to_string())
}

/// Shows or clears the unread dot on the tray icon.
#[tauri::command]
fn desktop_set_unread(app: AppHandle, unread: bool) -> Result<(), String> {
    tray::set_unread(&app, unread)
}

/// Creates the main window from its tauri.conf.json entry (`create: false` there), so start-up preferences can shape it.
fn create_main_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = app.config().app.windows.iter().find(|window| window.label == window::MAIN_WINDOW).cloned() else {
        return Err("tauri.conf.json has no main window".into());
    };
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?.on_new_window(popups::on_new_window);
    // Settings > Advanced > hardware acceleration off: WebView2 renders without the GPU (Tauri's default flags kept).
    #[cfg(windows)]
    let builder = if app.state::<PrefsStore>().get().hardware_acceleration {
        builder
    } else {
        builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --disable-gpu-compositing")
    };
    builder.build()?;
    Ok(())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    create_main_window(&handle)?;
    if let Err(error) = tray::install(&handle) {
        // Without a tray the window must stay closable: close-to-tray checks TrayState.
        log::warn!("tray icon unavailable: {error}");
    }

    // Links that started this process (cold start), then links forwarded later (second instance, macOS open-url).
    let deep_link = app.deep_link();
    // The .deb's .desktop file registers vokko://; an AppImage has no installer, so it registers itself (~/.local/share/applications).
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some()
        && let Err(error) = deep_link.register_all()
    {
        log::warn!("vokko:// scheme not registered: {error}");
    }
    if let Ok(Some(urls)) = deep_link.get_current() {
        for url in urls {
            links::handle_url(&handle, url.as_str());
        }
    }
    let link_handle = handle.clone();
    deep_link.on_open_url(move |event| {
        for url in event.urls() {
            links::handle_url(&link_handle, url.as_str());
        }
    });

    window::use_custom_controls(&handle);
    notifications::install(&handle);

    let autostarted = std::env::args().any(|arg| arg == AUTOSTART_ARG);
    let stay_hidden = autostarted && handle.state::<PrefsStore>().get().start_minimized && handle.state::<tray::TrayState>().present();
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::install(&handle) {
        log::warn!("macOS menu bar unavailable: {error}");
    }

    if !stay_hidden {
        window::show_main(&handle);
    }

    #[cfg(debug_assertions)]
    debug_popup_tray_menu(&handle);
    Ok(())
}

/// Debug builds only: `VOKKO_DEBUG_TRAY_MENU=1` pops the tray menu up over the window so it can be screenshotted
/// (the real tray menu can't be opened from a script).
#[cfg(debug_assertions)]
fn debug_popup_tray_menu(app: &AppHandle) {
    if std::env::var_os("VOKKO_DEBUG_TRAY_MENU").is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            use tauri::menu::ContextMenu as _;
            let Some(window) = inner.get_webview_window(window::MAIN_WINDOW) else {
                return;
            };
            if let Ok(menu) = tray::build_menu(&inner) {
                let _ = menu.popup_at(window.as_ref().window(), tauri::LogicalPosition::new(40.0, 40.0));
            }
        });
    });
}

fn run_event(app: &AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    macos::on_run_event(app, &event);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let logger = logging::install();
    let config_dir = app_dirs::config_dir();
    if let Some(dir) = &config_dir
        && let Some(logger) = logger
        && let Err(error) = logger.attach_dir(&dir.join("logs"))
    {
        eprintln!("Vokko: {error}");
    }
    crash::install(config_dir.clone());
    log::info!("starting Vokko local scaffold");

    let context = tauri::generate_context!();
    // The updater plugin refuses to start without its config, so it is only registered when the build provides it.
    let updater_configured = context.config().plugins.0.contains_key(updates::CONFIG_KEY);

    log::info!("updater configured: {updater_configured}");

    // Single-instance must be the first plugin; with its `deep-link` feature it forwards a second launch's
    // vokko:// argument to the deep-link plugin before this callback runs. The lock is per app identifier, so
    // dev setups that run several copies side by side (worktrees, e2e) opt out with VOKKO_MULTI_INSTANCE=1.
    let mut builder = tauri::Builder::default();
    if std::env::var_os("VOKKO_MULTI_INSTANCE").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show_main(app)));
    }
    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init());
    if updater_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    #[cfg(target_os = "linux")]
    {
        builder = builder.manage(native_voice::NativeVoice::default());
    }

    builder
        .manage(Mutex::new(Session::demo()?))
        .manage(PrefsStore::load(config_dir.map(|dir| dir.join("desktop.json"))))
        .manage(tray::TrayState::default())
        .manage(links::LinkState::default())
        .manage(updates::UpdateState::new(updater_configured))
        .manage(shortcuts::ShortcutRegistry::default())
        .manage(overlay::OverlayState::default())
        .on_window_event(|window, event| {
            if window.label() != window::MAIN_WINDOW {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    if app.state::<PrefsStore>().get().close_to_tray && app.state::<tray::TrayState>().present() {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            log::warn!("cannot hide the window: {error}");
                        }
                        #[cfg(windows)]
                        if let Some(webview) = window.app_handle().get_webview_window(window::MAIN_WINDOW) {
                            window::set_memory_low(&webview, true);
                        }
                    }
                }
                #[cfg(windows)]
                WindowEvent::Resized(_) | WindowEvent::Focused(true) => {
                    if let Some(webview) = window.app_handle().get_webview_window(window::MAIN_WINDOW) {
                        window::set_memory_low(&webview, webview.is_minimized().unwrap_or(false));
                    }
                }
                _ => {}
            }
        })
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            dispatch,
            desktop_get_prefs,
            desktop_set_prefs,
            desktop_autostart_status,
            desktop_autostart_set,
            desktop_set_unread,
            crash::desktop_take_crash,
            window::desktop_window_chrome,
            games::desktop_list_processes,
            appinfo::desktop_app_info,
            appicon::desktop_set_app_icon,
            #[cfg(target_os = "macos")]
            macos::desktop_request_attention,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_connect,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_disconnect,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_mute,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_deaf,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_ptt,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_user_volume,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_apply_settings,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_devices,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_watch,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_video_quality,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_video_frame,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_video,
            links::desktop_take_pending_links,
            updates::desktop_update_status,
            updates::desktop_update_check,
            updates::desktop_update_download,
            updates::desktop_update_install,
            sharebar::desktop_hide_share_bar,
            shortcuts::desktop_shortcut_register,
            shortcuts::desktop_shortcut_unregister,
            shortcuts::desktop_shortcut_list,
            streamer::desktop_streaming_software_running,
            streamer::desktop_set_capture_hidden,
            streamer::desktop_restart,
            spotify::spotify_now_playing,
            overlay::desktop_overlay_configure,
            overlay::desktop_overlay_set_interactive,
            overlay::desktop_overlay_open_main,
            overlay::desktop_overlay_set_frame,
        ])
        .build(context)?
        .run(run_event);
    Ok(())
}
