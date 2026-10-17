// The game tile of a call (docs/design/games-host.md sections 3 and 7). In the grid or strip it is a cover; focused it loads
// the game in a sandboxed frame under a Vokko-drawn header (name, origin, Close, Stop). The frame unloads when the tile is
// left (the game gets `close` first). FrameHost speaks the SDK protocol; this file feeds it players and relayed messages.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Gamepad2, Square, X } from "lucide-react";
import { gateway } from "../api/gateway";
import { Perm } from "../api/permissions";
import { ApiRequestError } from "../api/rest";
import { appStore, avatarUrl, displayName, useStore } from "../api/store";
import type { GameAspect, GameManifest, GamePlayer, GameSession, Snowflake, User } from "../api/types";
import { usePermissions } from "../shell/usePermissions";
import { Tooltip } from "../ui";
import { useChannelVoiceStates, useVoice } from "../voice/store";
import { gamePlayers, relayGame, stopGame } from "./api";
import { isBuiltin } from "./builtin";
import { checkSend, FrameHost, frameOrigin, frameUrl, leaderOf, sandboxFor, type GameErrorCode, type GameToHost, type Player } from "./frameHost";
import { GameIcon } from "./GameIcon";
import "./games.css";

export type GameVariant = "solo" | "grid" | "focused" | "strip" | "pip";

const ASPECT: Record<GameAspect, number | null> = { "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, fill: null };
const NAME_MAX = 32;

/** "Vokko" for built-ins, the origin's host for third-party games. */
export function originLabel(game: GameManifest): string {
  if (isBuiltin(game)) return "Vokko";
  const origin = frameOrigin(game);
  return origin.replace(/^https:\/\//, "") || game.url;
}

const avatars = new Map<string, Promise<Blob | null>>();

/** The user's avatar as a 128 px PNG blob (structured-cloned to the game, so no URL with a user id reaches it); null without one. */
function avatarBlob(user: Pick<User, "id" | "avatar"> | undefined): Promise<Blob | null> {
  if (!user?.avatar) return Promise.resolve(null);
  const url = avatarUrl(user);
  let blob = avatars.get(url);
  if (!blob) {
    blob = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bitmap = await createImageBitmap(await res.blob());
        const canvas = new OffscreenCanvas(128, 128);
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, 128, 128);
        return await canvas.convertToBlob({ type: "image/png" });
      } catch {
        return null;
      }
    })();
    avatars.set(url, blob);
  }
  return blob;
}

async function toPlayers(raw: GamePlayer[], guildId: Snowflake | null): Promise<Player[]> {
  const { users, members } = appStore.getState();
  return Promise.all(
    raw.map(async p => {
      const user = users[p.user_id];
      const member = guildId ? members[guildId]?.[p.user_id] : undefined;
      const name = user ? [...displayName(user, member)].slice(0, NAME_MAX).join("") : "Player";
      return { app_id: p.app_id, name, avatar: await avatarBlob(user) };
    }),
  );
}

function errorCode(e: unknown): GameErrorCode {
  if (!(e instanceof ApiRequestError)) return "invalid";
  if (e.status === 429) return "rate_limited";
  if (e.status === 404) return "not_running";
  return e.status === 400 && e.api.errors && "data" in e.api.errors ? "too_large" : "invalid";
}

/** The game frame and its port, for one session. */
function GameFrame({ channelId, guildId, session, onClose }: { channelId: Snowflake; guildId: Snowflake | null; session: GameSession; onClose(): void }) {
  const game = session.game;
  const meId = useVoice(s => s.meId);
  const roster = useChannelVoiceStates(channelId)
    .map(s => s.user_id)
    .sort()
    .join(",");
  const [players, setPlayers] = useState<{ raw: GamePlayer[]; list: Player[] } | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<FrameHost | null>(null);
  const latest = useRef({ players, meId, onClose });
  latest.current = { players, meId, onClose };

  // Everyone in the call now; refetched on every join and leave (the app ids come from the server).
  useEffect(() => {
    let alive = true;
    gamePlayers(channelId)
      .then(async raw => ({ raw, list: await toPlayers(raw, guildId) }))
      .then(next => alive && setPlayers(next))
      .catch(() => alive && setNotice("Couldn't load the players of this game."));
    return () => {
      alive = false;
    };
  }, [channelId, guildId, session.session_id, roster]);

  const sandbox = sandboxFor(game);
  const showFrame = players !== null && sandbox !== null;

  // Attach before the frame's document runs, so its hello is never missed. A new frame (remount) gets a new host and port.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!showFrame || !el) return;
    const send = (message: GameToHost & { type: "send" }) => {
      const raw = latest.current.players?.raw ?? [];
      const refused = checkSend(message.data, message.to, raw);
      if (refused) return h.post({ type: "error", code: refused });
      relayGame(channelId, message.to === undefined ? { data: message.data } : { data: message.data, to: message.to }).catch(e => h.post({ type: "error", code: errorCode(e) }));
    };
    const h = new FrameHost(el, game, {
      init: () => {
        const { players: now, meId: me } = latest.current;
        const raw = now?.raw ?? [];
        const list = now?.list ?? [];
        const mine = raw.findIndex(p => p.user_id === me);
        return { type: "init", game_id: game.id, me: list[mine] ?? { app_id: "", name: "", avatar: null }, players: list, leader: leaderOf(raw, session.started_by) };
      },
      onMessage: message => {
        if (message.type === "ready") setReady(true);
        else if (message.type === "close") latest.current.onClose();
        else send(message);
      },
    });
    host.current = h;
    const off = h.attach();
    return () => {
      off();
      host.current = null;
    };
  }, [showFrame, channelId, game, session.started_by]);

  useEffect(() => {
    if (players && host.current?.connected) host.current.post({ type: "players", players: players.list, leader: leaderOf(players.raw, session.started_by) });
  }, [players, session.started_by]);

  useEffect(
    () =>
      gateway.on("GAME_MESSAGE", d => {
        if (d.channel_id === channelId && d.session_id === session.session_id) host.current?.post({ type: "message", from: d.from, data: d.data });
      }),
    [channelId, session.session_id],
  );

  const ratio = ASPECT[game.aspect] ?? null;
  const origin = originLabel(game);
  return (
    <div className="game-stage">
      <div className={`game-frame-box${ratio === null ? " fill" : ""}`} style={ratio === null ? undefined : ({ "--game-ar": ratio } as CSSProperties)}>
        {showFrame && (
          <iframe
            ref={frame}
            className="game-frame"
            src={frameUrl(game)}
            title={`${game.name} (game from ${origin})`}
            sandbox={sandbox}
            allow=""
            referrerPolicy="no-referrer"
            loading="lazy"
            {...{ credentialless: "" }}
          />
        )}
        {(!ready || !showFrame) && (
          <div className="game-loading" role="status">
            {sandbox === null ? "This game can't run here: its address is not allowed." : (notice ?? `Loading ${game.name}…`)}
          </div>
        )}
      </div>
    </div>
  );
}

/** The tile of the channel's game session; nothing once it has ended. */
export function GameTile(props: { channelId: Snowflake; variant: GameVariant; onActivate?: () => void }) {
  const session = useVoice(s => s.games[props.channelId]);
  return session ? <GameTileBody {...props} session={session} /> : null;
}

function GameTileBody({ channelId, variant, onActivate, session }: { channelId: Snowflake; variant: GameVariant; onActivate?: () => void; session: GameSession }) {
  const game = session.game;
  const meId = useVoice(s => s.meId);
  const guildId = useStore(s => s.channels[channelId]?.guild_id ?? null);
  const starter = useStore(s => s.users[session.started_by]);
  const { can } = usePermissions(guildId, channelId);
  // shortcut: the section 2 item 6 rule (starter or MANAGE_CHANNELS; anyone in a DM); bot-control replaces it via can_stop on the server.
  const canStop = !guildId || meId === session.started_by || can(Perm.MANAGE_CHANNELS);
  const [closed, setClosed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const small = variant === "strip" || variant === "pip";
  const open = variant === "focused" && !closed;
  const close = () => (onActivate && variant === "focused" ? onActivate() : setClosed(true));
  const reopen = () => (onActivate && variant !== "focused" ? onActivate() : setClosed(false));
  const stop = () => {
    setFailure(null);
    stopGame(channelId).catch(e => setFailure(e instanceof ApiRequestError ? e.message : "Something went wrong. Try again."));
  };

  return (
    <div className={`voice-tile game ${variant}`} data-game-tile data-game-id={game.id} role="group" aria-label={`Game: ${game.name}`}>
      {!small && (
        <div className="game-head">
          <GameIcon game={game} size={20} />
          <span className="game-name">{game.name}</span>
          <span className="game-origin" title={isBuiltin(game) ? undefined : frameOrigin(game)}>
            {originLabel(game)}
          </span>
          <span className="game-spacer" />
          {open && (
            <Tooltip content="Close (the game keeps running)" side="bottom">
              <button type="button" className="game-button" aria-label="Close game" onClick={close}>
                <X size={16} />
              </button>
            </Tooltip>
          )}
          {canStop && (
            <Tooltip content="Stop the game for everyone" side="bottom">
              <button type="button" className="game-button danger" aria-label="Stop game" onClick={stop}>
                <Square size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      {failure && (
        <div className="game-notice" role="alert">
          {failure}
        </div>
      )}
      {open ? (
        <GameFrame channelId={channelId} guildId={guildId} session={session} onClose={close} />
      ) : (
        <button type="button" className="game-cover" aria-label={small ? `Focus ${game.name}` : `Open ${game.name}`} onClick={reopen}>
          {small ? <Gamepad2 size={variant === "pip" ? 20 : 24} aria-hidden="true" /> : <GameIcon game={game} size={48} />}
          {!small && <span className="game-cover-title">Play {game.name}</span>}
          {!small && starter && <span className="game-cover-by">Started by {displayName(starter)}</span>}
        </button>
      )}
    </div>
  );
}
