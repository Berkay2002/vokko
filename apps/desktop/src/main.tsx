import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/latin-ext-400.css";
import "@fontsource/noto-sans/latin-500.css";
import "@fontsource/noto-sans/latin-ext-500.css";
import "@fontsource/noto-sans/latin-600.css";
import "@fontsource/noto-sans/latin-ext-600.css";
import "@fontsource/noto-sans/latin-700.css";
import "@fontsource/noto-sans/latin-ext-700.css";
import { App } from "./App";
import { Measure } from "./perf/Measure";
import { bootstrap } from "./api/auth";
import { MOCK } from "./api/config";
import { loadMockBackend } from "./api/mockBackend";
import * as desktop from "./desktop";
import { initDesktop } from "./desktop";
import { startGameDetection } from "./activity";
import { startIdlePresence } from "./shell/idle";
import { gateway } from "./api/gateway";
import * as rest from "./api/rest";
import * as store from "./api/store";
import { messageStore } from "./chat/messageStore";
import { preloadHighlighter } from "./chat/markdown";
import { preloadSettings } from "./shell/Modals";
import { installStaleChunkReload } from "./shell/staleChunks";
import { preloadLazyModules } from "./ui/lazyModule";
import { startNotify } from "./notify";
import { installCrashReporter } from "./report/crashReporter";
import { restoreStartupCache, startStartupCache } from "./cache/startupCache";
import { installStartupMarks } from "./perf/startupMarks";
import { getToken } from "./api/config";
import { wireOverlay } from "./overlay/bridge";
import { installLogCapture } from "./report/logBuffer";
import { startThreadMuteMigration } from "./threads/muteMigration";
import * as localState from "./shell/localState";
import * as prefs from "./ui/prefs";
import * as sounds from "./notify/sounds";
import "./styles/tokens.css";
import "./styles/themes.generated.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/settings.css";
import "./styles/settings-modal.css";
import "./styles/menus.css";
import "./styles/server-settings.css";
import "./styles/channel-settings.css";
import "./styles/perks.css";
import "./styles/profiles.css";
import "./styles/server-perks.css";
import "./styles/invite.css";
import "./styles/shortcuts.css";
import "./styles/responsive.css";
import "./styles/a11y.css";
import "./ui/prefs";
import "./ui/settingsSyncLive";
import "./notify/guildSettingsSync";
import "./ui/keybindsLive";
import "./appicon/apply";
import "./search";
import "./community";
import "./account";
import "./media";
import "./voice";
import "./calls";
import "./soundboard";

installStaleChunkReload(); // a tab left open across a redeploy reloads (or offers to) when an old chunk is gone
installLogCapture(); // console warnings/errors feed "Report a problem" (scrubbed, kept in memory)
installCrashReporter(); // uncaught errors and saved desktop panics go to POST /crash-reports (opt-out in Data & Privacy)

// Mock mode only: expose internals to Playwright scripts and the console (no effect in real builds).
// Specs reach app modules through here, never import('/src/...'): after an HMR edit the app holds `?t=` instances and a bare import gets a second copy.
if (MOCK) (window as unknown as { __vokko: unknown }).__vokko = { gateway, desktop, messageStore, localState, prefs, sounds, ...rest, ...store };

// Mock mode: the in-memory backend is a separate chunk (real builds never load it); it must be up before the session starts.
if (MOCK) await loadMockBackend();

installStartupMarks();
// The last channel and its newest messages from IndexedDB, on screen (stale) until READY. Waits at most 400 ms.
await restoreStartupCache(getToken()).catch(() => false);
startStartupCache();
bootstrap();
startNotify();
startThreadMuteMigration(); // old per-device thread mutes move onto the server thread member, once
void initDesktop(); // deep links + updater + tray unread dot; no-op outside the Tauri webview
// A release the server announces is checked for right away (the updater ignores it in the browser or without updater config).
gateway.on("READY", ready => void (ready.desktop_version && desktop.noticeLatestVersion(ready.desktop_version)));
gateway.on("DESKTOP_VERSION", ({ version }) => void desktop.noticeLatestVersion(version));
startGameDetection(); // desktop only: detected game goes out as presence
startIdlePresence(); // 10 minutes without input: Online becomes Idle
wireOverlay(); // desktop only: feeds the in-game overlay window

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Measure id="app">
        <App />
      </Measure>
    </React.StrictMode>,
  );
}

// Chunks split out of the startup bundle (code highlighting, the settings screens, the voice page and perk art), fetched once the first paint is done so they are
// ready before anyone needs them.
const whenIdle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 1500));
whenIdle(() => {
  preloadHighlighter().catch(() => {}); // only a warm-up: code blocks load it again on demand
  preloadSettings();
  void preloadLazyModules();
});
