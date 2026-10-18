//! Pop Out: a small always-on-top window (`popout.html`) that plays the call's Stremio movie or Watch Together video next to your work,
//! like Discord's popped-out stream. The page in the main window owns the session and relays it over app events (src/popout/); this
//! module only creates, moves, sizes and closes the window, the same split as the game overlay (overlay.rs).
//!
//! The window has no parent, so minimising or hiding the main window leaves it up and playing. It stays 16:9 (Tauri has no aspect-ratio
//! lock, so a resize is corrected here), remembers one position and size in `popout.json` next to `window.json`, and is put back on a
//! visible monitor when the one it was on is gone.
//!
//! macOS and Linux: built the same way (Tauri's window API is shared) but only checked on Windows.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::window_state::{self, Area, WindowStateStore};

pub const POPOUT_WINDOW: &str = "popout";
/// The window is gone: Close, Back to call, the call ending or quitting. Main unmutes the movie again.
pub const CLOSED_EVENT: &str = "popout-closed";

/// Smallest and first size, in logical pixels (16:9).
const MIN_LOGICAL: (f64, f64) = (320.0, 180.0);
const DEFAULT_LOGICAL: (f64, f64) = (480.0, 270.0);
/// Smallest size in physical pixels, for the saved geometry (a 100% display; a higher scale only makes a saved size larger).
const MIN_PHYSICAL: (u32, u32) = (320, 180);
/// Space left between a first-time window and the screen edges.
const MARGIN: i32 = 16;

/// Whether the main window's WebView2 runs with the GPU, fixed at start-up: every webview of the app shares one environment, so the
/// pop-out must be created with the flags the main window was created with, even after Settings changed the preference.
static BROWSER_ACCELERATED: OnceLock<bool> = OnceLock::new();

/// Called when the main window is created.
pub fn remember_browser_flags(accelerated: bool) {
    let _ = BROWSER_ACCELERATED.set(accelerated);
}

/// The height that makes a window `width` wide 16:9.
pub fn height_for(width: u32) -> u32 {
    (width.saturating_mul(9) + 8) / 16
}

/// The width that makes a window `height` high 16:9.
pub fn width_for(height: u32) -> u32 {
    (height.saturating_mul(16) + 4) / 9
}

/// A window rectangle in screen pixels (the Win32 RECT), as a window being dragged by an edge reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Box4 {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// The edge or corner the user drags (Win32 WMSZ_*).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// The rectangle a drag by `edge` is corrected to while it happens (so the window never flickers through wrong shapes): the dragged
/// dimension is kept and the other follows, growing from the side the user is not holding. A corner follows the width.
pub fn fit_edge(edge: Edge, r: Box4) -> Box4 {
    let width = u32::try_from(r.right - r.left).unwrap_or(0);
    let height = u32::try_from(r.bottom - r.top).unwrap_or(0);
    let as_i32 = |n: u32| i32::try_from(n).unwrap_or(i32::MAX);
    match edge {
        Edge::Top | Edge::Bottom => Box4 { right: r.left.saturating_add(as_i32(width_for(height))), ..r },
        Edge::TopLeft | Edge::TopRight => Box4 { top: r.bottom.saturating_sub(as_i32(height_for(width))), ..r },
        Edge::Left | Edge::Right | Edge::BottomLeft | Edge::BottomRight => Box4 { bottom: r.top.saturating_add(as_i32(height_for(width))), ..r },
    }
}

/// The size to correct a resized window to (width kept, height made 16:9), or None when it is 16:9 already (within a pixel) or has no
/// size (a minimised window reports 0x0).
pub fn fit_16_9(width: u32, height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 {
        return None;
    }
    let wanted = height_for(width);
    (wanted.abs_diff(height) > 1).then_some((width, wanted))
}

/// Where a window of `size` goes the first time: the bottom-right of the monitor's work area, `MARGIN` in from the edges.
pub fn default_position(work: Area, size: (u32, u32)) -> (i32, i32) {
    let place = |origin: i32, room: u32, size: u32| i32::try_from(i64::from(origin) + i64::from(room) - i64::from(size) - i64::from(MARGIN)).unwrap_or(origin);
    (place(work.x, work.width, size.0).max(work.x), place(work.y, work.height, size.1).max(work.y))
}

/// The remembered geometry (`popout.json`).
pub struct PopoutState {
    store: WindowStateStore,
}

impl PopoutState {
    pub fn load(path: Option<PathBuf>) -> Self {
        Self { store: WindowStateStore::load(path) }
    }
}

/// The monitor of the main window (else the primary one): its work area and scale factor.
fn work_area(app: &AppHandle) -> Option<(Area, f64)> {
    let monitor =
        app.get_webview_window(crate::window::MAIN_WINDOW).and_then(|w| w.current_monitor().ok().flatten()).or_else(|| app.primary_monitor().ok().flatten())?;
    let work = monitor.work_area();
    Some((Area { x: work.position.x, y: work.position.y, width: work.size.width, height: work.size.height }, monitor.scale_factor()))
}

/// While the user drags an edge (Windows): the window is corrected to 16:9 in `WM_SIZING`, before it is drawn, so it never flickers
/// through other shapes. `keep_ratio` on the Resized event stays as the fallback everywhere (and for a size set by other means).
#[cfg(windows)]
#[allow(unsafe_code)]
mod sizing {
    use tauri::{AppHandle, WebviewWindow};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_NCDESTROY, WM_SIZING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };

    use super::{Box4, Edge, fit_edge};

    const SUBCLASS_ID: usize = 0x564B_0001;

    fn edge_of(code: usize) -> Option<Edge> {
        let code = u32::try_from(code).ok()?;
        Some(match code {
            WMSZ_LEFT => Edge::Left,
            WMSZ_RIGHT => Edge::Right,
            WMSZ_TOP => Edge::Top,
            WMSZ_BOTTOM => Edge::Bottom,
            WMSZ_TOPLEFT => Edge::TopLeft,
            WMSZ_TOPRIGHT => Edge::TopRight,
            WMSZ_BOTTOMLEFT => Edge::BottomLeft,
            WMSZ_BOTTOMRIGHT => Edge::BottomRight,
            _ => return None,
        })
    }

    unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_SIZING
            && lparam.0 != 0
            && let Some(edge) = edge_of(wparam.0)
        {
            // SAFETY: for WM_SIZING, lparam points to the window's RECT, valid and writable until the message returns.
            let rect = unsafe { &mut *(lparam.0 as *mut RECT) };
            let fit = fit_edge(edge, Box4 { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
            *rect = RECT { left: fit.left, top: fit.top, right: fit.right, bottom: fit.bottom };
            return LRESULT(1);
        }
        if msg == WM_NCDESTROY {
            // SAFETY: removes this subclass from the window that is going away, as comctl32 asks before the window is destroyed.
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
        }
        // SAFETY: the arguments are the ones this callback was given.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn install(app: &AppHandle, window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let raw = hwnd.0 as isize;
        // SetWindowSubclass only works from the thread that created the window, which is the main thread, not the command's.
        if let Err(error) = app.run_on_main_thread(move || {
            // SAFETY: the window outlives its subclass (the subclass goes away with it); the callback only reads and writes the message's RECT.
            let ok = unsafe { SetWindowSubclass(HWND(raw as *mut _), Some(subclass_proc), SUBCLASS_ID, 0) };
            if !ok.as_bool() {
                log::warn!("cannot subclass the pop-out for its aspect ratio");
            }
        }) {
            log::warn!("cannot subclass the pop-out for its aspect ratio: {error}");
        }
    }
}

/// Makes the window 16:9 again after a resize.
fn keep_ratio(window: &WebviewWindow, size: PhysicalSize<u32>) {
    if let Some((width, height)) = fit_16_9(size.width, size.height)
        && let Err(error) = window.set_size(PhysicalSize::new(width, height))
    {
        log::warn!("cannot keep the pop-out 16:9: {error}");
    }
}

fn on_event(app: &AppHandle, event: &WindowEvent) {
    match event {
        WindowEvent::Resized(size) => {
            if let Some(window) = app.get_webview_window(POPOUT_WINDOW) {
                keep_ratio(&window, *size);
                window_state::track(&window, &app.state::<PopoutState>().store);
            }
        }
        WindowEvent::Moved(_) => {
            if let Some(window) = app.get_webview_window(POPOUT_WINDOW) {
                window_state::track(&window, &app.state::<PopoutState>().store);
            }
        }
        WindowEvent::Destroyed => {
            app.state::<PopoutState>().store.save();
            if let Err(error) = app.emit(CLOSED_EVENT, ()) {
                log::warn!("cannot emit {CLOSED_EVENT}: {error}");
            }
        }
        _ => {}
    }
}

fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, POPOUT_WINDOW, WebviewUrl::App("popout.html".into()))
        .title("Vokko Pop Out")
        .decorations(false)
        .resizable(true)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .background_color(Color(0, 0, 0, 255))
        .min_inner_size(MIN_LOGICAL.0, MIN_LOGICAL.1)
        .inner_size(DEFAULT_LOGICAL.0, DEFAULT_LOGICAL.1)
        // Like the main window: the picture keeps playing while it is covered.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .visible(false);
    // Every webview of the app shares one WebView2 environment, so this one must use the main window's browser flags.
    #[cfg(windows)]
    let builder = if BROWSER_ACCELERATED.get().copied().unwrap_or_else(|| app.state::<crate::prefs::PrefsStore>().get().hardware_acceleration) {
        builder
    } else {
        builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --disable-gpu-compositing")
    };
    let window = builder.build().map_err(|error| error.to_string())?;
    let state = app.state::<PopoutState>();
    if state.store.get().is_some() {
        window_state::restore_with(&window, &state.store, MIN_PHYSICAL);
    } else if let Some((work, scale)) = work_area(app) {
        // Onto the main window's monitor first (its scale may differ from where a new window starts), then the size in that monitor's pixels.
        let _ = window.set_position(PhysicalPosition::new(work.x, work.y));
        let size = ((DEFAULT_LOGICAL.0 * scale).round() as u32, (DEFAULT_LOGICAL.1 * scale).round() as u32);
        let _ = window.set_size(PhysicalSize::new(size.0, size.1));
        let (x, y) = default_position(work, size);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if let Ok(size) = window.inner_size() {
        keep_ratio(&window, size);
    }
    #[cfg(windows)]
    sizing::install(app, &window);
    let handle = app.clone();
    window.on_window_event(move |event| on_event(&handle, event));
    Ok(window)
}

/// Opens the pop-out, or brings the open one forward.
#[tauri::command]
pub async fn desktop_popout_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(POPOUT_WINDOW) {
        window.show().and_then(|()| window.set_focus()).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = build(&app)?;
    window.show().and_then(|()| window.set_focus()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_popout_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(POPOUT_WINDOW)
        && let Err(error) = window.close()
    {
        log::warn!("cannot close the pop-out: {error}");
    }
}

/// Pin on top on or off.
#[tauri::command]
pub fn desktop_popout_pin(app: AppHandle, on: bool) {
    if let Some(window) = app.get_webview_window(POPOUT_WINDOW)
        && let Err(error) = window.set_always_on_top(on)
    {
        log::warn!("cannot change the pop-out's pin: {error}");
    }
}

/// Back to call: the main window comes forward (un-minimised, shown, focused) and the pop-out closes. The page in the main window
/// navigates to the call when it gets the `back` action.
#[tauri::command]
pub fn desktop_popout_back(app: AppHandle) {
    crate::window::show_main(&app);
    desktop_popout_close(app);
}

/// Writes the remembered geometry (also done when the window is destroyed).
pub fn save(app: &AppHandle) {
    app.state::<PopoutState>().store.save();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_height_follows_the_width() {
        assert_eq!(height_for(480), 270);
        assert_eq!(height_for(320), 180);
        assert_eq!(height_for(720), 405);
        assert_eq!(height_for(0), 0);
    }

    #[test]
    fn a_resize_is_corrected_to_16_9_only_when_it_is_off() {
        assert_eq!(fit_16_9(480, 270), None);
        // A pixel of rounding (a scaled display) is left alone, so the correction cannot ring.
        assert_eq!(fit_16_9(481, 270), None);
        assert_eq!(fit_16_9(600, 338), None);
        assert_eq!(fit_16_9(640, 480), Some((640, 360)));
        assert_eq!(fit_16_9(400, 400), Some((400, 225)));
        // A minimised window has no size.
        assert_eq!(fit_16_9(0, 0), None);
        assert_eq!(fit_16_9(480, 0), None);
    }

    #[test]
    fn a_correction_is_stable() {
        for width in [320, 333, 480, 599, 720, 1001, 1920] {
            for height in [100, 300, 1080] {
                if let Some((w, h)) = fit_16_9(width, height) {
                    assert_eq!(fit_16_9(w, h), None, "{width}x{height} -> {w}x{h}");
                }
            }
        }
    }

    #[test]
    fn width_and_height_agree() {
        for width in [320, 333, 480, 721, 1920] {
            assert!(fit_16_9(width, height_for(width)).is_none());
            assert!(fit_16_9(width_for(height_for(width)), height_for(width)).is_none(), "{width}");
        }
    }

    #[test]
    fn a_drag_by_a_side_keeps_that_side_and_grows_the_other_dimension() {
        let r = Box4 { left: 100, top: 100, right: 580, bottom: 400 };
        // Right edge dragged: width 480 kept, height 270, hanging from the top.
        assert_eq!(fit_edge(Edge::Right, r), Box4 { bottom: 370, ..r });
        assert_eq!(fit_edge(Edge::Left, r), Box4 { bottom: 370, ..r });
        // Bottom edge dragged: height 300 kept, width 533, extending to the right.
        assert_eq!(fit_edge(Edge::Bottom, r), Box4 { right: 633, ..r });
        assert_eq!(fit_edge(Edge::Top, r), Box4 { right: 633, ..r });
    }

    #[test]
    fn a_drag_by_a_corner_follows_the_width_from_the_opposite_corner() {
        let r = Box4 { left: 100, top: 100, right: 580, bottom: 400 };
        assert_eq!(fit_edge(Edge::BottomRight, r), Box4 { bottom: 370, ..r });
        assert_eq!(fit_edge(Edge::BottomLeft, r), Box4 { bottom: 370, ..r });
        // The top corners keep the bottom edge where it is.
        assert_eq!(fit_edge(Edge::TopLeft, r), Box4 { top: 130, ..r });
        assert_eq!(fit_edge(Edge::TopRight, r), Box4 { top: 130, ..r });
    }

    #[test]
    fn an_inside_out_rectangle_does_not_panic() {
        let r = Box4 { left: 500, top: 500, right: 100, bottom: 100 };
        let fit = fit_edge(Edge::Right, r);
        assert_eq!((fit.left, fit.right), (500, 100));
    }

    #[test]
    fn the_first_position_is_the_bottom_right_of_the_work_area() {
        let work = Area { x: 0, y: 0, width: 1920, height: 1040 };
        assert_eq!(default_position(work, (600, 338)), (1304, 686));
        // A second monitor to the right, and a window bigger than the area stays at its corner.
        let right = Area { x: 1920, y: 0, width: 2560, height: 1400 };
        assert_eq!(default_position(right, (600, 338)), (3864, 1046));
        assert_eq!(default_position(Area { x: 0, y: 0, width: 400, height: 200 }, (600, 338)), (0, 0));
    }
}
