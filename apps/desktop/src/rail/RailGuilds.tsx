// The servers part of the rail: servers and folders in the user's order (docs/api.md "Invites and server folders"), drag a server
// onto another to make a folder, drag to reorder, folders expand/collapse and roll up unread and mention badges.

import { useCallback, useMemo, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Folder } from "lucide-react";
import { appStore, guildUnread, useStore } from "../api/store";
import { timestampToSnowflake } from "../api/snowflake";
import type { Guild, Snowflake } from "../api/types";
import { Tooltip, useContextMenu, type MenuItem } from "../ui";
import { GuildIcon } from "../shell/Avatar";
import { unreadLabel } from "../shell/DmSidebar";
import { markGuildRead } from "../shell/actions";
import { isMutedAt, useLocalState } from "../shell/localState";
import { FolderSettingsModal } from "./FolderSettingsModal";
import { dropZone, editFolder, entriesToSettings, moveFolder, moveGuild, railEntries, rollUp, ungroupFolder, type DropTarget, type RailEntry } from "./railOrder";
import { saveGuildLayout, guildLayoutStore } from "./guildLayoutStore";
import "./rail.css";

type Dragged = { kind: "guild"; id: Snowflake } | { kind: "folder"; id: string };
type Zone = "before" | "after" | "middle";

const EXPANDED_KEY = "vokko.railFolders.expanded";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function storeExpanded(ids: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* a per-device convenience only */
  }
}

const newFolderId = (): string => timestampToSnowflake(Date.now(), Math.floor(Math.random() * 4096));

export const folderColor = (color: number | null): string | null => (color === null ? null : `#${color.toString(16).padStart(6, "0")}`);

/** Saves a rail edit; a failed save already restored the previous order. */
function save(entries: RailEntry[]): void {
  saveGuildLayout(entriesToSettings(entries)).catch(() => undefined);
}

function useEntries(): RailEntry[] {
  const guildOrder = useStore(s => s.guildOrder);
  const settings = guildLayoutStore(s => s.settings);
  return useMemo(() => railEntries(guildOrder, settings), [guildOrder, settings]);
}

function FolderTile({ folder, guilds, expanded, onToggle, onMenu }: { folder: RailEntry & { kind: "folder" }; guilds: Guild[]; expanded: boolean; onToggle: () => void; onMenu: (e: MouseEvent) => void }) {
  const location = useLocation();
  const ids = folder.folder.guild_ids;
  const selected = !expanded && ids.some(id => location.pathname.startsWith(`/channels/${id}`));
  // Flat primitives so the store's shallow compare can tell nothing changed.
  const flat = useStore(s => ids.flatMap(id => {
    const state = guildUnread(s, id);
    return [state.unread ? 1 : 0, state.mentions];
  }));
  const mutes = useLocalState(s => ids.map(id => (isMutedAt(s, id) ? "1" : "0")).join(""));
  const { unread, mentions } = rollUp(ids.map((_, index) => ({ unread: flat[index * 2] === 1, mentions: flat[index * 2 + 1] ?? 0, muted: mutes[index] === "1" })));
  const name = folder.folder.name ?? guilds.map(g => g.name).join(", ");
  const color = folderColor(folder.folder.color);
  const state = selected ? "selected" : unread && !expanded ? "unread" : "idle";
  const label = [`Folder ${name}`, expanded ? null : unreadLabel(mentions, unread)].filter(Boolean).join(", ");
  return (
    <div className="rail-item rail-folder-item" data-state={state}>
      <span className="rail-pill" />
      <Tooltip content={name} side="right">
        <button
          type="button"
          className={`rail-tile rail-folder-tile${expanded ? " expanded" : ""}`}
          aria-label={label}
          aria-expanded={expanded}
          data-colored={color ? "" : undefined}
          style={color ? ({ "--folder-color": color } as CSSProperties) : undefined}
          onClick={onToggle}
          onContextMenu={onMenu}
        >
          {expanded ? (
            <Folder size={20} className="rail-folder-glyph" aria-hidden="true" />
          ) : (
            <span className="rail-folder-grid" aria-hidden="true">
              {guilds.slice(0, 4).map(g => (
                <GuildIcon key={g.id} guild={g} size={20} className="rail-folder-mini" />
              ))}
            </span>
          )}
        </button>
      </Tooltip>
      {!expanded && mentions > 0 && <span className="rail-badge rail-folder-badge" aria-hidden="true">{mentions > 99 ? "99+" : mentions}</span>}
    </div>
  );
}

/** `renderGuild` draws one server (the shell's rail item). */
export function RailGuilds({ renderGuild }: { renderGuild: (guild: Guild) => ReactNode }) {
  const entries = useEntries();
  const guilds = useStore(s => s.guilds);
  const menu = useContextMenu();
  const [expanded, setExpanded] = useState(loadExpanded);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [hover, setHover] = useState<{ key: string; zone: Zone } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      storeExpanded(next);
      return next;
    });
  }, []);

  /** Where the dragged item would land for a pointer `zone` over the server or folder `key`. */
  const targetFor = (key: string, zone: Zone, inFolder: boolean): DropTarget | null => {
    if (!dragged) return null;
    const folderId = key.startsWith("folder:") ? key.slice(7) : null;
    if (dragged.kind === "folder") {
      if (zone === "middle" || inFolder) return null;
      return folderId ? { kind: zone, folderId } : { kind: zone, guildId: key };
    }
    if (zone === "middle") return folderId ? { kind: "into", folderId } : { kind: "combine", guildId: key, newFolderId: newFolderId() };
    return folderId ? { kind: zone, folderId } : { kind: zone, guildId: key };
  };

  const dropProps = (key: string, inFolder = false) => ({
    "data-drop": hover?.key === key ? hover.zone : undefined,
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!dragged || (dragged.kind === "guild" && dragged.id === key) || (dragged.kind === "folder" && key === `folder:${dragged.id}`)) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const zone = dropZone(e.clientY - rect.top, rect.height);
      if (!targetFor(key, zone, inFolder)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (hover?.key !== key || hover.zone !== zone) setHover({ key, zone });
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && hover?.key === key) setHover(null);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const target = targetFor(key, dropZone(e.clientY - rect.top, rect.height), inFolder);
      setHover(null);
      setDragged(null);
      if (!target || !dragged) return;
      const next = dragged.kind === "guild" ? moveGuild(entries, dragged.id, target) : moveFolder(entries, dragged.id, target);
      if (target.kind === "combine") {
        // A new folder opens so the result is visible.
        setExpanded(current => {
          const ids = new Set(current);
          ids.add(target.newFolderId);
          storeExpanded(ids);
          return ids;
        });
      }
      save(next);
    },
  });

  const dragProps = (item: Dragged) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.kind === "guild" ? item.id : `folder:${item.id}`);
      setDragged(item);
    },
    onDragEnd: () => {
      setDragged(null);
      setHover(null);
    },
  });

  const guildSlot = (id: Snowflake, inFolder: boolean) => {
    const guild = guilds[id];
    if (!guild) return null;
    return (
      <div key={id} className="rail-drag" data-dragging={dragged?.kind === "guild" && dragged.id === id ? "" : undefined} {...dragProps({ kind: "guild", id })} {...dropProps(id, inFolder)}>
        {renderGuild(guild)}
      </div>
    );
  };

  const folderMenu = (entry: RailEntry & { kind: "folder" }): MenuItem[] => {
    const ids = entry.folder.guild_ids;
    const open = expanded.has(entry.folder.id);
    const unread = ids.some(id => guildUnread(appStore.getState(), id).unread);
    return [
      { id: "folder-read", label: "Mark Folder As Read", disabled: !unread, onSelect: () => void Promise.all(ids.map(markGuildRead)).catch(() => undefined) },
      { type: "separator" },
      { id: "folder-toggle", label: open ? "Collapse Folder" : "Expand Folder", onSelect: () => toggle(entry.folder.id) },
      { id: "folder-settings", label: "Folder Settings", onSelect: () => setEditing(entry.folder.id) },
      { id: "folder-ungroup", label: "Remove Folder", danger: true, onSelect: () => save(ungroupFolder(entries, entry.folder.id)) },
    ];
  };

  const editingEntry = entries.find((e): e is RailEntry & { kind: "folder" } => e.kind === "folder" && e.folder.id === editing);

  return (
    <>
      {entries.map(entry => {
        if (entry.kind === "guild") return guildSlot(entry.guildId, false);
        const folderId = entry.folder.id;
        const open = expanded.has(folderId);
        const folderGuilds = entry.folder.guild_ids.map(id => guilds[id]).filter((g): g is Guild => !!g);
        const color = folderColor(entry.folder.color);
        return (
          <div
            key={`folder:${folderId}`}
            className={`rail-folder${open ? " open" : ""}`}
            data-folder-id={folderId}
            data-colored={color ? "" : undefined}
            style={color ? ({ "--folder-color": color } as CSSProperties) : undefined}
          >
            <div className="rail-drag" {...dragProps({ kind: "folder", id: folderId })} {...dropProps(`folder:${folderId}`)}>
              <FolderTile folder={entry} guilds={folderGuilds} expanded={open} onToggle={() => toggle(folderId)} onMenu={e => menu.open(e, folderMenu(entry))} />
            </div>
            {open && entry.folder.guild_ids.map(id => guildSlot(id, true))}
          </div>
        );
      })}
      {dragged && (
        <div
          className="rail-drop-end"
          data-drop={hover?.key === "end" ? "before" : undefined}
          onDragOver={e => {
            e.preventDefault();
            if (hover?.key !== "end") setHover({ key: "end", zone: "before" });
          }}
          onDrop={e => {
            e.preventDefault();
            const next = dragged.kind === "guild" ? moveGuild(entries, dragged.id, { kind: "end" }) : moveFolder(entries, dragged.id, { kind: "end" });
            setDragged(null);
            setHover(null);
            save(next);
          }}
        />
      )}
      {editingEntry && (
        <FolderSettingsModal
          folder={editingEntry.folder}
          guildNames={editingEntry.folder.guild_ids.map(id => guilds[id]?.name ?? "").filter(Boolean)}
          onClose={() => setEditing(null)}
          onSave={patch => {
            save(editFolder(entries, editingEntry.folder.id, patch));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
