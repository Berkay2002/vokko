// The call's Activities shelf (call bar button, the alone card's Choose Activity and DM calls): a grid of cards with Watch Together,
// Stremio and Spotify pinned first, then the games. It scrolls inside a fixed height; on a phone it is a bottom sheet.

import type { KeyboardEvent, ReactNode } from "react";
import { MonitorPlay, Pin, X } from "lucide-react";
import type { Channel } from "../api/types";
import { BUILTIN_PREFIX } from "../games/builtin";
import { GameIcon, useGameActivities } from "../games";
import { openModal } from "../shell/modalStore";
import { openSpotifyPanel, SpotifyIcon } from "../spotify";
import { openStremioPanel, StremioIcon } from "../stremio";
import { Popout } from "../ui";

/** Built-in games and pinned activities with cover art in public/activities/<slug>.webp (Vokko's own, made with Codex image generation). */
const ART = new Set(["watch-together", "sketch", "chess", "four-in-a-row", "codewords", "telephone", "trivia", "whos-the-spy", "same-wave", "crazy-eights", "werewolf", "betrayal", "shellshockers", "smashkarts", "skribbl", "codenames", "krunker"]);

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

function Card({ name, sub, art, pinned, disabled, current, onSelect, onClose }: { name: string; sub: string; art: ReactNode; pinned?: boolean; disabled?: boolean; current?: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`shelf-card${current ? " current" : ""}`}
      aria-disabled={disabled || undefined}
      title={disabled ? sub : undefined}
      onClick={() => {
        if (disabled) return;
        onClose();
        onSelect();
      }}
    >
      <span className="shelf-card-cover">
        {art}
        {pinned && <Pin className="shelf-card-pin" size={14} aria-hidden="true" />}
      </span>
      <span className="shelf-card-name">{name}</span>
      <span className="shelf-card-sub">{sub}</span>
    </button>
  );
}

const GRID_STEPS: Record<string, (columns: number) => number> = { ArrowLeft: () => -1, ArrowRight: () => 1, ArrowUp: c => -c, ArrowDown: c => c };

/** Arrows move through the grid as laid out: Left/Right to the previous/next card, Up/Down by a row. Home/End go to Popout. */
function gridKey(e: KeyboardEvent<HTMLDivElement>) {
  const step = GRID_STEPS[e.key];
  if (!step) return;
  const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = cards.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const columns = getComputedStyle(e.currentTarget).gridTemplateColumns.split(" ").length;
  cards[at + step(columns)]?.focus();
}

export function ActivityShelf({ channel, anchor, open, onClose, onWatchTogether }: { channel: Channel; anchor: HTMLElement | null; open: boolean; onClose: () => void; onWatchTogether: () => void }) {
  const games = useGameActivities(channel);
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="center" gap={8} className="activity-shelf" role="dialog" label="Activities" sheet="Activities">
      <div className="activity-shelf-header">
        <span className="activity-shelf-title">Activities</span>
        <span className="activity-shelf-subtitle">Watch, listen or play together.</span>
        <button type="button" className="activity-shelf-close" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="activity-shelf-grid" role="menu" aria-label="Activities" onKeyDown={gridKey}>
        <Card pinned name="Watch Together" sub="YouTube in sync" art={<Cover id="watch-together" hue={0}><MonitorPlay size={40} /></Cover>} onSelect={onWatchTogether} onClose={onClose} />
        <Card pinned name="Stremio" sub="Movies and episodes" art={<Cover id="stremio" hue={265}><StremioIcon size={44} /></Cover>} onSelect={openStremioPanel} onClose={onClose} />
        <Card pinned name="Spotify" sub="Music for everyone" art={<Cover id="spotify" hue={140}><SpotifyIcon size={44} /></Cover>} onSelect={openSpotifyPanel} onClose={onClose} />
        {games.map(({ game, sub, current, disabled, onSelect }) => (
          <Card
            key={game.id}
            name={game.name}
            sub={sub}
            current={current}
            disabled={disabled}
            art={
              <Cover id={game.id} hue={hueOf(game.name)}>
                <GameIcon game={game} size={44} />
              </Cover>
            }
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </div>
      <div className="activity-shelf-footer">
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
      </div>
    </Popout>
  );
}
