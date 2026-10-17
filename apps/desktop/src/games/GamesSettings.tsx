// Server Settings > Activities (docs/design/games-host.md section 4): the server's game allow-list. Members with Manage Server
// add, edit and remove games; everyone else reads the list. Built-ins are always there and are not listed.

import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { DialogField, FormDialog } from "../account/ui";
import { gateway } from "../api/gateway";
import { ApiRequestError } from "../api/rest";
import { GUILD_GAMES_MAX, type GameAspect, type GameManifest, type GameManifestRequest, type Snowflake } from "../api/types";
import { Category, Page, Select, Unavailable } from "../shell/settings/controls";
import { addGuildGame, editGuildGame, listGuildGames, removeGuildGame } from "./api";
import { GameIcon } from "./GameIcon";
import "./games.css";

const ASPECTS: { value: GameAspect; label: string }[] = [
  { value: "16:9", label: "16:9 (wide)" },
  { value: "4:3", label: "4:3" },
  { value: "1:1", label: "1:1 (square)" },
  { value: "fill", label: "Fill the tile" },
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const players = (g: GameManifest) => (g.min_players === g.max_players ? `${g.min_players} players` : `${g.min_players}-${g.max_players} players`);

function GameDialog({ guildId, game, onClose }: { guildId: Snowflake; game: GameManifest | null; onClose(): void }) {
  const [name, setName] = useState(game?.name ?? "");
  const [url, setUrl] = useState(game?.url ?? "https://");
  const [icon, setIcon] = useState(game?.icon ?? "");
  const [min, setMin] = useState(String(game?.min_players ?? 2));
  const [max, setMax] = useState(String(game?.max_players ?? 8));
  const [aspect, setAspect] = useState<GameAspect>(game?.aspect ?? "16:9");
  const origin = originOf(url.trim());
  const body = (): GameManifestRequest => ({ name: name.trim(), url: url.trim(), icon: icon.trim() || null, min_players: Number(min), max_players: Number(max), aspect });
  return (
    <FormDialog
      title={game ? `Edit ${game.name}` : "Add a game"}
      subtitle="Members in a call can start it from Activities. It runs in a sandboxed frame inside the call."
      submitLabel={game ? "Save" : "Add Game"}
      onClose={onClose}
      onSubmit={async () => {
        await (game ? editGuildGame(guildId, game.id, body()) : addGuildGame(guildId, body()));
      }}
    >
      {errors => (
        <>
          <DialogField label="Name" error={errors.name}>
            <input className="input" value={name} maxLength={32} autoFocus onChange={e => setName(e.target.value)} />
          </DialogField>
          <DialogField
            label="Game URL"
            error={errors.url}
            hint={origin && origin !== "null" ? <p className="games-warning">This game runs code from {origin} in your members' calls.</p> : undefined}
          >
            <input className="input" type="url" value={url} maxLength={512} spellCheck={false} onChange={e => setUrl(e.target.value)} />
          </DialogField>
          <DialogField label="Icon (one emoji, optional)" error={errors.icon}>
            <input className="input" value={icon} maxLength={16} onChange={e => setIcon(e.target.value)} />
          </DialogField>
          <div className="games-number-row">
            <DialogField label="Min players" error={errors.min_players}>
              <input className="input" type="number" min={1} max={16} value={min} onChange={e => setMin(e.target.value)} />
            </DialogField>
            <DialogField label="Max players" error={errors.max_players}>
              <input className="input" type="number" min={1} max={16} value={max} onChange={e => setMax(e.target.value)} />
            </DialogField>
          </div>
          <DialogField label="Shape" error={errors.aspect}>
            <Select<GameAspect> label="Shape" value={aspect} options={ASPECTS} onChange={setAspect} />
          </DialogField>
        </>
      )}
    </FormDialog>
  );
}

export function GamesSettings({ guildId, canEdit }: { guildId: Snowflake; canEdit: boolean }) {
  const [games, setGames] = useState<GameManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GameManifest | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void listGuildGames(guildId).then(
        list => alive && setGames(list),
        (e: unknown) => alive && setError(e instanceof ApiRequestError ? e.message : "Couldn't load the games."),
      );
    load();
    const off = gateway.on("GUILD_GAMES_UPDATE", d => d.guild_id === guildId && load());
    return () => {
      alive = false;
      off();
    };
  }, [guildId]);

  const remove = (game: GameManifest) => {
    setError(null);
    removeGuildGame(guildId, game.id).then(
      () => setGames(list => list?.filter(g => g.id !== game.id) ?? null),
      (e: unknown) => setError(e instanceof ApiRequestError ? e.message : "Couldn't remove the game."),
    );
  };
  const full = (games?.length ?? 0) >= GUILD_GAMES_MAX;

  return (
    <Page title="Activities">
      <p className="settings-field-note">Web games your members can play together in calls, next to the built-in ones. Only add games you trust: a game sees the display names and avatars of the people in the call.</p>
      {!canEdit && <Unavailable>You need the Manage Server permission to change the games.</Unavailable>}
      <Category title={`Games${games ? ` (${games.length}/${GUILD_GAMES_MAX})` : ""}`}>
        {canEdit && (
          <button type="button" className="btn btn-primary btn-sm" disabled={full || !games} onClick={() => setEditing("new")}>
            Add Game
          </button>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {games && games.length === 0 && <p className="settings-field-note">No games added yet.</p>}
        {games && games.length > 0 && (
          <ul className="games-list" aria-label="Games">
            {games.map(game => (
              <li key={game.id} className="games-row" data-game-id={game.id}>
                <GameIcon game={game} size={32} />
                <div className="games-row-text">
                  <span className="games-row-name">{game.name}</span>
                  <span className="games-row-meta">
                    {originOf(game.url) ?? game.url} · {players(game)}
                  </span>
                </div>
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-link btn-sm" aria-label={`Edit ${game.name}`} onClick={() => setEditing(game)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" className="btn btn-link btn-sm" aria-label={`Remove ${game.name}`} onClick={() => remove(game)}>
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Category>
      {editing && (
        <GameDialog
          guildId={guildId}
          game={editing === "new" ? null : editing}
          onClose={() => {
            setEditing(null);
            void listGuildGames(guildId).then(setGames, () => undefined);
          }}
        />
      )}
    </Page>
  );
}
