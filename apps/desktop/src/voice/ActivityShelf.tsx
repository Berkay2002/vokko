// The call's Activities picker (call bar button, the alone card's Choose Activity, the voice panel and DM calls): a centered modal with
// search, a Recent row and a 2-column card grid with Watch Together, Stremio and Spotify pinned first, then the games.
// The grid scrolls inside a fixed height; on a phone it is a full-height bottom sheet with one column.

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { MonitorPlay, Pin, Search } from "lucide-react";
import { useStore } from "../api/store";
import type { Channel } from "../api/types";
import { BUILTIN_PREFIX } from "../games/builtin";
import { GameIcon, useGameActivities } from "../games";
import { openModal } from "../shell/modalStore";
import { openSpotifyPanel, SpotifyIcon } from "../spotify";
import { spotifyAvailable } from "../spotify/availability";
import { openStremioPanel, StremioIcon } from "../stremio";
import { Modal, usePhone } from "../ui";
import { filterActivities, loadRecent, orderRecent, pushRecent, saveRecent, type Searchable } from "./activityPicker";
import { useChannelVoiceStates } from "./store";

/** Built-in games and pinned activities with cover art in public/activities/<slug>.webp (Vokko's own, made with Codex image generation). */
const ART = new Set(["watch-together", "sketch", "chess", "four-in-a-row", "codewords", "telephone", "trivia", "whos-the-spy", "same-wave", "crazy-eights", "werewolf", "betrayal", "shellshockers", "smashkarts", "skribbl", "codenames", "krunker"]);

/** One line per built-in game (a server's own games have none, so they get the generic line). */
const DESCRIPTIONS: Record<string, string> = {
  "builtin:sketch": "Draw and guess with the whole call",
  "builtin:chess": "Classic board game for two",
  "builtin:four-in-a-row": "Connect four discs before your rival",
  "builtin:codewords": "Give one-word clues to your team",
  "builtin:telephone": "Draw, describe and pass it on",
  "builtin:trivia": "Quick questions, fastest answer wins",
  "builtin:whos-the-spy": "Find the one who does not know the word",
  "builtin:same-wave": "Guess where the clue sits on the dial",
  "builtin:crazy-eights": "Match the suit or rank and empty your hand",
  "builtin:werewolf": "Villagers against wolves, one night at a time",
  "builtin:betrayal": "Find the traitors before it is too late",
  "builtin:shellshockers": "Egg shooter, in the browser",
  "builtin:smashkarts": "Kart battles with power-ups",
  "builtin:skribbl": "Draw and guess words in rounds",
  "builtin:codenames": "Spymasters and their teams",
  "builtin:krunker": "Fast browser shooter",
  "builtin:mock": "Test game",
};
const GENERIC = "A game for this server";

/** Cover image URL for a pinned activity or game id ("watch-together", "builtin:chess"); null draws the tinted icon instead. */
export function coverUrl(id: string): string | null {
  const slug = id.startsWith(BUILTIN_PREFIX) ? id.slice(BUILTIN_PREFIX.length) : id;
  return ART.has(slug) ? `/activities/${slug}.webp` : null;
}

function Cover({ id, hue, children }: { id: string; hue: number; children?: ReactNode }) {
  const url = coverUrl(id);
  if (url) return <img className="shelf-card-art" src={url} alt="" draggable={false} />;
  return (
    <span className="shelf-card-art fallback" style={{ "--activity-hue": hue } as React.CSSProperties} aria-hidden="true">
      {children}
    </span>
  );
}

/** A stable hue per name for games without art, so a server's own games still get distinct cards. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

interface Item extends Searchable {
  /** The line under the description: the player range, or why it can't be started. */
  sub: string;
  art: ReactNode;
  pinned?: boolean;
  disabled?: boolean;
  current?: boolean;
  onSelect: () => void;
}

function Card({ item, onLaunch }: { item: Item; onLaunch: (item: Item) => void }) {
  return (
    <button type="button" role="menuitem" className={`shelf-card${item.current ? " current" : ""}`} aria-disabled={item.disabled || undefined} title={item.disabled ? item.sub : undefined} onClick={() => onLaunch(item)}>
      <span className="shelf-card-cover">
        {item.art}
        {item.pinned && <Pin className="shelf-card-pin" size={14} aria-hidden="true" />}
      </span>
      <span className="shelf-card-name">{item.name}</span>
      <span className="shelf-card-desc">{item.description}</span>
      <span className="shelf-card-sub">{item.sub}</span>
    </button>
  );
}

function RecentTile({ item, onLaunch }: { item: Item; onLaunch: (item: Item) => void }) {
  return (
    <button type="button" role="menuitem" className="shelf-recent" aria-label={item.name} title={item.name} aria-disabled={item.disabled || undefined} onClick={() => onLaunch(item)}>
      {item.art}
    </button>
  );
}

const GRID_STEPS: Record<string, (columns: number) => number> = { ArrowLeft: () => -1, ArrowRight: () => 1, ArrowUp: c => -c, ArrowDown: c => c };
const cardsIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/**
 * Arrows move through the cards as laid out: Left/Right to the previous/next card, Up/Down by a row, and past the end of Recent or
 * the grid into the next one (or back to the search box); Home/End go to the first/last card of the list. Down in the search box goes to the first card.
 */
function gridKey(e: KeyboardEvent<HTMLElement>) {
  const active = document.activeElement as HTMLElement | null;
  const all = cardsIn(e.currentTarget);
  if (e.key === "ArrowDown" && active?.matches("input")) {
    e.preventDefault();
    all[0]?.focus();
    return;
  }
  const step = GRID_STEPS[e.key];
  const menu = active?.closest<HTMLElement>('[role="menu"]');
  if (!(step || e.key === "Home" || e.key === "End") || !active || !menu) return;
  const cards = cardsIn(menu);
  const at = cards.indexOf(active);
  if (at < 0) return;
  e.preventDefault();
  if (!step) return cards[e.key === "Home" ? 0 : cards.length - 1]?.focus();
  const columns = getComputedStyle(menu).gridTemplateColumns.split(" ").length;
  const next = cards[at + step(columns)];
  if (next) return next.focus();
  if (e.key === "ArrowDown") all[all.indexOf(cards[cards.length - 1]!) + 1]?.focus();
  if (e.key === "ArrowUp") (all[all.indexOf(cards[0]!) - 1] ?? e.currentTarget.querySelector<HTMLElement>("input"))?.focus();
}

export function ActivityShelf({ channel, open, onClose, onWatchTogether, onGame }: { channel: Channel; open: boolean; onClose: () => void; onWatchTogether: () => void; onGame?: () => void }) {
  const games = useGameActivities(channel);
  const userId = useStore(s => s.me?.id ?? null);
  const features = useStore(s => (channel.guild_id ? s.guilds?.[channel.guild_id]?.features : undefined));
  const inCall = useChannelVoiceStates(channel.id);
  const spotify = spotifyAvailable({ dm: !channel.guild_id, features, inCall: inCall.map(v => v.user_id) });
  // A phone or a touch screen would pop up the soft keyboard for the search box, so the dialog takes focus instead.
  const touch = usePhone() || (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  // Reload on every open (and per account); a launch closes the picker, so state never goes stale while it is open.
  const [openedFor, setOpenedFor] = useState<string | null | false>(false);
  if (!open && openedFor !== false) setOpenedFor(false);
  if (open && openedFor !== userId) {
    setOpenedFor(userId);
    setRecent(loadRecent(userId));
    setQuery("");
  }

  const items: Item[] = [
    { id: "watch-together", name: "Watch Together", description: "YouTube in sync", sub: "Everyone in the call", pinned: true, art: <Cover id="watch-together" hue={0}><MonitorPlay size={40} /></Cover>, onSelect: onWatchTogether },
    { id: "stremio", name: "Stremio", description: "Movies and episodes", sub: "Everyone in the call", pinned: true, art: <Cover id="stremio" hue={265}><StremioIcon size={44} /></Cover>, onSelect: openStremioPanel },
    ...(spotify ? [{ id: "spotify", name: "Spotify", description: "Music for everyone", sub: "Everyone in the call", pinned: true, art: <Cover id="spotify" hue={140}><SpotifyIcon size={44} /></Cover>, onSelect: openSpotifyPanel }] : []),
    ...games.map(({ game, sub, current, disabled, onSelect }): Item => ({
      id: game.id,
      name: game.name,
      description: DESCRIPTIONS[game.id] ?? GENERIC,
      sub,
      current,
      disabled,
      art: <Cover id={game.id} hue={hueOf(game.name)}><GameIcon game={game} size={44} /></Cover>,
      onSelect,
    })),
  ];
  const shown = filterActivities(items, query);
  const recentItems = query.trim() ? [] : orderRecent(items, recent);

  const launch = (item: Item) => {
    if (item.disabled) return;
    const next = pushRecent(recent, item.id);
    setRecent(next);
    saveRecent(userId, next);
    onClose();
    item.onSelect();
    if (!item.pinned) onGame?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Activities"
      sheet
      focusSelf={touch}
      className="activity-shelf"
      footer={
        <button
          type="button"
          className="activity-shelf-credits"
          onClick={() => {
            onClose();
            openModal({ type: "gameCredits" });
          }}
        >
          Credits and licenses
        </button>
      }
    >
      <div className="activity-picker" onKeyDown={gridKey}>
        <label className="activity-search">
          <Search size={16} aria-hidden="true" />
          <input data-autofocus type="text" role="searchbox" aria-label="Search activities" placeholder="Search" autoComplete="off" spellCheck={false} value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <div className="activity-picker-scroll">
          {recentItems.length > 0 && (
            <section>
              <h3 className="activity-section">Recent</h3>
              <div className="activity-recent" role="menu" aria-label="Recent">
                {recentItems.map(item => (
                  <RecentTile key={item.id} item={item} onLaunch={launch} />
                ))}
              </div>
            </section>
          )}
          <section>
            <h3 className="activity-section">Activities</h3>
            {shown.length > 0 ? (
              <div className="activity-shelf-grid" role="menu" aria-label="Activities">
                {shown.map(item => (
                  <Card key={item.id} item={item} onLaunch={launch} />
                ))}
              </div>
            ) : (
              <p className="activity-empty" role="status">
                No activities match "{query.trim()}".
              </p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
