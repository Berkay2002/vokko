// Activities > "Credits and licenses": every built-in game with the third-party work it uses (GAME_CREDITS), each license's
// name, link and full text (fetched from the game's folder), and for website games whose site they run on.

import { useEffect, useState } from "react";
import { useModals } from "../shell/modalStore";
import { Modal } from "../ui";
import { BUILTIN_GAMES, isWebGame } from "./builtin";
import { GAME_CREDITS, type GameCredit } from "./credits";
import { GameIcon } from "./GameIcon";
import "./games.css";

function LicenseText({ file }: { file: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(file)
      .then(res => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then(
        body => alive && setText(body),
        () => alive && setText("The license text could not be loaded."),
      );
    return () => {
      alive = false;
    };
  }, [file]);
  return <pre className="game-credits-text">{text ?? "Loading…"}</pre>;
}

function Credit({ credit }: { credit: GameCredit }) {
  return (
    <li className="game-credits-item">
      <span>
        <a href={credit.url} target="_blank" rel="noopener noreferrer">
          {credit.work}
        </a>{" "}
        by {credit.author} · {credit.license}
      </span>
      {credit.file && (
        <details>
          <summary>License text</summary>
          <LicenseText file={credit.file} />
        </details>
      )}
    </li>
  );
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export function GameCreditsModal() {
  const close = useModals(s => s.close);
  return (
    <Modal open onClose={close} title="Credits and licenses" className="game-credits-modal">
      <ul className="game-credits" aria-label="Built-in games">
        {BUILTIN_GAMES.map(game => {
          const credits = GAME_CREDITS[game.id] ?? [];
          return (
            <li key={game.id} className="game-credits-game" data-game-id={game.id}>
              <h3 className="game-credits-name">
                <GameIcon game={game} size={20} />
                {game.name}
              </h3>
              {isWebGame(game) && (
                <p className="game-credits-note">
                  Runs on{" "}
                  <a href={game.url} target="_blank" rel="noopener noreferrer">
                    {siteOf(game.url)}
                  </a>
                  . Its ads, accounts and terms apply.
                </p>
              )}
              {!isWebGame(game) && credits.length === 0 && <p className="game-credits-note">Made for Vokko.</p>}
              {credits.length > 0 && (
                <ul className="game-credits-list">
                  {credits.map(credit => (
                    <Credit key={`${credit.work}-${credit.url}`} credit={credit} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
