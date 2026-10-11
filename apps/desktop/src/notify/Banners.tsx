import { useEffect, useState } from "react";
import { BellRing, WifiOff, X } from "lucide-react";
import { gateway } from "../api/gateway";
import { useStore } from "../api/store";
import { setPref, usePrefs } from "../ui/prefs";
import { notificationAdapter, type PermissionState } from "./desktop";
import "./notify.css";

/** The connection banner waits this long before appearing, so a quick resume never flashes it. */
export const BANNER_GRACE_MS = 1500;
const DISMISSED_KEY = "vokko.notify.promptDismissed";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** True once `active` has been true for `delay` ms; false again the moment it ends. */
function useDelayed(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

function ConnectionBar({ offline }: { offline: boolean }) {
  return (
    <div className="notify-banner notify-banner-critical" role="alert" data-testid="connection-banner">
      <WifiOff size={16} aria-hidden />
      <span className="notify-banner-text">{offline ? "You're offline. Vokko will reconnect when your network is back." : "Connection lost. Trying to reconnect…"}</span>
      <button type="button" className="notify-banner-button" onClick={() => gateway.retryNow()}>
        Reconnect now
      </button>
    </div>
  );
}

function PermissionBar({ onDone }: { onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    const result = await notificationAdapter().request();
    setPref("desktopNotifications", result === "granted");
    setBusy(false);
    onDone();
  };
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* the banner returns next session */
    }
    onDone();
  };
  return (
    <div className="notify-banner notify-banner-brand" role="region" aria-label="Desktop notifications" data-testid="permission-banner">
      <BellRing size={16} aria-hidden />
      <span className="notify-banner-text">Vokko needs your permission to enable desktop notifications.</span>
      <button type="button" className="notify-banner-button" disabled={busy} onClick={() => void enable()}>
        Enable Desktop Notifications
      </button>
      <button type="button" className="notify-banner-close" aria-label="No thanks" onClick={dismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Top-of-window banners: connection state first, otherwise the one-time notification permission prompt. */
export function NotifyBanners() {
  const loggedIn = useStore(s => !!s.token && s.ready);
  const connection = useStore(s => s.connection);
  const desktopPref = usePrefs(s => s.desktopNotifications);
  const online = useOnline();
  const disrupted = loggedIn && (connection !== "ready" || !online);
  const showConnection = useDelayed(disrupted, BANNER_GRACE_MS);

  const [permission, setPermission] = useState<PermissionState>("granted");
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    void notificationAdapter()
      .permission()
      .then(p => !cancelled && setPermission(p));
    return () => {
      cancelled = true;
    };
  }, [loggedIn, desktopPref]);

  const showPermission = loggedIn && !showConnection && !dismissed && !desktopPref && permission === "default";
  const visible = showConnection || showPermission;
  useEffect(() => {
    document.documentElement.classList.toggle("has-top-banner", visible);
    return () => document.documentElement.classList.remove("has-top-banner");
  }, [visible]);

  if (showConnection) return <ConnectionBar offline={!online} />;
  if (showPermission) return <PermissionBar onDone={() => setDismissed(true)} />;
  return null;
}
