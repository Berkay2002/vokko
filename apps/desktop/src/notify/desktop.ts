// Desktop notifications behind one small adapter. The browser build uses the Notification API; inside Tauri the
// notification plugin's commands are invoked directly (the JS package is a thin wrapper over them, so no extra npm dependency).
// If the plugin is not registered yet the Tauri adapter falls back to the Notification API.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { onDesktopEvent } from "../desktop/tauri";

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

export interface DesktopNotification {
  title: string;
  body: string;
  icon?: string;
  /** A newer notification with the same tag replaces the older one (one per channel). */
  tag: string;
  onClick(): void;
}

export interface NotificationAdapter {
  readonly kind: "web" | "tauri";
  permission(): Promise<PermissionState>;
  request(): Promise<PermissionState>;
  show(notification: DesktopNotification): void;
}

const webSupported = () => typeof Notification !== "undefined";

const webAdapter: NotificationAdapter = {
  kind: "web",
  permission() {
    return Promise.resolve(webSupported() ? Notification.permission : "unsupported");
  },
  async request() {
    if (!webSupported()) return "unsupported";
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  },
  show(n) {
    if (!webSupported() || Notification.permission !== "granted") return;
    try {
      const shown = new Notification(n.title, { body: n.body, icon: n.icon, tag: n.tag });
      shown.onclick = () => {
        try {
          window.focus();
        } catch {
          /* some embedders refuse */
        }
        shown.close();
        n.onClick();
      };
    } catch {
      /* e.g. Android Chrome only allows notifications through a service worker */
    }
  },
};

/** The shell emits the clicked notification's id (`src-tauri/src/notifications.rs`). */
const CLICK_EVENT = "desktop-notification-click";
/** Only the newest notifications keep a route; a click on an older one still brings the window forward. */
const MAX_CLICKABLE = 100;

/** Notification id -> its click handler. Ids start at a random point so a toast from before a reload can't hit a new handler. */
export function createClickRouter(start = 1 + Math.floor(Math.random() * 2 ** 30), max = MAX_CLICKABLE) {
  const handlers = new Map<number, () => void>();
  let next = start;
  return {
    add(onClick: () => void): number {
      const id = next;
      next = next >= 2 ** 31 - 1 ? 1 : next + 1; // the plugin takes an i32
      handlers.set(id, onClick);
      if (handlers.size > max) handlers.delete(handlers.keys().next().value as number);
      return id;
    },
    click(id: number): boolean {
      const handler = handlers.get(id);
      if (!handler) return false;
      handlers.delete(id);
      handler();
      return true;
    },
  };
}

const clicks = createClickRouter();
let clicksWired = false;

const tauriAdapter: NotificationAdapter = {
  kind: "tauri",
  async permission() {
    try {
      const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      if (granted === true) return "granted";
      return webSupported() && Notification.permission === "denied" ? "denied" : "default";
    } catch {
      return webAdapter.permission();
    }
  },
  async request() {
    try {
      const result = await invoke<NotificationPermission>("plugin:notification|request_permission");
      return result;
    } catch {
      return webAdapter.request();
    }
  },
  show(n) {
    if (!clicksWired) {
      clicksWired = true;
      void onDesktopEvent<number>(CLICK_EVENT, id => clicks.click(id));
    }
    const id = clicks.add(n.onClick);
    invoke("plugin:notification|notify", { options: { id, title: n.title, body: n.body, group: n.tag } }).catch(() => webAdapter.show(n));
  },
};

/** Settings > Notifications > taskbar flashing: asks the OS to flash the taskbar button / bounce the dock icon (desktop only). */
export async function flashTaskbar(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    return true;
  } catch {
    return false;
  }
}

let override: NotificationAdapter | null = null;

/** The adapter for this runtime (tests may inject one). */
export function notificationAdapter(): NotificationAdapter {
  return override ?? (isTauri() ? tauriAdapter : webAdapter);
}

export function setNotificationAdapter(adapter: NotificationAdapter | null): void {
  override = adapter;
}
