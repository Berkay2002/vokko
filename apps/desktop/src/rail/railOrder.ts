// Server rail order and folders (docs/api.md "Invites and server folders"): pure functions from the joined guilds and the stored
// `GuildLayout` to the rail's items, and the drag-and-drop edits back to settings.

import type { GuildFolder, Snowflake, GuildLayout } from "../api/types";

export type RailEntry = { kind: "guild"; guildId: Snowflake } | { kind: "folder"; folder: GuildFolder };

/** Where a dragged server or folder is dropped. `combine` on a top-level server makes a new folder with id `newFolderId`. */
export type DropTarget =
  | { kind: "before" | "after"; guildId: Snowflake }
  | { kind: "before" | "after"; folderId: string }
  | { kind: "combine"; guildId: Snowflake; newFolderId: string }
  | { kind: "into"; folderId: string }
  | { kind: "end" };

export const EMPTY_SETTINGS: GuildLayout = { guild_folders: [], guild_positions: [] };

/**
 * The rail: guilds in `guild_positions` order, then the ones missing from it in join order (`guildOrder`). A folder sits where its
 * first server would be and lists its servers in folder order. Guild ids the user is no longer in are dropped, and so are folders
 * left without servers.
 */
export function railEntries(guildOrder: readonly Snowflake[], settings: GuildLayout): RailEntry[] {
  const known = new Set(guildOrder);
  const ordered: Snowflake[] = [];
  const seen = new Set<Snowflake>();
  for (const id of [...settings.guild_positions, ...guildOrder]) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  const folderOf = new Map<Snowflake, GuildFolder>();
  for (const folder of settings.guild_folders) {
    const guildIds = folder.guild_ids.filter(id => known.has(id) && !folderOf.has(id));
    if (guildIds.length === 0) continue;
    const live = { ...folder, guild_ids: guildIds };
    for (const id of guildIds) folderOf.set(id, live);
  }
  const entries: RailEntry[] = [];
  const placed = new Set<string>();
  for (const id of ordered) {
    const folder = folderOf.get(id);
    if (!folder) entries.push({ kind: "guild", guildId: id });
    else if (!placed.has(folder.id)) {
      placed.add(folder.id);
      entries.push({ kind: "folder", folder });
    }
  }
  return entries;
}

/** Settings that reproduce `entries` (positions are the flattened rail). */
export function entriesToSettings(entries: readonly RailEntry[]): GuildLayout {
  const guild_folders: GuildFolder[] = [];
  const guild_positions: Snowflake[] = [];
  for (const entry of entries) {
    if (entry.kind === "guild") guild_positions.push(entry.guildId);
    else {
      guild_folders.push({ ...entry.folder, guild_ids: [...entry.folder.guild_ids] });
      guild_positions.push(...entry.folder.guild_ids);
    }
  }
  return { guild_folders, guild_positions };
}

/** Every guild id on the rail, top to bottom. */
export const flatGuildIds = (entries: readonly RailEntry[]): Snowflake[] => entries.flatMap(e => (e.kind === "guild" ? [e.guildId] : e.folder.guild_ids));

function withoutGuild(entries: readonly RailEntry[], guildId: Snowflake): RailEntry[] {
  const out: RailEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "guild") {
      if (entry.guildId !== guildId) out.push(entry);
    } else {
      const guildIds = entry.folder.guild_ids.filter(id => id !== guildId);
      if (guildIds.length > 0) out.push({ kind: "folder", folder: { ...entry.folder, guild_ids: guildIds } });
    }
  }
  return out;
}

const folderIndex = (entries: readonly RailEntry[], folderId: string) => entries.findIndex(e => e.kind === "folder" && e.folder.id === folderId);

/** Index of the top-level entry holding `guildId` (itself or its folder). */
const holderIndex = (entries: readonly RailEntry[], guildId: Snowflake) => entries.findIndex(e => (e.kind === "guild" ? e.guildId === guildId : e.folder.guild_ids.includes(guildId)));

function replaceFolder(entries: RailEntry[], index: number, guildIds: Snowflake[]): void {
  const entry = entries[index];
  if (entry?.kind === "folder") entries[index] = { kind: "folder", folder: { ...entry.folder, guild_ids: guildIds } };
}

/** Moves a server to `target`; dropping it on itself changes nothing. */
export function moveGuild(entries: readonly RailEntry[], guildId: Snowflake, target: DropTarget): RailEntry[] {
  if ("guildId" in target && target.guildId === guildId) return [...entries];
  const out = withoutGuild(entries, guildId);
  const single: RailEntry = { kind: "guild", guildId };
  switch (target.kind) {
    case "end":
      out.push(single);
      return out;
    case "into": {
      const index = folderIndex(out, target.folderId);
      const entry = out[index];
      if (entry?.kind !== "folder") return [...entries];
      replaceFolder(out, index, [...entry.folder.guild_ids, guildId]);
      return out;
    }
    case "combine": {
      const index = holderIndex(out, target.guildId);
      const entry = out[index];
      if (!entry) return [...entries];
      if (entry.kind === "folder") {
        // Dropped on a server inside a folder: it joins that folder right after it.
        const ids = [...entry.folder.guild_ids];
        ids.splice(ids.indexOf(target.guildId) + 1, 0, guildId);
        replaceFolder(out, index, ids);
      } else {
        out[index] = { kind: "folder", folder: { id: target.newFolderId, name: null, color: null, guild_ids: [target.guildId, guildId] } };
      }
      return out;
    }
    case "before":
    case "after": {
      const offset = target.kind === "after" ? 1 : 0;
      if ("folderId" in target) {
        const index = folderIndex(out, target.folderId);
        if (index < 0) return [...entries];
        out.splice(index + offset, 0, single);
        return out;
      }
      const index = holderIndex(out, target.guildId);
      const entry = out[index];
      if (!entry) return [...entries];
      if (entry.kind === "folder") {
        const ids = [...entry.folder.guild_ids];
        ids.splice(ids.indexOf(target.guildId) + offset, 0, guildId);
        replaceFolder(out, index, ids);
      } else {
        out.splice(index + offset, 0, single);
      }
      return out;
    }
  }
}

/** Moves a whole folder before/after a top-level entry (a server inside another folder counts as that folder). */
export function moveFolder(entries: readonly RailEntry[], folderId: string, target: DropTarget): RailEntry[] {
  const from = folderIndex(entries, folderId);
  const folder = entries[from];
  if (!folder) return [...entries];
  const out = entries.filter((_, index) => index !== from);
  if (target.kind === "end") return [...out, folder];
  if (target.kind !== "before" && target.kind !== "after") return [...entries];
  const index = "folderId" in target ? folderIndex(out, target.folderId) : holderIndex(out, target.guildId);
  if (index < 0) return [...entries];
  out.splice(index + (target.kind === "after" ? 1 : 0), 0, folder);
  return out;
}

/** Replaces a folder by its servers, in place. */
export function ungroupFolder(entries: readonly RailEntry[], folderId: string): RailEntry[] {
  return entries.flatMap(entry => (entry.kind === "folder" && entry.folder.id === folderId ? entry.folder.guild_ids.map(guildId => ({ kind: "guild" as const, guildId })) : [entry]));
}

export function editFolder(entries: readonly RailEntry[], folderId: string, patch: Partial<Pick<GuildFolder, "name" | "color">>): RailEntry[] {
  return entries.map(entry => (entry.kind === "folder" && entry.folder.id === folderId ? { kind: "folder", folder: { ...entry.folder, ...patch } } : entry));
}

/** Unread state of a folder: unread if any unmuted server is, mentions add up. */
export function rollUp(states: readonly { unread: boolean; mentions: number; muted: boolean }[]): { unread: boolean; mentions: number } {
  return { unread: states.some(s => s.unread && !s.muted), mentions: states.reduce((sum, s) => sum + s.mentions, 0) };
}

/** Where on a rail tile the pointer is: the top/bottom quarter reorders, the middle combines. */
export function dropZone(offsetY: number, height: number): "before" | "after" | "middle" {
  if (offsetY < height * 0.25) return "before";
  if (offsetY > height * 0.75) return "after";
  return "middle";
}
