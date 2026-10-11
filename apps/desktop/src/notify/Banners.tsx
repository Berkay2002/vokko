import { useEffect, useState } from "react";
import { BellRing, Download, WifiOff, X } from "lucide-react";
import { gateway } from "../api/gateway";
import { useStore } from "../api/store";
import { restartToUpdate, useDesktopUpdate } from "../desktop";
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

/** A downloaded desktop update waiting for a restart. Not dismissible: it stays until Vokko restarts. */
function UpdateBar({ version }: { version: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const restart = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await restartToUpdate();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <div className="notify-banner notify-banner-brand" role="region" aria-label="Update ready" data-testid="update-banner">
      <Download size={16} aria-hidden />
      <span className="notify-banner-text">{failed ? "Couldn't install the update. Try again." : `Update ready: Vokko ${version} is ready to install.`}</span>
      <button type="button" className="notify-banner-button" disabled={busy} onClick={() => void restart()}>
        Restart to Update
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

/** Top-of-window banners, one at a time: connection state, then a ready update, then the one-time notification permission prompt. */
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

  const readyVersion = useDesktopUpdate(s => (s.status.state === "ready" ? s.status.version : null));
  const showUpdate = !showConnection && readyVersion !== null;

  const showPermission = loggedIn && !showConnection && !showUpdate && !dismissed && !desktopPref && permission === "default";
  const visible = showConnection || showUpdate || showPermission;
  useEffect(() => {
    document.documentElement.classList.toggle("has-top-banner", visible);
    return () => document.documentElement.classList.remove("has-top-banner");
  }, [visible]);

  if (showConnection) return <ConnectionBar offline={!online} />;
  if (showUpdate && readyVersion !== null) return <UpdateBar version={readyVersion} />;
  if (showPermission) return <PermissionBar onDone={() => setDismissed(true)} />;
  return null;
}
