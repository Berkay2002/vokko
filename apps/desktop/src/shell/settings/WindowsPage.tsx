import { useEffect, useState } from "react";
import { DEFAULT_DESKTOP_PREFS, getAutostart, getDesktopPrefs, setAutostart, setDesktopPrefs, type DesktopPrefs } from "../../desktop";
import { Category, Page, SwitchRow } from "./controls";

const message = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.");

/** Desktop-only settings (Tauri shell): tray behaviour and run-on-startup. The page is hidden in the browser build. */
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
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Page>
  );
}
