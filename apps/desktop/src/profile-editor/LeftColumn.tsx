import { useEffect, useRef } from "react";
import { ChevronDown, ChevronsLeft } from "lucide-react";
import { useStore } from "../api/store";
import type { Guild, User } from "../api/types";
import { GuildIcon } from "../shell/Avatar";
import { useContextMenu, type MenuItem } from "../ui";
import type { ProfileLook } from "../perks/profile";
import type { ProfileDraft, Scope } from "./draft";
import { resolveProfileEditorTile, type ProfileEditorTileId } from "./registry";
import { ComingSoonTile } from "./tiles";

interface SectionDef {
  label: string;
  tiles: ProfileEditorTileId[];
}

/** Section order and grouping follow Discord's editor (reference pe-41, pe-43). */
export const SECTIONS: SectionDef[] = [
  { label: "Nameplate", tiles: ["nameplate"] },
  { label: "Avatar & decoration", tiles: ["avatar", "avatar-decoration"] },
  { label: "Banner colour", tiles: ["banner-color"] },
  { label: "Profile effect & frame", tiles: ["profile-effect", "profile-frame"] },
  { label: "Display name style", tiles: ["display-name-style"] },
  { label: "Profile theme", tiles: ["profile-theme"] },
  { label: "Profile banner", tiles: ["profile-banner"] },
  { label: "Animated avatar", tiles: ["animated-avatar"] },
];

/** Tiles whose value lives on the main profile only (a server profile overrides avatar, banner, theme, name, pronouns and bio). */
const MAIN_ONLY = new Set<ProfileEditorTileId>(["nameplate", "avatar-decoration", "banner-color", "profile-effect", "profile-frame", "display-name-style"]);

const TILE_LABEL: Record<string, string> = { nameplate: "Nameplate", "profile-frame": "Profile frame", "display-name-style": "Display name style" };
const FALLBACKS = new Map<string, ReturnType<typeof ComingSoonTile>>();
const fallback = (id: string) => {
  let tile = FALLBACKS.get(id);
  if (!tile) {
    tile = ComingSoonTile(TILE_LABEL[id] ?? id);
    FALLBACKS.set(id, tile);
  }
  return tile;
};

export interface LeftColumnProps {
  user: User;
  scope: Scope;
  guilds: Guild[];
  draft: ProfileDraft;
  look: ProfileLook;
  setDraft(patch: Partial<ProfileDraft>): void;
  setExtra(field: string, value: unknown): void;
  uploadChannel: string | null;
  openTile: string | null;
  setOpenTile(id: string | null): void;
  onScope(scope: Scope): void;
  onCollapse(): void;
}

export function LeftColumn({ user, scope, guilds, draft, look, setDraft, setExtra, uploadChannel, openTile, setOpenTile, onScope, onCollapse }: LeftColumnProps) {
  const menu = useContextMenu();
  const body = useRef<HTMLDivElement>(null);
  const guildName = scope.kind === "guild" ? guilds.find(g => g.id === scope.guildId)?.name : undefined;

  // Opening a tile from elsewhere (the avatar menu) brings its section into view.
  useEffect(() => {
    if (!openTile) return;
    body.current?.querySelector(`[data-tiles~="${openTile}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openTile]);

  const openSwitcher = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [
      { id: "scope-main", label: "Main Profile", checked: scope.kind === "main", onSelect: () => onScope({ kind: "main" }) },
      ...(guilds.length > 0 ? [{ type: "separator" } as const] : []),
      ...guilds.map(g => ({
        id: `scope-${g.id}`,
        label: g.name,
        icon: <GuildIcon guild={g} size={20} />,
        checked: scope.kind === "guild" && scope.guildId === g.id,
        onSelect: () => onScope({ kind: "guild", guildId: g.id }),
      })),
    ];
    menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, items);
  };

  return (
    <aside className="pe-left" aria-label="Profile customisation">
      <div className="pe-left-head">
        <button type="button" className="pe-switcher" aria-haspopup="menu" aria-label="Profile" onClick={openSwitcher}>
          <span className="pe-switcher-label">{guildName ?? "Main Profile"}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
        <button type="button" className="pe-icon-btn" aria-label="Collapse sidebar" onClick={onCollapse}>
          <ChevronsLeft size={20} />
        </button>
      </div>
      <div className="pe-left-body" ref={body}>
        {scope.kind === "guild" && <p className="pe-note">You are editing your profile in {guildName}. Colour, decoration, effect and name style are shared with your main profile.</p>}
        {SECTIONS.map(section => (
          <section key={section.label} className="pe-section-block" data-tiles={section.tiles.join(" ")}>
            <h3 className="pe-label">{section.label}</h3>
            <div className={`pe-tiles${section.tiles.length > 1 ? " pair" : ""}`}>
              {section.tiles.map(id => {
                const Tile = resolveProfileEditorTile(id, fallback(id));
                return (
                  <Tile
                    key={id}
                    user={user}
                    scope={scope}
                    draft={draft}
                    look={look}
                    setDraft={setDraft}
                    setExtra={setExtra}
                    locked={scope.kind === "guild" && MAIN_ONLY.has(id)}
                    uploadChannel={uploadChannel}
                    open={openTile === id}
                    setOpen={next => setOpenTile(next ? id : openTile === id ? null : openTile)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

/** Shell used by the editor to read the guilds a user can pick a server profile for. */
export function useEditorGuilds(): Guild[] {
  const guilds = useStore(s => s.guilds);
  const order = useStore(s => s.guildOrder);
  return order.map(id => guilds[id]).filter((g): g is Guild => !!g);
}
