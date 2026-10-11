import { useEffect, useState } from "react";
import { DEFAULT_DESKTOP_PREFS, checkForUpdate, getAppVersion, getAutostart, getDesktopPrefs, restartToUpdate, setAutostart, setDesktopPrefs, useDesktopUpdate, type DesktopPrefs, type UpdateStatus } from "../../desktop";
import { Category, Page, SwitchRow } from "./controls";

const message = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.");

/** One line for the updates block: what the updater is doing or found. */
export function updateSummary(status: UpdateStatus, version: string | null): string {
  switch (status.state) {
    case "disabled":
      return "Updates are not set up for this build. Install a newer build yourself, or ask whoever hosts Vokko for one.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Vokko ${status.version} is available.`;
    case "downloading": {
      const percent = status.total ? ` (${Math.min(100, Math.round((status.downloaded / status.total) * 100))}%)` : "";
      return `Downloading Vokko ${status.version}${percent}…`;
    }
    case "ready":
      return `Vokko ${status.version} is ready to install.`;
    case "error":
      return `Could not check for updates: ${status.message}`;
    case "upToDate":
      return version ? `Vokko is up to date (${version}).` : "Vokko is up to date.";
    default:
      return version ? `You have Vokko ${version}.` : "Check whether a newer version is available.";
  }
}

function UpdatesCategory() {
  const status = useDesktopUpdate(s => s.status);
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);
  const busy = status.state === "checking" || status.state === "downloading";
  const restart = async () => {
    setFailed(null);
    try {
      await restartToUpdate();
    } catch (e) {
      setFailed(message(e));
    }
  };
  return (
    <Category title="Updates">
      <div className="switch-row" data-testid="update-status">
        <div className="switch-row-text">
          <div className="switch-row-label">{version ? `Vokko ${version}` : "Vokko"}</div>
          <div className="switch-row-note" role="status">
            {failed ? `Could not install the update: ${failed}` : updateSummary(status, version)}
          </div>
        </div>
        {status.state === "ready" ? (
          <button type="button" className="sm-btn primary" onClick={() => void restart()}>
            Restart to Update
          </button>
        ) : status.state !== "disabled" ? (
          <button type="button" className="sm-btn" disabled={busy} onClick={() => void checkForUpdate()}>
            {status.state === "error" ? "Try Again" : "Check for Updates"}
          </button>
        ) : null}
      </div>
    </Category>
  );
}

/** Desktop-only settings (Tauri shell): tray behaviour, run-on-startup and updates. The page is hidden in the browser build. */
export function WindowsPage() {
  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_DESKTOP_PREFS);
  const [autostart, setAutostartState] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([getDesktopPrefs(), getAutostart()]).then(([stored, startup]) => {
      if (!live) return;
      setPrefs(stored);
      setAutostartState(startup);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const changePref = async (patch: Partial<DesktopPrefs>) => {
    const before = prefs;
    setError(null);
    setPrefs({ ...prefs, ...patch });
    try {
      setPrefs(await setDesktopPrefs(patch));
    } catch (e) {
      setPrefs(before);
      setError(message(e));
    }
  };

  const changeAutostart = async (enabled: boolean) => {
    setError(null);
    try {
      setAutostartState(await setAutostart(enabled));
    } catch (e) {
      setAutostartState(!enabled);
      setError(`Could not change the startup setting: ${message(e)}`);
    }
  };

  return (
    <Page title="Windows Settings">
      <Category title="System Startup Behavior">
        <SwitchRow label="Open Vokko" note="Start Vokko when you log in to Windows." checked={autostart} disabled={!loaded} onChange={on => void changeAutostart(on)} />
        <SwitchRow label="Start Minimized" note="Vokko opens in the system tray instead of showing its window." checked={prefs.startMinimized} disabled={!loaded} onChange={on => void changePref({ startMinimized: on })} />
      </Category>
      <Category title="Close Button">
        <SwitchRow
          label="Close button minimizes to tray"
          note="Closing the window keeps Vokko running in the tray. Quit from the tray menu."
          checked={prefs.closeToTray}
          disabled={!loaded}
          onChange={on => void changePref({ closeToTray: on })}
        />
      </Category>
      <UpdatesCategory />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Page>
  );
}
