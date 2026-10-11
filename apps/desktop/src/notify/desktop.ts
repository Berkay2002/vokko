// Desktop notifications behind one small adapter. The browser build uses the Notification API; inside Tauri the
// notification plugin's commands are invoked directly (the JS package is a thin wrapper over them, so no extra npm dependency
// and no edits in src-tauri here). If the plugin is not registered yet the Tauri adapter falls back to the Notification API.

import { invoke, isTauri } from "@tauri-apps/api/core";

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
    // The plugin has no click callback on desktop: the OS toast brings the app forward on its own. The title already names the channel.
    invoke("plugin:notification|notify", { options: { title: n.title, body: n.body, group: n.tag } }).catch(() => webAdapter.show(n));
  },
};

let override: NotificationAdapter | null = null;

/** The adapter for this runtime (tests may inject one). */
export function notificationAdapter(): NotificationAdapter {
  return override ?? (isTauri() ? tauriAdapter : webAdapter);
}

export function setNotificationAdapter(adapter: NotificationAdapter | null): void {
  override = adapter;
}
