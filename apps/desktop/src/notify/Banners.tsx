import { useEffect, useRef, useState } from "react";
import { BellRing, Check, Download, Wrench, WifiOff, X } from "lucide-react";
import { useConnectionState, useCountdown, type ConnectionState } from "../api/connection";
import { gateway } from "../api/gateway";
import { useStore } from "../api/store";
import { flushDrafts } from "../chat/draftStore";
import { formatDateTime } from "../chat/util";
import { restartToUpdate, useDesktopUpdate } from "../desktop";
import { setPref, usePrefs } from "../ui/prefs";
import { ConnectionStatusModal } from "./ConnectionStatus";
import { notificationAdapter, type PermissionState } from "./desktop";
import { startMaintenanceWatch, useMaintenance, type MaintenanceNotice } from "./maintenance";
import "./notify.css";

/** The connection banner waits this long before appearing, so a quick resume never flashes it. */
export const BANNER_GRACE_MS = 1500;
/** How long the green "Connected" strip stays after a banner that was shown ends. */
export const CONNECTED_FLASH_MS = 2500;
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

function ConnectionBar({ offline, connection }: { offline: boolean; connection: ConnectionState }) {
  const [details, setDetails] = useState(false);
  const secondsLeft = useCountdown(connection.nextRetryAt);
  // the alert announces only the static part; the changing countdown stays out of the accessibility tree
  let text: string;
  let live: string | null = null;
  if (offline) text = "You're offline. Vokko will reconnect when your network is back.";
  else if (secondsLeft !== null && secondsLeft > 0) {
    text = "Connection lost. Retrying";
    live = ` in ${secondsLeft}s (attempt ${connection.attempt})`;
  } else text = connection.attempt > 0 ? `Connection lost. Reconnecting… (attempt ${connection.attempt})` : "Connection lost. Reconnecting…";
  return (
    <div className="notify-banner notify-banner-critical" role="alert" data-testid="connection-banner" data-attempt={connection.attempt} data-offline={offline}>
      <WifiOff size={16} aria-hidden />
      <span className="notify-banner-text">
        {text}
        {live && <span aria-hidden>{live}</span>}
      </span>
      <button type="button" className="notify-banner-button" onClick={() => gateway.retryNow()}>
        Reconnect now
      </button>
      <button type="button" className="notify-banner-link" onClick={() => setDetails(true)}>
        Details
      </button>
      <ConnectionStatusModal open={details} onClose={() => setDetails(false)} />
    </div>
  );
}

/** The red banner turns green for a moment once the connection is back. */
function ConnectedFlash() {
  return (
    <div className="notify-banner notify-banner-positive" role="status" data-testid="connection-restored">
      <Check size={16} aria-hidden />
      <span className="notify-banner-text">Connected</span>
    </div>
  );
}

function MaintenanceBar({ notice, onDismiss }: { notice: MaintenanceNotice; onDismiss(): void }) {
  const starts = notice.startsAt ? new Date(notice.startsAt) : null;
  const scheduled = starts !== null && !Number.isNaN(starts.getTime()) && starts.getTime() > Date.now();
  const when = scheduled && starts ? ` Starts ${formatDateTime(starts)}.` : "";
  return (
    <div className="notify-banner notify-banner-warning" role="region" aria-label="Maintenance" data-testid="maintenance-banner">
      <Wrench size={16} aria-hidden />
      <span className="notify-banner-text">
        {scheduled ? "Scheduled maintenance: " : "Maintenance: "}
        {notice.message}
        {when}
      </span>
      <button type="button" className="notify-banner-close" aria-label="Dismiss" onClick={onDismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** The update is downloading in the background; nothing to click yet. */
function DownloadingBar({ version, fraction }: { version: string; fraction: number | null }) {
  return (
    <div className="notify-banner notify-banner-brand" role="status" aria-label="Downloading update" data-testid="update-downloading-banner">
      <Download size={16} aria-hidden />
      <span className="notify-banner-text">
        Downloading Vokko {version}
        {fraction !== null ? ` (${Math.round(fraction * 100)}%)` : "…"}
      </span>
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
      flushDrafts();
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

/**
 * The desktop shell's notification plugin never prompts and always reports "granted", so the pref (off by default) is the only
 * switch: offer it there too. In a browser the prompt is for the real permission and only shows while it is undecided.
 */
export function needsPermissionPrompt(kind: "web" | "tauri", permission: PermissionState): boolean {
  return permission === "default" || (kind === "tauri" && permission === "granted");
}

/** Dismissing the permission bar is permanent (no expiry): the pref in Settings is the way back. */
export function isPromptDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPrompt(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* the banner returns next session */
  }
}

function PermissionBar({ onDone, desktopShell }: { onDone(): void; desktopShell: boolean }) {
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    const result = await notificationAdapter().request();
    setPref("desktopNotifications", result === "granted");
    setBusy(false);
    onDone();
  };
  const dismiss = () => {
    dismissPrompt();
    onDone();
  };
  return (
    <div className="notify-banner notify-banner-brand" role="region" aria-label="Desktop notifications" data-testid="permission-banner">
      <BellRing size={16} aria-hidden />
      <span className="notify-banner-text">{desktopShell ? "Desktop notifications are off. Turn them on to hear about mentions and DMs." : "Vokko needs your permission to enable desktop notifications."}</span>
      <button type="button" className="notify-banner-button" disabled={busy} onClick={() => void enable()}>
        Enable Desktop Notifications
      </button>
      <button type="button" className="notify-banner-close" aria-label="No thanks" onClick={dismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Top-of-window banners, one at a time: connection state, the "Connected" flash, a maintenance notice, a desktop update, then the one-time notification permission prompt. */
export function NotifyBanners() {
  const loggedIn = useStore(s => !!s.token && s.ready);
  const connection = useConnectionState();
  const desktopPref = usePrefs(s => s.desktopNotifications);
  const online = useOnline();
  const disrupted = loggedIn && (connection.status !== "ready" || !online);
  const showConnection = useDelayed(disrupted, BANNER_GRACE_MS);

  // "Connected": only after a connection banner was actually on screen, so a quick resume stays silent.
  const [flash, setFlash] = useState(false);
  const wasShown = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (wasShown.current && !showConnection && loggedIn && connection.status === "ready" && online) {
      setFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), Math.max(CONNECTED_FLASH_MS, usePrefs.getState().minNotificationDuration * 1000));
    }
    wasShown.current = showConnection;
  }, [showConnection, loggedIn, connection.status, online]);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!loggedIn) return;
    return startMaintenanceWatch();
  }, [loggedIn]);
  const notice = useMaintenance(s => s.notice);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const showMaintenance = !showConnection && !flash && notice !== null && dismissedNotice !== notice.message;

  const [permission, setPermission] = useState<PermissionState>("granted");
  const [dismissed, setDismissed] = useState(isPromptDismissed);
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

  const update = useDesktopUpdate(s => s.status);
  const readyVersion = update.state === "ready" ? update.version : null;
  const downloading = update.state === "downloading" ? update : null;
  const quiet = !showConnection && !flash && !showMaintenance;
  const showUpdate = quiet && readyVersion !== null;
  const showDownloading = quiet && downloading !== null;

  const showPermission = loggedIn && quiet && !showUpdate && !showDownloading && !dismissed && !desktopPref && needsPermissionPrompt(notificationAdapter().kind, permission);
  const visible = showConnection || flash || showMaintenance || showUpdate || showDownloading || showPermission;
  useEffect(() => {
    document.documentElement.classList.toggle("has-top-banner", visible);
    return () => document.documentElement.classList.remove("has-top-banner");
  }, [visible]);

  if (showConnection) return <ConnectionBar offline={!online} connection={connection} />;
  if (flash) return <ConnectedFlash />;
  if (showMaintenance && notice) return <MaintenanceBar notice={notice} onDismiss={() => setDismissedNotice(notice.message)} />;
  if (showUpdate && readyVersion !== null) return <UpdateBar version={readyVersion} />;
  if (showDownloading && downloading) return <DownloadingBar version={downloading.version} fraction={downloading.total ? downloading.downloaded / downloading.total : null} />;
  if (showPermission) return <PermissionBar desktopShell={notificationAdapter().kind === "tauri"} onDone={() => setDismissed(true)} />;
  return null;
}
