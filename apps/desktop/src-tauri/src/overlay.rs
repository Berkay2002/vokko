//! In-game overlay (Windows): a separate transparent, borderless, always-on-top, click-through window (`overlay.html`) that shows
//! the voice widget and message toasts over a fullscreen or borderless game. The page in the main window owns the state and sends
//! it over app events; this module only decides when the window shows and switches it between passive and interactive.
//!
//! Anti-cheat safety (Riot Vanguard and the like) is by construction: Vokko never touches the game. It reads the geometry of the
//! foreground window (no process handle, no hook, no injection, no memory access) and takes keys only through the global-shortcut
//! plugin. In exclusive fullscreen (no desktop composition) nothing shows, which is the price of that rule.
//!
//! macOS and Linux: the commands are accepted and do nothing. A macOS version needs an NSPanel at screen-saver level that joins all
//! Spaces; games in their own fullscreen Space are the hard part.

// The geometry helpers are only called by the Windows backend (and the tests).
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Deserialize;

pub const OVERLAY_WINDOW: &str = "overlay";
/// `true` when the overlay takes the mouse (interactive mode), `false` when it drops back to click-through.
pub const INTERACTIVE_EVENT: &str = "overlay-interactive";

/// What the page in the main window asks for (Settings > Game Overlay plus whether it has something to show).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfig {
    pub enabled: bool,
    /// Accelerator of the interactive-mode toggle ("Shift+Backquote"). Registered only while the overlay shows.
    pub hotkey: String,
    /// Show over any foreground window, not only fullscreen ones.
    pub always: bool,
    /// The page has something to show (a call, a toast). Hidden otherwise, so the game keeps independent flip.
    pub active: bool,
}

/// A screen rectangle in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Where the passive window sits inside its monitor, in physical pixels from the monitor's top-left: just the widget and the toasts,
/// so the GPU keeps a surface the size of the content rather than of the whole monitor. The page measures it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The window rectangle on `monitor`: the frame while passive (kept inside the monitor), the whole monitor while interactive or
/// before the page has measured.
pub fn place(monitor: Rect, frame: Option<Frame>, interactive: bool) -> Rect {
    let Some(frame) = frame.filter(|_| !interactive) else {
        return monitor;
    };
    let (width, height) = (monitor.right - monitor.left, monitor.bottom - monitor.top);
    let x = frame.x.clamp(0, width - 1);
    let y = frame.y.clamp(0, height - 1);
    let left = monitor.left + x;
    let top = monitor.top + y;
    Rect { left, top, right: left + frame.width.clamp(1, width - x), bottom: top + frame.height.clamp(1, height - y) }
}

/// Whether a window covers its whole monitor: a fullscreen or borderless-fullscreen game (or video, or browser in F11).
pub fn covers(window: Rect, monitor: Rect) -> bool {
    window.left <= monitor.left && window.top <= monitor.top && window.right >= monitor.right && window.bottom >= monitor.bottom
}

/// The foreground window as the watcher sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Foreground {
    /// The overlay itself. Interactive mode never asks (it keeps its place); a passive overlay in front means Windows activated it
    /// (the game closed under it), and it hides so it can't hold the foreground.
    Overlay,
    /// Another Vokko window, the desktop or the taskbar: never a game.
    Ignored {
        monitor: Rect,
    },
    Other {
        monitor: Rect,
        fullscreen: bool,
    },
}

/// The monitor the overlay should cover, or None to hide it. `shown` is where it is now.
pub fn target(config: &OverlayConfig, foreground: Option<Foreground>) -> Option<Rect> {
    if !config.enabled || !config.active {
        return None;
    }
    match foreground? {
        Foreground::Overlay => None,
        Foreground::Ignored { .. } => None,
        Foreground::Other { monitor, fullscreen } => (fullscreen || config.always).then_some(monitor),
    }
}

#[cfg(windows)]
pub use imp::OverlayState;

/// Off Windows there is no overlay yet; the commands are accepted and ignored.
#[cfg(not(windows))]
#[derive(Default)]
pub struct OverlayState {}

#[tauri::command]
pub fn desktop_overlay_configure(app: tauri::AppHandle, state: tauri::State<'_, OverlayState>, config: OverlayConfig) {
    #[cfg(windows)]
    state.configure(&app, config);
    #[cfg(not(windows))]
    let _ = (app, state, config);
}

/// Interactive mode on or off (the overlay's Esc and "Back to game"; the hotkey toggles it in Rust).
#[tauri::command]
pub fn desktop_overlay_set_interactive(app: tauri::AppHandle, state: tauri::State<'_, OverlayState>, on: bool) {
    #[cfg(windows)]
    state.set_interactive(&app, on);
    #[cfg(not(windows))]
    let _ = (app, state, on);
}

/// A toast was clicked: leave interactive mode and bring the main window forward (the main page opens the message).
#[tauri::command]
pub fn desktop_overlay_open_main(app: tauri::AppHandle, state: tauri::State<'_, OverlayState>) {
    #[cfg(windows)]
    state.open_main(&app);
    #[cfg(not(windows))]
    let _ = state;
    #[cfg(not(windows))]
    crate::window::show_main(&app);
}

/// The page measured its content: the passive window shrinks to `frame` (None: the whole monitor).
#[tauri::command]
pub fn desktop_overlay_set_frame(app: tauri::AppHandle, state: tauri::State<'_, OverlayState>, frame: Option<Frame>) {
    #[cfg(windows)]
    state.set_frame(&app, frame);
    #[cfg(not(windows))]
    let _ = (app, state, frame);
}

#[cfg(windows)]
mod imp {
    use std::str::FromStr;
    use std::sync::Mutex;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    use super::{Frame, INTERACTIVE_EVENT, OVERLAY_WINDOW, OverlayConfig, Rect, place, target};
    use crate::prefs::PrefsStore;

    /// How often the foreground window is checked: a few Win32 calls, no process walk.
    const POLL: Duration = Duration::from_millis(500);

    enum Msg {
        Config(OverlayConfig),
        Interactive(bool),
        Toggle,
        OpenMain,
        Frame(Option<Frame>),
    }

    /// Channel into the watcher thread, which owns the window and the hotkey. Started on the first configure.
    #[derive(Default)]
    pub struct OverlayState {
        tx: Mutex<Option<Sender<Msg>>>,
    }

    impl OverlayState {
        fn send(&self, app: &AppHandle, msg: Msg) {
            let Ok(mut tx) = self.tx.lock() else {
                return;
            };
            if tx.is_none() {
                let (sender, receiver) = channel();
                let app = app.clone();
                if let Err(error) = std::thread::Builder::new().name("overlay".into()).spawn(move || Watcher::new(app).run(&receiver)) {
                    log::warn!("overlay watcher not started: {error}");
                    return;
                }
                *tx = Some(sender);
            }
            if let Some(sender) = tx.as_ref() {
                let _ = sender.send(msg);
            }
        }
    }

    impl OverlayState {
        pub fn configure(&self, app: &AppHandle, config: OverlayConfig) {
            // Nothing to start while it is off and was never on.
            if !config.enabled && self.tx.lock().map(|tx| tx.is_none()).unwrap_or(true) {
                return;
            }
            self.send(app, Msg::Config(config));
        }

        pub fn set_interactive(&self, app: &AppHandle, on: bool) {
            self.send(app, Msg::Interactive(on));
        }

        pub fn set_frame(&self, app: &AppHandle, frame: Option<Frame>) {
            if self.tx.lock().map(|tx| tx.is_some()).unwrap_or(false) {
                self.send(app, Msg::Frame(frame));
            }
        }

        pub fn open_main(&self, app: &AppHandle) {
            if self.tx.lock().map(|tx| tx.is_none()).unwrap_or(true) {
                crate::window::show_main(app);
            } else {
                self.send(app, Msg::OpenMain);
            }
        }
    }

    struct Watcher {
        app: AppHandle,
        config: OverlayConfig,
        /// Monitor the overlay covers while it shows.
        shown: Option<Rect>,
        /// The page's last measured content (the passive window) and where the window actually is.
        frame: Option<Frame>,
        placed: Option<Rect>,
        interactive: bool,
        /// The window that was in front when interactive mode began; it gets the focus back.
        game: Option<win::Hwnd>,
        hotkey: Option<Shortcut>,
    }

    impl Watcher {
        fn new(app: AppHandle) -> Self {
            Self { app, config: OverlayConfig::default(), shown: None, frame: None, placed: None, interactive: false, game: None, hotkey: None }
        }

        fn run(mut self, rx: &Receiver<Msg>) {
            loop {
                match rx.recv_timeout(POLL) {
                    Ok(Msg::Config(config)) => {
                        if config.hotkey != self.config.hotkey {
                            self.unregister_hotkey();
                        }
                        self.config = config;
                        if self.shown.is_some() {
                            self.register_hotkey();
                        }
                    }
                    Ok(Msg::Interactive(on)) => self.set_interactive(on),
                    Ok(Msg::Toggle) => self.set_interactive(!self.interactive),
                    Ok(Msg::Frame(frame)) => {
                        self.frame = frame;
                        self.place();
                    }
                    Ok(Msg::OpenMain) => {
                        // Vokko takes the focus, not the game.
                        self.game = None;
                        self.set_interactive(false);
                        crate::window::show_main(&self.app);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                self.tick();
            }
        }

        fn overlay_hwnd(&self) -> Option<win::Hwnd> {
            self.app.get_webview_window(OVERLAY_WINDOW).and_then(|window| window.hwnd().ok()).map(win::Hwnd::from)
        }

        fn tick(&mut self) {
            if !self.config.enabled {
                if let Some(window) = self.app.get_webview_window(OVERLAY_WINDOW) {
                    self.set_interactive(false);
                    self.unregister_hotkey();
                    let _ = window.destroy();
                    self.shown = None;
                    // A new page starts unmeasured.
                    self.frame = None;
                    self.placed = None;
                }
                return;
            }
            let foreground = win::foreground(self.overlay_hwnd());
            let next = if self.interactive { self.shown } else { target(&self.config, foreground) };
            if next == self.shown {
                return;
            }
            match next {
                Some(rect) => self.show(rect),
                None => self.hide(),
            }
        }

        fn show(&mut self, rect: Rect) {
            let Some(hwnd) = self.overlay_hwnd().or_else(|| self.create()) else {
                return;
            };
            self.shown = Some(rect);
            self.placed = None;
            self.place_on(hwnd);
            self.register_hotkey();
        }

        /// Moves and sizes the shown window to the frame (passive) or the monitor (interactive). Never activates it.
        fn place(&mut self) {
            if let Some(hwnd) = self.overlay_hwnd() {
                self.place_on(hwnd);
            }
        }

        fn place_on(&mut self, hwnd: win::Hwnd) {
            let Some(monitor) = self.shown else {
                return;
            };
            let rect = place(monitor, self.frame, self.interactive);
            if self.placed != Some(rect) {
                win::show_over(hwnd, rect);
                self.placed = Some(rect);
            }
        }

        fn hide(&mut self) {
            self.set_interactive(false);
            if let Some(hwnd) = self.overlay_hwnd() {
                win::hide(hwnd);
            }
            self.shown = None;
            self.placed = None;
            self.unregister_hotkey();
        }

        /// Builds the overlay window, hidden. Not focusable and click-through from the start, so showing it never takes the focus
        /// from a game (an exclusive-fullscreen game minimizes when it loses focus).
        fn create(&self) -> Option<win::Hwnd> {
            let builder = WebviewWindowBuilder::new(&self.app, OVERLAY_WINDOW, WebviewUrl::App("overlay.html".into()))
                .title("Vokko Overlay")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .visible(false);
            // Every webview of the app shares one WebView2 environment, so the overlay must use the main window's browser flags.
            let builder = if self.app.state::<PrefsStore>().get().hardware_acceleration {
                builder
            } else {
                builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --disable-gpu-compositing")
            };
            match builder.build() {
                Ok(window) => {
                    let hwnd = window.hwnd().ok().map(win::Hwnd::from)?;
                    win::set_passive(hwnd, true);
                    // A few kilobytes of UI: let WebView2 trim its caches (the 80 MB budget).
                    crate::window::set_memory_low(&window, true);
                    Some(hwnd)
                }
                Err(error) => {
                    log::warn!("overlay window not created: {error}");
                    None
                }
            }
        }

        fn set_interactive(&mut self, on: bool) {
            if on == self.interactive || (on && self.shown.is_none()) {
                return;
            }
            let Some(hwnd) = self.overlay_hwnd() else {
                return;
            };
            self.interactive = on;
            if on {
                self.game = win::foreground_hwnd().filter(|&fg| fg != hwnd);
                // Not layered any more, then the whole monitor (backdrop, control bar), then the focus.
                win::set_passive(hwnd, false);
                self.place_on(hwnd);
                win::focus(hwnd);
                // And the page itself: WebView2 keeps its own focus, which can be stale after Windows activated the passive window.
                if let Some(window) = self.app.get_webview_window(OVERLAY_WINDOW) {
                    let _ = window.as_ref().set_focus();
                }
            } else {
                // Hand the keyboard back to the game first, while the overlay still owns the foreground (Windows refuses
                // SetForegroundWindow otherwise and activates whatever is next). Only if the overlay still has it: the user may
                // have clicked elsewhere.
                if win::foreground_hwnd() == Some(hwnd)
                    && let Some(game) = self.game.take()
                {
                    win::focus(game);
                }
                self.place_on(hwnd);
                win::set_passive(hwnd, true);
            }
            if let Err(error) = self.app.emit_to(OVERLAY_WINDOW, INTERACTIVE_EVENT, on) {
                log::warn!("cannot emit {INTERACTIVE_EVENT}: {error}");
            }
        }

        fn register_hotkey(&mut self) {
            if self.hotkey.is_some() || self.config.hotkey.is_empty() {
                return;
            }
            let Ok(shortcut) = Shortcut::from_str(&self.config.hotkey) else {
                log::warn!("overlay hotkey {:?} is not a valid accelerator", self.config.hotkey);
                return;
            };
            let result = self.app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    app.state::<OverlayState>().send(app, Msg::Toggle);
                }
            });
            match result {
                Ok(()) => self.hotkey = Some(shortcut),
                Err(error) => log::warn!("overlay hotkey {:?} not registered: {error}", self.config.hotkey),
            }
        }

        fn unregister_hotkey(&mut self) {
            if let Some(shortcut) = self.hotkey.take() {
                let _ = self.app.global_shortcut().unregister(shortcut);
            }
        }
    }

    #[allow(unsafe_code)]
    mod win {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GWL_STYLE, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, HWND_TOPMOST, IsIconic,
            IsZoomed, SW_HIDE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowLongPtrW,
            SetWindowPos, ShowWindow, WS_DISABLED, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        };

        use super::super::{Foreground, Rect, covers};

        /// A window handle as a plain number, so it can live in the watcher thread (HWND is not Send).
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct Hwnd(isize);

        impl From<HWND> for Hwnd {
            fn from(hwnd: HWND) -> Self {
                Self(hwnd.0 as isize)
            }
        }

        impl Hwnd {
            fn get(self) -> HWND {
                HWND(self.0 as *mut _)
            }
        }

        fn rect(r: RECT) -> Rect {
            Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        }

        pub fn foreground_hwnd() -> Option<Hwnd> {
            // SAFETY: no arguments; returns null when no window is in front.
            let hwnd = unsafe { GetForegroundWindow() };
            (!hwnd.is_invalid()).then(|| Hwnd::from(hwnd))
        }

        /// Classes of the desktop and the taskbar, which also cover a monitor.
        const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

        /// What is in front: only window geometry, class name and the owning pid (GetWindowThreadProcessId opens no handle).
        pub fn foreground(overlay: Option<Hwnd>) -> Option<Foreground> {
            let fg = foreground_hwnd()?;
            if Some(fg) == overlay {
                return Some(Foreground::Overlay);
            }
            let hwnd = fg.get();
            // SAFETY: plain queries on a window handle; a stale handle only makes them fail, which is handled.
            unsafe {
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                    return None;
                }
                let monitor = rect(info.rcMonitor);
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let mut class = [0u16; 64];
                let len = usize::try_from(GetClassNameW(hwnd, &mut class)).unwrap_or(0);
                let class = String::from_utf16_lossy(&class[..len]);
                if pid == std::process::id() || SHELL_CLASSES.contains(&class.as_str()) {
                    return Some(Foreground::Ignored { monitor });
                }
                let mut window = RECT::default();
                if GetWindowRect(hwnd, &mut window).is_err() {
                    return None;
                }
                // A maximized window with an auto-hidden taskbar also covers the monitor; it is not a game.
                let fullscreen = covers(rect(window), monitor) && !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool();
                Some(Foreground::Other { monitor, fullscreen })
            }
        }

        /// Passive: click-through and never activated. Interactive: takes the mouse and the keyboard. Set straight on the window
        /// (not through tao) so the visibility tao tracks is never rewritten while the window is shown outside it.
        pub fn set_passive(hwnd: Hwnd, passive: bool) {
            let hwnd = hwnd.get();
            // SAFETY: style bits of our own window; SetWindowPos only refreshes the frame.
            unsafe {
                let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | WS_EX_TOOLWINDOW.0 as isize;
                // LAYERED + TRANSPARENT is what makes clicks fall through. LAYERED goes too in interactive mode: WebView2 draws
                // through DirectComposition, so a layered window's own (empty) surface would still let every click through.
                let passive_bits = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0 | WS_EX_NOACTIVATE.0) as isize;
                style = if passive { style | passive_bits } else { style & !passive_bits };
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
                // Disabled too: NOACTIVATE alone doesn't stop Windows from activating the topmost overlay when the game window
                // closes, and a passively activated WebView2 then misses the next interactive mode's clicks and keys.
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                let style = if passive { style | WS_DISABLED.0 as isize } else { style & !(WS_DISABLED.0 as isize) };
                SetWindowLongPtrW(hwnd, GWL_STYLE, style);
                let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            }
        }

        /// Shows the overlay at `rect`, topmost, without activating it.
        pub fn show_over(hwnd: Hwnd, rect: Rect) {
            // SAFETY: positions our own window.
            unsafe {
                let _ = SetWindowPos(
                    hwnd.get(),
                    Some(HWND_TOPMOST),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }

        pub fn hide(hwnd: Hwnd) {
            // SAFETY: hides our own window.
            unsafe {
                let _ = ShowWindow(hwnd.get(), SW_HIDE);
            }
        }

        /// Brings a window to the front. Windows allows it here: Vokko just got the hotkey press, or the overlay is in front.
        pub fn focus(hwnd: Hwnd) {
            // SAFETY: a stale handle only makes the call fail.
            unsafe {
                let _ = SetForegroundWindow(hwnd.get());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };

    fn config() -> OverlayConfig {
        OverlayConfig { enabled: true, hotkey: "Shift+Backquote".into(), always: false, active: true }
    }

    #[test]
    fn a_window_covering_the_monitor_is_fullscreen() {
        assert!(covers(SCREEN, SCREEN));
        // Exclusive-mode games and some borderless ones overshoot the monitor by a few pixels.
        assert!(covers(Rect { left: -8, top: -8, right: 2568, bottom: 1448 }, SCREEN));
        // A window on the second monitor, the work area above the taskbar, a big normal window.
        assert!(covers(Rect { left: 2560, top: 0, right: 5120, bottom: 1440 }, Rect { left: 2560, top: 0, right: 5120, bottom: 1440 }));
        assert!(!covers(Rect { left: 0, top: 0, right: 2560, bottom: 1392 }, SCREEN));
        assert!(!covers(Rect { left: 100, top: 100, right: 2000, bottom: 1300 }, SCREEN));
    }

    #[test]
    fn shows_only_over_a_fullscreen_window_unless_always() {
        let game = Some(Foreground::Other { monitor: SCREEN, fullscreen: true });
        let browser = Some(Foreground::Other { monitor: SCREEN, fullscreen: false });
        assert_eq!(target(&config(), game), Some(SCREEN));
        assert_eq!(target(&config(), browser), None);
        assert_eq!(target(&OverlayConfig { always: true, ..config() }, browser), Some(SCREEN));
        // Vokko itself, the desktop or nothing in front: hidden even when "always".
        assert_eq!(target(&OverlayConfig { always: true, ..config() }, Some(Foreground::Ignored { monitor: SCREEN })), None);
        assert_eq!(target(&config(), None), None);
    }

    #[test]
    fn hidden_when_off_or_nothing_to_show() {
        let game = Some(Foreground::Other { monitor: SCREEN, fullscreen: true });
        assert_eq!(target(&OverlayConfig { enabled: false, ..config() }, game), None);
        assert_eq!(target(&OverlayConfig { active: false, ..config() }, game), None);
    }

    #[test]
    fn a_passive_overlay_in_front_hides() {
        assert_eq!(target(&config(), Some(Foreground::Overlay)), None);
    }

    #[test]
    fn the_passive_window_is_the_frame_inside_its_monitor() {
        let right = Rect { left: 2560, top: 0, right: 5120, bottom: 1440 };
        let frame = Frame { x: 0, y: 0, width: 300, height: 200 };
        assert_eq!(place(SCREEN, Some(frame), false), Rect { left: 0, top: 0, right: 300, bottom: 200 });
        // Relative to the monitor, and cut at its edges.
        assert_eq!(place(right, Some(Frame { x: 2400, ..frame }), false), Rect { left: 4960, top: 0, right: 5120, bottom: 200 });
        assert_eq!(place(SCREEN, Some(Frame { x: -50, y: 9000, ..frame }), false), Rect { left: 0, top: 1439, right: 300, bottom: 1440 });
        // Interactive or unmeasured: the whole monitor.
        assert_eq!(place(SCREEN, Some(frame), true), SCREEN);
        assert_eq!(place(SCREEN, None, false), SCREEN);
    }

    #[test]
    fn config_reads_the_keys_the_page_sends() {
        let config: OverlayConfig = serde_json::from_str(r#"{"enabled":true,"hotkey":"Shift+Backquote","always":false,"active":true}"#).unwrap();
        assert_eq!(config, self::config());
    }
}
