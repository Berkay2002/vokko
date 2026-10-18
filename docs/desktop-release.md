# Desktop app: release, updater and OS integration

Everything here lives in `apps/desktop/src-tauri` (Rust) and `apps/desktop/src/desktop` (JS adapters, no-ops in the browser build).
No signing keys, endpoints or secrets are committed; releases supply them at build time.

## What the shell does

| Feature | Rust | JS adapter (`src/desktop`) |
|---|---|---|
| Tray icon: Open / Mute / Deafen (disabled until voice) / Quit; left click opens | `tray.rs` | `setTrayUnread(bool)` draws or clears the red unread dot (called from `notify/badge.ts` `applyUnread`) |
| Close to tray (default on; falls back to quitting if no tray exists) | `prefs.rs`, `on_window_event` in `main.rs` | `getDesktopPrefs()`, `setDesktopPrefs({ closeToTray, startMinimized })` |
| Run on startup, optional "start minimized" | `tauri-plugin-autostart`, arg `--autostart` | `getAutostart()`, `setAutostart(bool)` |
| Single instance: a second launch focuses the first (even from the tray). `VOKKO_MULTI_INSTANCE=1` opts out for side-by-side dev copies | `tauri-plugin-single-instance` | - |
| `vokko://invite/<code>` and `vokko://auth/callback?...` deep links | `links.rs`, `tauri-plugin-deep-link` | `onDeepLink(cb)`; invites default to routing `/invite/<code>` |
| Updater, inactive unless configured | `updates.rs`, `tauri-plugin-updater` | `useDesktopUpdate()`, `checkForUpdate()`, `restartToUpdate()` |
| Global shortcuts registry (nothing registered by default) | `shortcuts.rs`, `tauri-plugin-global-shortcut` | `registerShortcut`, `unregisterShortcut`, `listShortcuts`, `onShortcut` |
| Window controls: undecorated window off macOS, minimize/maximize/close drawn in the title bar | `window.rs` (`use_custom_controls`, `desktop_window_chrome`) | `useWindowChrome()`, `minimizeWindow()`, `toggleMaximizeWindow()`, `closeWindow()` (`windowControls.ts`) |
| Running programs for game detection (names and start times only) | `games.rs` (`desktop_list_processes`, `sysinfo`) | `listProcesses()`, `matchGame()` (`games.ts`, list in `detectableGames.json`) |
| Notifications | `tauri-plugin-notification`, capability `notification:default` | `src/notify/desktop.ts` invokes the plugin commands |

`initDesktop()` (called from `src/main.tsx`) starts deep-link delivery and the updater loop. `isDesktop()` tells a settings page
whether to show the desktop-only options at all.

Preferences are a JSON file (`desktop.json`) in the app config dir (see `crates/platform/src/app_dirs.rs`) because close-to-tray and
start-minimized are decided before the webview loads.

### Deep links

- Supported: `vokko://invite/<code>` (code: letters, digits, `-`, `_`, max 64) and `vokko://auth/callback?code=...&state=...`
  (OAuth redirect from the system browser; the query is passed through untouched, nothing in it is logged). Everything else is dropped.
  URLs over 4096 characters or with control characters are dropped.
- Adapter: `onDeepLink(link => ...)` receives `{ kind: "invite", code, url }` or `{ kind: "auth", url }`, `url` being the full
  original URL (parse `code`/`state` from it). An auth link that arrives before the first subscriber (cold start) is replayed to it.
  While at least one listener exists, invites go to the listeners instead of the default `/invite/<code>` routing.
- The scheme is declared in `tauri.conf.json` under `plugins.deep-link.desktop.schemes`. **The installer registers it** (NSIS/MSI on
  Windows, `.desktop` file on Linux, `Info.plist` on macOS). The app never writes registry keys itself, and bundling is currently
  off (`bundle.active: false`), so an unbundled debug build has no `vokko://` handler registered.
- Links that arrive before the webview loads (cold start, second-instance argv) queue in Rust and are handed over by
  `desktop_take_pending_links`, which the JS adapter calls once after subscribing.
- Test without an installer: `vokko-desktop.exe "vokko://invite/abc123"` (starts the app with the link, or forwards it to the running one).
- The SPA routes `/invite/:code` to the invite page.

### Global shortcuts

Register from JS: `registerShortcut("push-to-talk", "Ctrl+Shift+K")`, then `onShortcut(e => ...)` receives `pressed` and `released`
(push-to-talk needs both). A binding must include a non-modifier key; mouse buttons and bare modifiers can't be bound with the OS hotkey APIs
(Discord uses low-level hooks for those; out of scope for this groundwork).

## macOS

Everything macOS-specific is in `src-tauri/src/macos.rs` (`#[cfg(target_os = "macos")]`).

- **Native chrome**: the base window config has native decorations, and `window.rs` removes them at runtime only off macOS (the
  page draws its own controls there), so macOS keeps its traffic lights. The startup log prints `main window decorated: Ok(true)`.
- **Menu bar**: Vokko (About, Settings… Cmd+, , Services, Hide, Hide Others, Show All, Quit), Edit (Undo, Redo, Cut, Copy, Paste,
  Select All; the predefined items are what make text fields work), View (Toggle Full Screen; Reload in debug builds), Go
  (Quick Switcher, Inbox), Window (Minimize, Zoom, Close Window, Bring All to Front), Help (Vokko Help, Keyboard Shortcuts).
  There are no zoom items because the app has no zoom setting. Custom items bring the window forward and emit the
  `desktop-menu` event; `src/shell/NativeMenuBridge.tsx` maps the action onto a modal that already exists. Cmd+K and Cmd+I
  have no menu accelerator on purpose: the webview handles them and a menu key equivalent would swallow them.
- **Dock badge**: `notify/badge.ts` sets the tile label to mentions plus unread DM conversations (`dockBadgeLabel`: "99+" past 99,
  cleared at 0), through `Window.setBadgeLabel` (permissions in `capabilities/macos.json`, macOS only). The same summary feeds the tray dot, and it follows the "unread badge" preference.
- **Dock bounce**: `notify/controller.ts` asks for an informational bounce (`desktop_request_attention`) when `shouldBounce`
  holds: the message is a mention or DM, it would raise an OS notification (DND, mutes, "nothing" level, desktop notifications off
  and streamer mode all apply) and the window is not focused.
- **Dock click**: with the window hidden to the tray, clicking the Dock icon shows it again (`RunEvent::Reopen`).
- **Notification permission**: `tauri-plugin-notification` on desktop always answers "granted" and never prompts, so the
  "enable desktop notifications" banner never shows in the macOS app and a denial in System Settings can't be detected. macOS
  asks on the first notification of a bundled app; an unbundled dev binary is attributed to the terminal that started it.
  `desktopNotifications` defaults to off, so `needsPermissionPrompt` (notify/Banners.tsx) offers the "Enable Desktop Notifications"
  bar in the desktop shell while the pref is off; that is what turns notifications and the bounce on. A Notifications settings
  page should show the pref and, on macOS, point to System Settings, Notifications for the OS-level permission.
- **Microphone and camera**: WKWebView only exposes `navigator.mediaDevices` (getUserMedia and getDisplayMedia) when the bundle's
  `Info.plist` has `NSMicrophoneUsageDescription` and `NSCameraUsageDescription`; without them voice, video and screen share fail
  with no prompt. The ad-hoc signature turns on the hardened runtime, so `Entitlements.plist` (`bundle.macOS.entitlements`) grants
  `device.audio-input`, `device.camera` and `automation.apple-events` (the Spotify reader). Check a build with
  `codesign -d --entitlements - Vokko.app`. The plist is merged only into the `.app`, so an unbundled dev binary never has it.
- **Background throttling**: the main window sets `backgroundThrottling: "disabled"` (macOS 14+; ignored elsewhere). Without it
  WebKit suspends a hidden or occluded page, so a window closed to the tray stops its timers and the gateway, and with them
  notifications and the Dock badge.
- **Website games**: WebKit sends no Referer and leaves `document.referrer` empty for a frame whose parent is `tauri://localhost`,
  and Shell Shockers fails on that (`"" cannot be parsed as a URL`, stuck on its loading bar). On a `tauri:` origin `GameTile`
  frames `<API origin>/web-game.html` instead, which loads the game in a nested iframe so the game sees an https referrer
  (`webGameWrapper` in games/frameHost.ts). The Caddyfile serves that page without the app's `frame-ancestors 'none'`.
  Windows (WebView2, `http://tauri.localhost`) and the browser build frame the game directly. Krunker, skribbl.io and
  Smash Karts load either way.
- **Debugging without screen capture** (debug builds): `VOKKO_DEBUG_DOCK=1` logs the Dock tile's badge label whenever it
  changes; the menu bar and window decoration state are logged once at startup.

## Linux

x86_64 only, built on the Windows PC in a WSL 2 distro (GitHub Actions is not available). Downloads: `Vokko-linux.AppImage` (what
the updater installs, `linux-x86_64` in `latest.json`) and `Vokko-linux.deb`, next to the versioned `Vokko_<v>_amd64.*` files.
The release overlay's `targets` stays `["nsis"]`; Linux passes `--bundles appimage,deb` the way macOS passes `app,dmg`.

- Platform code: the process list (`games.rs`, `streamer.rs`) reads `/proc`; app info gives the executable name with no icon;
  the local Spotify read answers nothing (no MPRIS), so a Linux desktop sends no Spotify activity; the page draws the window
  buttons as on Windows. The tray needs an AppIndicator host (GNOME needs the AppIndicator extension); without one the
  icon is invisible and a window closed to the tray comes back by starting Vokko again (single instance).
- `vokko://`: the .deb registers it through its `.desktop` file; an AppImage registers itself on every start (`register_all` in
  `main.rs` when `$APPIMAGE` is set: a `vokko-desktop-handler.desktop` file in `~/.local/share/applications`, then
  `update-desktop-database` and `xdg-mime`, which desktop distros ship; a failure is only logged).
- `tools/release-linux.sh <version> <out dir>` builds from the checkout's HEAD (sent in as a git bundle; the distro has no GitHub
  credentials), signs the AppImage with `~/.vokko/updater.key` passed through `WSLENV` and copies the AppImage, its `.sig` and
  the .deb to `<out dir>`. It uploads nothing, so running it alone is the Linux-only dry run.

One-time setup of the distro, from a Windows shell (everything on E:; it never touches the `docker-desktop` distro):

```bat
mkdir E:\WSL\vokko-linux
curl -L -o E:\WSL\jammy.rootfs.tar.gz https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz
wsl --import vokko-linux E:\WSL\vokko-linux E:\WSL\jammy.rootfs.tar.gz --version 2
```

Then as root in the distro: `apt-get install build-essential curl wget file git xdg-utils pkg-config libssl-dev libxdo-dev
libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev xz-utils patchelf gstreamer1.0-plugins-base
gstreamer1.0-plugins-good` (patchelf and the plugins are for `bundleMediaFramework`, below), `useradd -m -s /bin/bash vokko` and
`[user] default=vokko` in `/etc/wsl.conf`; as `vokko`: rustup (stable, clippy) and Node 22 unpacked to `~/node` (the script puts
`~/node/bin` and `~/.cargo/bin` on PATH). Built on Ubuntu 22.04, the binary needs glibc 2.34 or newer (Debian 12, Ubuntu 22.04,
Fedora 35 and later).
Remove it all with `wsl --unregister vokko-linux` and deleting `E:\WSL`.

The AppImage carries its own GStreamer plugins (`bundle.linux.appimage.bundleMediaFramework` in `tauri.conf.json`, about +12 MB).
Without them the bundled `libgstreamer` looks for plugins only inside the AppImage, finds none and WebKit logs `GStreamer element
appsink not found` (no audio or video in the page). The .deb needs nothing extra: `libwebkit2gtk-4.1-0` depends on the plugins.

### Linux smoke test

Headless, on any Ubuntu 22.04+ box with the setup packages above plus `xvfb imagemagick xdotool dbus`. Build unsigned and
against the in-app mock backend (no `VITE_VOKKO_API`), with the updater pointed at a port nothing listens on (it must be https,
or the updater plugin refuses the config and the app exits at startup):

```sh
echo '{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"endpoints":["https://127.0.0.1:9/latest.json"]}}}' > /tmp/smoke.json
npm ci && cd apps/desktop && NO_STRIP=1 npx tauri build --config release.production.json --config /tmp/smoke.json --bundles appimage,deb
Xvfb :97 -screen 0 1440x900x24 -nolisten tcp & export DISPLAY=:97
dbus-run-session -- ../../target/release/bundle/appimage/Vokko_0.1.8_amd64.AppImage &   # wait ~15 s
import -window root login.png; xdotool mousemove 720 527 click 1; sleep 8; import -window root shell.png
```

Results (0.1.8 + media framework, Ubuntu 26.04, Xvfb): the window renders at 1440x900 with the login page and, after Log In, the
app shell; WebKitGTK needs no `WEBKIT_DISABLE_COMPOSITING_MODE` (software GL; the `libEGL ... /dev/dri` warnings are harmless).
No tray host: only a libayatana deprecation warning, no crash. A second start exits 0 and leaves one window (single instance).
The first update check (30 s after start) logs `failed to check for updates` and the app carries on.
Run it under `dbus-run-session`: over SSH the user's session bus can hold a stuck `xdg-desktop-portal`, and GTK then waits on
its D-Bus call for ~25 s before the window appears. Desktop sessions have a working portal, so real users don't see this.

**No voice, video or screen share on Linux.** WebKitGTK builds WebRTC only as an experimental feature (`ENABLE_WEB_RTC`
defaults to `ENABLE_EXPERIMENTAL_FEATURES` in `OptionsGTK.cmake`, off in release tarballs) and Ubuntu, Debian, Fedora and Arch
don't turn it on. Checked on WebKitGTK 2.52.6 (Ubuntu 26.04) with `enable-webrtc` and `enable-media-stream` set: `getUserMedia`
and `getDisplayMedia` exist, `RTCPeerConnection` is undefined. No GStreamer plugin fixes that, so the AppImage and the .deb
can't join LiveKit (calls, screen share, Watch Together streams). `joinRefusal` (voice/engine.ts) answers
`webrtc_unsupported` when `RTCPeerConnection` is missing against a real server, and the voice panel says to use the browser;
the Stremio / Spotify viewer Room (stremio/viewerConnection.ts) goes to `unsupported` instead of retrying and its tile says the
same. The mock backend (FakeTransport, FakeViewer) still works. Making it work needs our own WebKitGTK built with `-DENABLE_WEB_RTC=ON
-DUSE_GSTREAMER_WEBRTC=ON` bundled in the AppImage (plus gstreamer1.0-plugins-bad and gstreamer1.0-nice), or native LiveKit in
the Rust backend.

## Updater

Inactive by default: the updater plugin refuses to start without `pubkey`, so it is only registered when the Tauri config contains a
`plugins.updater` entry at compile time, and every update command then answers `{ "state": "disabled" }`. The app logs
`updater configured: true|false` at startup.

### One-time setup

```powershell
# keep the private key OUTSIDE the repo
npx tauri signer generate -w "$env:USERPROFILE\.vokko\updater.key"
```

The command prints the public key; the private key and its password stay in your release environment / CI secrets.

### Building a release

Write the release overlay to a file that is not committed (for example `release.json`) and pass it with `--config`. The CLI hands the
same JSON to the Rust build through the `TAURI_CONFIG` environment variable, so the updater plugin sees it too.

```json
{
  "bundle": { "active": true, "targets": ["nsis"], "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "<public key printed by signer generate>",
      "endpoints": ["https://updates.example.com/vokko/{{target}}-{{arch}}/{{current_version}}"],
      "windows": { "installMode": "passive" }
    }
  }
}
```

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.vokko\updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"
cd apps\desktop
npx tauri build --config release.json
```

`apps/desktop/release.production.json` is the tracked production overlay: NSIS on Windows (`--bundles app,dmg` on macOS), API and CSP for
https://vokko.example.com and LiveKit Cloud, and the updater (public key, endpoint `https://vokko.example.com/downloads/latest.json`). The private key
and its password live outside the repo in `~/.vokko/updater.key` and `~/.vokko/updater.key.password` on the Windows PC and on buildhost; losing
them means installed apps can never be updated again, so keep a backup. **Release with `tools/release-desktop.sh <version> "notes"`** from Git
Bash on the Windows PC: it bumps the version, builds all three platforms (Linux through `tools/release-linux.sh`, see Linux
below), uploads them to `/downloads/` and writes `latest.json` last. It pulls first and re-execs the pulled copy of itself (its body
is one function, so the pull can't change the script under the running bash). `latest.json` goes out only after it lists
`windows-x86_64`, `darwin-aarch64` and `linux-x86_64` at the new version and each url answers `curl -fsI`; the served copy is
checked the same way, and any miss fails the run loudly. `tools/release-desktop.sh --dry-run` builds all three at the current
version (no bump, commit, push or upload; main must equal origin/main, which buildhost builds) and checks a local `latest.json`.
The macOS app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"` in the overlay). Without it the binary is only linker-signed
with no sealed resources, and a downloaded copy opens as "Vokko is damaged" with no way past it. Ad-hoc is not notarized: macOS
still warns once, and the user allows it under System Settings, Privacy & Security, Open Anyway (or runs
`xattr -dr com.apple.quarantine /Applications/Vokko.app`). Only a paid Developer ID with notarization removes the warning.

(`npm run desktop:build` passes `--no-bundle`, so it produces no installer or signature.) The build writes the installer plus a `.sig`
next to the updater artifact under `target\release\bundle`. Upload both and serve either the dynamic endpoint above or a static
manifest:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-10-11T12:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<contents of the .sig file>", "url": "https://updates.example.com/vokko/Vokko_0.2.0_x64-setup.exe" }
  }
}
```

Endpoints must be HTTPS. Bump `version` in `tauri.conf.json`, `Cargo.toml` and `package.json` together; the updater only installs a
strictly newer version.

### Runtime flow

1. `initUpdater()` (via `initDesktop()`) checks 30 s after launch and then every 4 h, only when the build is configured. The server also
   pushes the latest release: it reads `latest.json` from the downloads directory every 60 s (`VOKKO_DESKTOP_LATEST_JSON`, set in
   deploy/docker-compose.yml) and sends its `version` in READY `desktop_version` and, when it changes, as `DESKTOP_VERSION` to every
   connected session. `noticeLatestVersion()` (wired in main.tsx) runs the same check right away when that version is newer than the
   app's, unless a check or download is under way or an update is already ready. So a release reaches running apps within about a
   minute of `latest.json` being written; the 4 h timer stays as the fallback.
2. `check` finds an update: status `available`; it downloads in the background (`downloading` with byte progress); status `ready`.
3. The shell shows the "update ready, restart" banner from `useDesktopUpdate()` (`status.state === "ready"`) and calls `restartToUpdate()`.
   On Windows the installer takes over and exits the app; on macOS/Linux the app restarts itself. The download is never installed
   without that user action.

## Window controls

Off macOS the window is created without decorations (`window.rs`) and the title bar draws the minimize, maximize and close buttons with
Tauri drag regions; macOS keeps its native traffic lights, and the web build is unchanged. The window API needs
`core:window:allow-minimize`, `-toggle-maximize`, `-close` and `-start-dragging` in `capabilities/default.json`. Close goes through
`window.close()`, so close-to-tray still applies. Windows 11 snap layouts (hover on maximize) are not available: tao has no
`HTMAXBUTTON` handling. Win+Z and drag-to-edge still work.

## Game detection

`desktop_list_processes` returns running program names and start times (no paths, window titles or command lines leave the Rust side).
The frontend matches them against `src/desktop/detectableGames.json` (an editable list of about 50 games and apps; add entries as
`{ "name", "exe": [...] }`; add `"kind": "app"` for programs that stay open all day, such as editors and OBS: a running game
always wins over them) and the games the user added under Settings > Registered Apps, and sends the match as a `Playing`
activity (`activities` on gateway op 3, see docs/api.md). Among games the one that started first wins. Only the desktop app
sends `activities`, again after every reconnect; a browser session of the same account leaves the field out. Sharing can be
switched off in Registered Apps and Activity Privacy.

## Debug helpers

- `VOKKO_DEBUG_TRAY_MENU=1` (debug builds only) pops the tray menu up over the window 4 s after launch, for screenshots.
- `npx tauri build --debug --no-bundle` builds `target/debug/vokko-desktop.exe` with the frontend embedded; it does not need Vite.
