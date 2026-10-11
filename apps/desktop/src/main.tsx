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
import { bootstrap } from "./api/auth";
import { MOCK } from "./api/config";
import { initDesktop } from "./desktop";
import { gateway } from "./api/gateway";
import * as rest from "./api/rest";
import * as store from "./api/store";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/settings.css";
import "./styles/menus.css";
import "./styles/server-settings.css";
import "./styles/channel-settings.css";
import "./ui/prefs";

bootstrap();
void initDesktop(); // deep links + updater; no-op outside the Tauri webview

// Mock mode only: expose internals to Playwright scripts and the console (no effect in real builds).
if (MOCK) (window as unknown as { __vokko: unknown }).__vokko = { gateway, ...rest, ...store };

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
