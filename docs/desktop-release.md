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
- The SPA has no `/invite/:code` route yet; until it exists the router's catch-all sends the user to `/channels/@me`.

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
- **Debugging without screen capture** (debug builds): `VOKKO_DEBUG_DOCK=1` logs the Dock tile's badge label whenever it
  changes; the menu bar and window decoration state are logged once at startup.

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

`apps/desktop/release.production.json` is a tracked overlay for an unsigned Windows installer against https://vokko.example.com (no updater; its CSP also allows the production host and LiveKit Cloud): `$env:VITE_VOKKO_API="https://vokko.example.com"; cd apps\desktop; npx tauri build --config release.production.json`.

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

1. `initUpdater()` (via `initDesktop()`) checks 30 s after launch and then every 4 h, only when the build is configured.
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
always wins over them) and the games the user added under Settings > Registered Games, and sends the match as a `Playing`
activity (`activities` on gateway op 3, see docs/api.md). Among games the one that started first wins. Only the desktop app
sends `activities`, again after every reconnect; a browser session of the same account leaves the field out. Sharing can be
switched off in Registered Games and Activity Privacy.

## Debug helpers

- `VOKKO_DEBUG_TRAY_MENU=1` (debug builds only) pops the tray menu up over the window 4 s after launch, for screenshots.
- `npx tauri build --debug --no-bundle` builds `target/debug/vokko-desktop.exe` with the frontend embedded; it does not need Vite.
