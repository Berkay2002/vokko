//! Windows: hides the "<origin> is sharing your screen [Stop sharing] Hide" bar that WebView2 shows for every getDisplayMedia
//! capture. It is Chromium's ScreenCaptureNotificationUI, which no WebView2 API or browser switch turns off; its "Hide" only
//! minimizes it, so it comes back from the taskbar. The app has its own share controls, so the bar's window is hidden instead.

use tauri::AppHandle;

/// Called by the page once a screen share is live. Returns at once; the lookup runs on its own thread.
#[tauri::command]
pub fn desktop_hide_share_bar(app: AppHandle) {
    #[cfg(windows)]
    win::hide(&app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod win {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SW_HIDE, ShowWindow};
    use windows_core::BOOL;

    use crate::window::MAIN_WINDOW;

    pub fn hide(app: &AppHandle) {
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        // The bar's title is its text, which names the page's origin ("http://tauri.localhost is sharing your screen.") in every locale.
        let Some(host) = window.url().ok().and_then(|url| url.host_str().map(str::to_owned)) else {
            return;
        };
        let (tx, rx) = mpsc::channel();
        let _ = window.with_webview(move |webview| {
            let mut pid = 0u32;
            // SAFETY: runs on the main thread with a live controller owned by the webview.
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    let _ = core.BrowserProcessId(&mut pid);
                }
            }
            let _ = tx.send(pid);
        });
        // Commands run on the main thread, which with_webview needs: wait for the pid elsewhere.
        std::thread::spawn(move || {
            let Ok(pid) = rx.recv_timeout(Duration::from_secs(2)) else {
                return;
            };
            if pid == 0 {
                return;
            }
            // The bar appears as the capture starts; give it a few seconds.
            for _ in 0..50 {
                if hide_bar(pid, &host) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            log::warn!("screen share bar not found");
        });
    }

    /// Hides every visible top-level window of the WebView2 browser process whose title names `host`. True if one was hidden.
    fn hide_bar(pid: u32, host: &str) -> bool {
        let mut windows: Vec<HWND> = Vec::new();
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            // SAFETY: lparam is the `windows` Vec below, alive for the whole EnumWindows call.
            unsafe { (*(lparam.0 as *mut Vec<HWND>)).push(hwnd) };
            BOOL(1)
        }
        let mut hidden = false;
        // SAFETY: the callback only pushes into `windows`; the handles are used right away and a stale one just fails the calls.
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut Vec<HWND> as isize));
            for hwnd in windows {
                let mut owner = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut owner));
                if owner != pid || !IsWindowVisible(hwnd).as_bool() {
                    continue;
                }
                let mut buf = [0u16; 512];
                let len = usize::try_from(GetWindowTextW(hwnd, &mut buf)).unwrap_or(0);
                if String::from_utf16_lossy(&buf[..len]).contains(host) {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    hidden = true;
                }
            }
        }
        hidden
    }
}
