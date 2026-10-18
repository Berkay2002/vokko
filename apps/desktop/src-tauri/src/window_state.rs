//! Remembers the main window's size, position and maximized state across launches (`window.json` next to `desktop.json`).
//! Geometry is kept in physical pixels both ways, so a Retina screen doesn't double the window on every start.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// Smallest window the page lays out in (`minWidth`/`minHeight` in tauri.conf.json).
const MIN_SIZE: (u32, u32) = (940, 500);
/// The title bar strip that must stay reachable: at least `GRAB_WIDTH` of it has to lie on a monitor.
const GRAB_WIDTH: i64 = 100;
const GRAB_HEIGHT: i64 = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn overlap(a_start: i64, a_len: i64, b_start: i64, b_len: i64) -> i64 {
    ((a_start + a_len).min(b_start + b_len) - a_start.max(b_start)).max(0)
}

/// Fits a saved window to the monitors connected now. A window whose title bar is still reachable on some monitor keeps its
/// position (it may span two screens on purpose); otherwise (an unplugged screen) it is centred on the first monitor, the
/// primary. The size is limited to that monitor and raised to the minimum.
pub fn clamp(saved: Saved, monitors: &[Area]) -> Saved {
    let Some(&primary) = monitors.first() else {
        return saved;
    };
    let reachable = |m: &Area| {
        let across = overlap(i64::from(saved.x), i64::from(saved.width), i64::from(m.x), i64::from(m.width));
        let down = overlap(i64::from(saved.y), GRAB_HEIGHT, i64::from(m.y), i64::from(m.height));
        across >= GRAB_WIDTH.min(i64::from(saved.width)) && down >= GRAB_HEIGHT
    };
    let home = monitors.iter().find(|m| reachable(m)).copied();
    let target = home.unwrap_or(primary);
    let width = saved.width.clamp(MIN_SIZE.0.min(target.width), target.width);
    let height = saved.height.clamp(MIN_SIZE.1.min(target.height), target.height);
    let centred = |origin: i32, room: u32, size: u32| i32::try_from(i64::from(origin) + (i64::from(room) - i64::from(size)) / 2).unwrap_or(origin);
    let (x, y) = if home.is_some() { (saved.x, saved.y) } else { (centred(target.x, target.width, width), centred(target.y, target.height, height)) };
    Saved { x, y, width, height, maximized: saved.maximized }
}

pub struct WindowStateStore {
    path: Option<PathBuf>,
    latest: Mutex<Option<Saved>>,
}

impl WindowStateStore {
    /// Loads the file at `path`; a missing or unreadable file means there is nothing to restore.
    pub fn load(path: Option<PathBuf>) -> Self {
        let latest = path.as_ref().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok());
        Self { path, latest: Mutex::new(latest) }
    }

    fn get(&self) -> Option<Saved> {
        self.latest.lock().ok().and_then(|latest| *latest)
    }

    fn set(&self, update: impl FnOnce(Option<Saved>) -> Option<Saved>) {
        if let Ok(mut latest) = self.latest.lock() {
            *latest = update(*latest);
        }
    }

    /// Writes the latest geometry. Called when the window is hidden to the tray and when the app exits.
    pub fn save(&self) {
        let (Some(path), Some(saved)) = (&self.path, self.get()) else {
            return;
        };
        let result = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| serde_json::to_vec_pretty(&saved).map_err(Into::into))
            .and_then(|json| std::fs::write(path, json));
        if let Err(error) = result {
            log::warn!("cannot save the window state: {error}");
        }
    }
}

/// Takes the window's current geometry. A minimized window reports a far-off position (Windows: -32000), and a maximized or
/// fullscreen one fills the screen, so those keep the last normal size and only the maximized flag changes.
pub fn track<R: Runtime>(window: &WebviewWindow<R>, store: &WindowStateStore) {
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let normal = if maximized { None } else { window.outer_position().ok().zip(window.inner_size().ok()) };
    store.set(|previous| match (normal, previous) {
        (Some((position, size)), _) => Some(Saved { x: position.x, y: position.y, width: size.width, height: size.height, maximized }),
        (None, Some(previous)) => Some(Saved { maximized, ..previous }),
        (None, None) => None,
    });
}

/// Moves and sizes the (still hidden) window to where it was, clamped to the monitors connected now.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, store: &WindowStateStore) {
    let Some(saved) = store.get() else {
        return;
    };
    let mut monitors: Vec<Area> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Area { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
        .collect();
    // The primary monitor goes first: it is where an off-screen window is brought back to.
    let primary = window.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    monitors.sort_by_key(|m| Some((m.x, m.y)) != primary);
    let fitted = clamp(saved, &monitors);
    // Position first: sizing on the creation monitor and then moving to a monitor with another scale factor would rescale the size.
    if let Err(error) =
        window.set_position(PhysicalPosition::new(fitted.x, fitted.y)).and_then(|()| window.set_size(PhysicalSize::new(fitted.width, fitted.height)))
    {
        log::warn!("cannot restore the window geometry: {error}");
    }
    if fitted.maximized
        && let Err(error) = window.maximize()
    {
        log::warn!("cannot maximize the window: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area { x: 0, y: 0, width: 1920, height: 1080 };
    const RIGHT: Area = Area { x: 1920, y: 0, width: 2560, height: 1440 };

    fn at(x: i32, y: i32, width: u32, height: u32) -> Saved {
        Saved { x, y, width, height, maximized: false }
    }

    #[test]
    fn a_visible_window_stays_put() {
        assert_eq!(clamp(at(100, 80, 1440, 900), &[MAIN]), at(100, 80, 1440, 900));
        assert_eq!(clamp(at(2000, 100, 1440, 900), &[MAIN, RIGHT]), at(2000, 100, 1440, 900));
    }

    #[test]
    fn a_window_on_an_unplugged_monitor_is_centred_on_the_primary() {
        assert_eq!(clamp(at(2000, 100, 1440, 900), &[MAIN]), at(240, 90, 1440, 900));
        assert_eq!(clamp(at(-3000, 50, 1440, 900), &[MAIN]), at(240, 90, 1440, 900));
    }

    #[test]
    fn a_partly_off_screen_window_is_kept_only_while_its_title_bar_is_reachable() {
        // Hanging off the right edge but with a reachable title bar: left where it is.
        assert_eq!(clamp(at(1000, 100, 1440, 900), &[MAIN]), at(1000, 100, 1440, 900));
        // Only a sliver of the title bar left on screen: centred.
        assert_eq!(clamp(at(1850, 100, 1440, 900), &[MAIN]), at(240, 90, 1440, 900));
        // Title bar above the monitor: unreachable, so the window is centred.
        assert_eq!(clamp(at(100, -500, 1440, 900), &[MAIN]), at(240, 90, 1440, 900));
    }

    #[test]
    fn the_size_is_limited_to_the_monitor_and_the_minimum() {
        assert_eq!(clamp(at(0, 0, 5000, 3000), &[MAIN]), at(0, 0, 1920, 1080));
        assert_eq!(clamp(at(0, 0, 100, 100), &[MAIN]), at(0, 0, 940, 500));
    }

    #[test]
    fn no_monitors_means_no_change_and_maximized_is_kept() {
        assert_eq!(clamp(at(5, 5, 1440, 900), &[]), at(5, 5, 1440, 900));
        assert!(clamp(Saved { maximized: true, ..at(5000, 5, 1440, 900) }, &[MAIN]).maximized);
    }

    #[test]
    fn saves_and_reloads() {
        let dir = std::env::temp_dir().join(format!("vokko-window-{}", std::process::id()));
        let path = dir.join("window.json");
        let store = WindowStateStore::load(Some(path.clone()));
        store.set(|_| Some(at(10, 20, 1300, 800)));
        store.save();
        assert_eq!(WindowStateStore::load(Some(path)).get(), Some(at(10, 20, 1300, 800)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
