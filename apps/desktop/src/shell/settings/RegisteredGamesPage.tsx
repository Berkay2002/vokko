import { useEffect, useMemo, useState } from "react";
import { Gamepad2 } from "lucide-react";
import { addRegisteredGame, refreshProcesses, removeRegisteredGame, setShareActivity, setShowSpotify, useActivity } from "../../activity";
import { unregisteredProcesses, type RunningProcess } from "../../desktop/games";
import { Category, Page, SwitchRow } from "./controls";
import { InfoBanner } from "./smControls";

/** How often the process list is refreshed while the page is open. */
const REFRESH_MS = 5000;

/** The share switch used by Registered Games and Activity Privacy. */
export function ShareActivitySwitch() {
  const share = useActivity(s => s.share);
  return (
    <SwitchRow label="Share my activity" note="Show the game you are playing as your status. Friends and server members see “Playing …” with how long you have been playing." checked={share} onChange={setShareActivity} />
  );
}

/** "Display Spotify as your status": the song playing in the Spotify app on this computer (needs Share my activity as well). */
export function SpotifyStatusSwitch({ disabled }: { disabled?: boolean }) {
  const spotify = useActivity(s => s.spotify);
  return (
    <SwitchRow
      label="Display Spotify as your status"
      note="Show “Listening to Spotify” with the song you are playing in the Spotify app on this computer. Needs Share my activity."
      checked={spotify}
      onChange={setShowSpotify}
      disabled={disabled}
    />
  );
}

/** Desktop only: the game Vokko sees right now, the games you added, and running apps you can add. */
export function RegisteredGamesPage() {
  const detected = useActivity(s => s.detected);
  const registered = useActivity(s => s.registered);
  const running = useActivity(s => s.running);
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
      <Category title="Game Detection">
        <div className="registered-detected" data-testid="detected-game">
          <span className="registered-detected-icon" aria-hidden="true">
            <Gamepad2 size={24} />
          </span>
          <span className="sm-list-text">
            <span className="sm-list-name">{detected ? detected.name : "No game detected"}</span>
            <span className="sm-list-sub">
              {detected ? (share ? "Shown as your activity." : "Detected, but not shared: Share my activity is off.") : "Start a game and it shows up here within a few seconds."}
            </span>
          </span>
        </div>
        <ShareActivitySwitch />
      </Category>
      <Category title="Added Games">
        {registered.length === 0 ? (
          <p className="sm-empty">You have not added any games. Pick one from the running apps below.</p>
        ) : (
          <ul aria-label="Added games">
            {registered.map(game => (
              <li key={game.exe.join("|")} className="sm-list-item">
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
      <Category title="Not seeing your game? Add it!">
        <InfoBanner>Vokko only reads the names of running programs on this computer. Nothing is sent anywhere until a game is detected and sharing is on.</InfoBanner>
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
