import { useEffect, useState } from "react";
import { flushDrafts } from "../../chat/draftStore";
import { getDesktopPrefs, isDesktop, restartApp, setDesktopPrefs } from "../../desktop";
import { Modal, setPref, usePrefs } from "../../ui";
import { DeveloperApps } from "../../apps/DeveloperApps";
import { openModal } from "../modalStore";
import { Category, Page, SwitchRow } from "./controls";

/** Discord's "Advanced" page: developer mode (synced), hardware acceleration (this device; desktop app, needs a restart) and
 * application test mode (no application platform yet, so it stays disabled). Vokko adds Report a Problem under Support. */
export function DeveloperPage() {
  const developerMode = usePrefs(s => s.developerMode);
  const app = isDesktop();
  const [acceleration, setAcceleration] = useState<boolean | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getDesktopPrefs().then(prefs => live && setAcceleration(prefs.hardwareAcceleration));
    return () => {
      live = false;
    };
  }, []);

  const apply = async (next: boolean, restart: boolean) => {
    try {
      const saved = await setDesktopPrefs({ hardwareAcceleration: next });
      setAcceleration(saved.hardwareAcceleration);
      setPending(null);
      if (restart) {
        flushDrafts(); // a relaunch gives the page no pagehide
        await restartApp();
      }
    } catch (cause) {
      setError(String(cause));
      setPending(null);
    }
  };

  return (
    <Page title="Advanced">
      <Category title="Developer">
        <SwitchRow label="Developer Mode" note="Adds “Copy ID” to the menus of servers, channels, users, messages and roles." checked={developerMode} onChange={v => setPref("developerMode", v)} />
        <SwitchRow label="Application Test Mode" note="Enter an application ID to turn on its test mode. Vokko has no application platform yet." checked={false} disabled onChange={() => undefined} />
      </Category>
      <Category title="Hardware">
        <SwitchRow
          label="Hardware Acceleration"
          note={app ? "Uses your GPU to make Vokko smoother. Turn it off if you see visual glitches. Changing it restarts Vokko. Applies on Windows; other systems keep their default." : "Available in the desktop app."}
          checked={acceleration ?? true}
          disabled={!app || acceleration === null}
          onChange={v => setPending(v)}
        />
        {error && <p className="field-error">{error}</p>}
      </Category>
      <Category title="Support">
        <p className="settings-field-note">Sends a description of the problem with the app version, your OS and recent warnings, errors and voice events (tokens removed, no messages) to whoever runs this server.</p>
        <button type="button" className="btn btn-secondary" onClick={() => openModal({ type: "reportProblem" })}>
          Report a Problem
        </button>
      </Category>
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Change Hardware Acceleration"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => pending !== null && void apply(pending, false)}>
              Later
            </button>
            <button type="button" className="btn btn-primary" onClick={() => pending !== null && void apply(pending, true)}>
              Restart now
            </button>
          </>
        }
      >
        <p className="modal-subtle">Vokko needs to restart to {pending ? "turn on" : "turn off"} hardware acceleration. “Later” saves it for the next start.</p>
      </Modal>
      <DeveloperApps />
    </Page>
  );
}
