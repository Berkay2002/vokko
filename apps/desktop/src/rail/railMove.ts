// Moving a rail server or folder one place from its context menu (Shift+F10 / the Menu key reach it from the keyboard).
// Drag-and-drop stays in RailGuilds; both save through the same guild-layout PATCH.

import { appStore } from "../api/store";
import { chatToast } from "../chat/toast";
import type { MenuItem } from "../ui";
import { guildLayoutStore, saveGuildLayout } from "./guildLayoutStore";
import { entriesToSettings, placeOf, railEntries, stepItem, stepTarget, type RailEntry, type RailItem } from "./railOrder";

const currentEntries = (): RailEntry[] => railEntries(appStore.getState().guildOrder, guildLayoutStore.getState().settings);

/** The moved tile re-mounts when it changes parent and blurs when its node is moved: put focus back once the rail has rendered. */
function refocus(item: RailItem): void {
  const selector = item.kind === "guild" ? `.server-rail a.rail-guild[href^="/channels/${item.id}"]` : `.server-rail [data-folder-id="${item.id}"] .rail-folder-tile`;
  // A few frames, because the menu hands focus back to the old (possibly detached) tile when it closes, after the first render.
  const attempt = (left: number): void => {
    requestAnimationFrame(() => {
      // Only when focus was lost: never take it back from something the user moved on to.
      if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>(selector)?.focus();
      if (left > 0) attempt(left - 1);
    });
  };
  attempt(3);
}

function nameOf(item: RailItem, entries: readonly RailEntry[]): string {
  const { guilds } = appStore.getState();
  if (item.kind === "guild") return guilds[item.id]?.name ?? "Server";
  const folder = entries.find(e => e.kind === "folder" && e.folder.id === item.id);
  if (folder?.kind !== "folder") return "Folder";
  return folder.folder.name ?? folder.folder.guild_ids.map(id => guilds[id]?.name).filter(Boolean).join(", ");
}

/** Moves `item` one place, saves it like a drag does, keeps focus on it and says where it ended up. */
export function stepRailItem(item: RailItem, direction: "up" | "down"): void {
  const next = stepItem(currentEntries(), item, direction);
  if (!next) return;
  saveGuildLayout(entriesToSettings(next)).catch(() => undefined);
  refocus(item);
  const { place, total, folderId } = placeOf(next, item);
  const where = folderId ? `in ${nameOf({ kind: "folder", id: folderId }, next)}` : "on the server rail";
  chatToast(`Moved ${item.kind === "folder" ? "folder " : ""}${nameOf(item, next)} ${direction === "up" ? "up" : "down"} to ${place} of ${total} ${where}.`);
}

/** Move Up / Move Down rows for a server's or folder's menu; a row is disabled where the item cannot move that way. */
export function railMoveItems(item: RailItem): MenuItem[] {
  const entries = currentEntries();
  return (["up", "down"] as const).map(direction => ({
    id: `rail-move-${direction}`,
    label: direction === "up" ? "Move Up" : "Move Down",
    disabled: !stepTarget(entries, item, direction),
    onSelect: () => stepRailItem(item, direction),
  }));
}
