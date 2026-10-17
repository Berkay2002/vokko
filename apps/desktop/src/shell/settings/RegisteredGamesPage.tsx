import { useEffect, useMemo, useState } from "react";
import { addRegisteredGame, iconOf, refreshProcesses, removeRegisteredGame, setShareActivity, setShowSpotify, useActivity } from "../../activity";
import { unregisteredProcesses, type RunningProcess } from "../../desktop/games";
import { ActivityIcon } from "../ActivityIcon";
import { Category, Page, SwitchRow } from "./controls";
import { InfoBanner } from "./smControls";

/** How often the process list is refreshed while the page is open. */
const REFRESH_MS = 5000;

/** The share switch used by Registered Games and Activity Privacy. */
export function ShareActivitySwitch() {
  const share = useActivity(s => s.share);
  return (
    <SwitchRow label="Share my activity" note="Show the game or app you are using as your status. Friends and server members see “Playing …” with its name and icon and how long it has been open." checked={share} onChange={setShareActivity} />
  );
}

/** "Show Spotify as my status" (off until the user turns it on): the song playing in the Spotify app on this computer (needs Share my activity as well). */
export function SpotifyStatusSwitch({ disabled }: { disabled?: boolean }) {
  const spotify = useActivity(s => s.spotify);
  return (
    <SwitchRow
      label="Show Spotify as my status"
      note="Show “Listening to Spotify” with the song you are playing in the Spotify app on this computer. Needs Share my activity."
      checked={spotify}
      onChange={setShowSpotify}
      disabled={disabled}
    />
  );
}

/** Desktop only: the app Vokko sees right now, the apps you added, and running apps you can add. */

/** `data:` URL of a base64 PNG icon. */
const dataUrl = (icon: string | undefined): string | null => (icon ? `data:image/png;base64,${icon}` : null);
export function RegisteredGamesPage() {
  const detected = useActivity(s => s.detected);
  const registered = useActivity(s => s.registered);
  const running = useActivity(s => s.running);
  const icons = useActivity(s => s.icons);
  const share = useActivity(s => s.share);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void refreshProcesses();
    const timer = setInterval(() => void refreshProcesses(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unregisteredProcesses(running ?? [], registered)
      .filter(process => !needle || process.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [running, registered, query]);

  return (
    <Page title="Registered Games">
      <Category title="App Detection">
        <div className="registered-detected" data-testid="detected-game">
          <span className="registered-detected-icon" aria-hidden="true">
            <ActivityIcon src={detected ? dataUrl(iconOf(detected.exe, { icons, registered })) : null} size={24} fill />
          </span>
          <span className="sm-list-text">
            <span className="sm-list-name">{detected ? detected.name : "No app detected"}</span>
            <span className="sm-list-sub">
              {detected ? (share ? "Shown as your activity." : "Detected, but not shared: Share my activity is off.") : "Open a game or an app you added and it shows up here within a few seconds."}
            </span>
          </span>
        </div>
        <ShareActivitySwitch />
      </Category>
      <Category title="Added Apps">
        {registered.length === 0 ? (
          <p className="sm-empty">You have not added any apps. Pick one from the running apps below.</p>
        ) : (
          <ul aria-label="Added apps">
            {registered.map(game => (
              <li key={game.exe.join("|")} className="sm-list-item">
                <span className="registered-app-icon" aria-hidden="true">
                  <ActivityIcon src={dataUrl(game.icon)} size={20} fill />
                </span>
                <span className="sm-list-text">
                  <span className="sm-list-name">{game.name}</span>
                  <span className="sm-list-sub">{game.exe.join(", ")}</span>
                </span>
                <button type="button" className="sm-btn" aria-label={`Remove ${game.name}`} onClick={() => removeRegisteredGame(game.exe[0] ?? game.name)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Category>
      <Category title="Not seeing your app? Add it!">
        <InfoBanner>Vokko only reads the names of running programs on this computer. For an app you add or that is detected it also reads the display name and icon from the program file. Nothing is sent anywhere until an app is detected and sharing is on, and then only its name, start time and icon, never where it is installed.</InfoBanner>
        <input className="input" type="search" aria-label="Search running apps" placeholder="Search running apps" value={query} onChange={event => setQuery(event.target.value)} />
        {running === null ? (
          <p className="sm-empty">Looking for running apps…</p>
        ) : candidates.length === 0 ? (
          <p className="sm-empty">No other running apps{query ? " match" : ""}.</p>
        ) : (
          <ul aria-label="Running apps">
            {candidates.map(process => (
              <RunningRow key={process.name.toLowerCase()} process={process} />
            ))}
          </ul>
        )}
      </Category>
    </Page>
  );
}

function RunningRow({ process }: { process: RunningProcess }) {
  return (
    <li className="sm-list-item">
      <span className="sm-list-text">
        <span className="sm-list-name">{process.name}</span>
      </span>
      <button type="button" className="sm-btn" aria-label={`Add ${process.name}`} onClick={() => addRegisteredGame(process)}>
        Add it!
      </button>
    </li>
  );
}
