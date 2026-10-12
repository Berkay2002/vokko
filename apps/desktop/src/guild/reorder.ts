import { compareIds } from "../api/snowflake";
import { ChannelType, type Channel, type PermissionOverwrite, type Snowflake } from "../api/types";

/** One entry of PATCH /guilds/{id}/channels (Discord's "Modify Guild Channel Positions"). */
export interface ChannelPositionUpdate {
  id: Snowflake;
  position: number;
  parent_id?: Snowflake | null;
  lock_permissions?: boolean;
}

/** Where a dragged row lands: next to another row, or at the top of a category. */
export type DropTarget = { kind: "before" | "after"; targetId: Snowflake } | { kind: "into"; categoryId: Snowflake };

const byPosition = (a: Channel, b: Channel) => a.position - b.position || compareIds(a.id, b.id);
/** Voice channels sort below the text run; stage channels stay in the text run, like groupChannels (shell/channels.ts). */
const isVoice = (c: Channel) => c.type === ChannelType.GuildVoice;

const overwriteKey = (list: PermissionOverwrite[] | undefined) =>
  (list ?? [])
    .map(o => `${o.id}:${o.type}:${o.allow}:${o.deny}`)
    .sort()
    .join("|");

/** A channel is "synced" with its category when their overwrites are identical (Discord keeps it synced on a move). */
export function isSynced(channel: Channel, parent: Channel | undefined): boolean {
  return !!parent && overwriteKey(channel.permission_overwrites) === overwriteKey(parent.permission_overwrites);
}

/** Renumbers `list` 0..n and returns the entries whose position (or parent, via `moved`) changed. */
function renumber(list: Channel[], moved: ChannelPositionUpdate | null): ChannelPositionUpdate[] {
  const out: ChannelPositionUpdate[] = [];
  list.forEach((channel, position) => {
    if (moved && channel.id === moved.id) out.push({ ...moved, position });
    else if (channel.position !== position) out.push({ id: channel.id, position });
  });
  return out;
}

function insertAt(list: Channel[], item: Channel, anchorId: Snowflake | null, after: boolean): Channel[] {
  const rest = list.filter(c => c.id !== item.id);
  const index = anchorId ? rest.findIndex(c => c.id === anchorId) : -1;
  if (index < 0) return after ? [...rest, item] : [item, ...rest];
  rest.splice(after ? index + 1 : index, 0, item);
  return rest;
}

/**
 * The position updates for dropping `dragId` on `target`, in the sidebar's model: categories are ordered among themselves;
 * channels are ordered inside their parent, text-like channels and voice channels each in their own run (voice sorts below text).
 * Returns [] when nothing would change or the drop is not allowed (a category dropped into a category).
 * `canLock(channel)`: whether the viewer may sync the channel's permissions (MANAGE_ROLES in it); without it a moved synced
 * channel keeps its overwrites instead of the server refusing the whole request.
 */
export function channelMoves(channels: Channel[], dragId: Snowflake, target: DropTarget, canLock: (channel: Channel) => boolean = () => true): ChannelPositionUpdate[] {
  const byId = new Map(channels.map(c => [c.id, c]));
  const dragged = byId.get(dragId);
  if (!dragged) return [];
  const anchorId = target.kind === "into" ? target.categoryId : target.targetId;
  if (anchorId === dragId) return [];
  const anchor = byId.get(anchorId);
  if (!anchor) return [];
  const categories = channels.filter(c => c.type === ChannelType.GuildCategory).sort(byPosition);

  if (dragged.type === ChannelType.GuildCategory) {
    // A category dropped on a channel goes next to that channel's category.
    const anchorCategory = anchor.type === ChannelType.GuildCategory ? anchor : anchor.parent_id ? byId.get(anchor.parent_id) : undefined;
    if (!anchorCategory || anchorCategory.id === dragged.id) return [];
    const after = target.kind === "after" || (target.kind === "into" && anchorCategory.position > dragged.position);
    return renumber(insertAt(categories, dragged, anchorCategory.id, after), null);
  }

  const known = new Set(categories.map(c => c.id));
  const parentOf = (c: Channel) => (c.parent_id && known.has(c.parent_id) ? c.parent_id : null);
  let parent: Snowflake | null;
  let anchorRow: Snowflake | null;
  let after: boolean;
  if (target.kind === "into" || anchor.type === ChannelType.GuildCategory) {
    parent = anchor.type === ChannelType.GuildCategory ? anchor.id : parentOf(anchor);
    anchorRow = null;
    after = false;
  } else {
    parent = parentOf(anchor);
    anchorRow = isVoice(anchor) === isVoice(dragged) ? anchor.id : null;
    // A text channel dropped among voice channels lands at the end of the text run, and the other way round.
    after = anchorRow ? target.kind === "after" : !isVoice(dragged);
  }
  const siblings = channels.filter(c => c.type !== ChannelType.GuildCategory && parentOf(c) === parent && isVoice(c) === isVoice(dragged)).sort(byPosition);
  const parentChanged = parentOf(dragged) !== parent;
  const moved: ChannelPositionUpdate = { id: dragged.id, position: 0 };
  if (parentChanged) {
    moved.parent_id = parent;
    const oldParent = dragged.parent_id ? byId.get(dragged.parent_id) : undefined;
    // Discord keeps a synced channel synced: it adopts the new category's permissions.
    if (parent && isSynced(dragged, oldParent) && canLock(dragged)) moved.lock_permissions = true;
  }
  const updates = renumber(insertAt(siblings, dragged, anchorRow, after), moved);
  return updates.some(u => u.id === dragged.id && (parentChanged || u.position !== dragged.position)) || updates.length > 1 ? updates : [];
}

/**
 * The drop target that moves `id` one row up or down among its siblings in sidebar order (categories among categories, channels
 * inside their category and run). null at either end. Keyboard counterpart of a drag (the Move Up / Move Down menu items).
 */
export function stepTarget(channels: Channel[], id: Snowflake, direction: "up" | "down"): DropTarget | null {
  const channel = channels.find(c => c.id === id);
  if (!channel) return null;
  const categories = channels.filter(c => c.type === ChannelType.GuildCategory);
  const known = new Set(categories.map(c => c.id));
  const parentOf = (c: Channel) => (c.parent_id && known.has(c.parent_id) ? c.parent_id : null);
  const siblings = (
    channel.type === ChannelType.GuildCategory
      ? categories
      : channels.filter(c => c.type !== ChannelType.GuildCategory && parentOf(c) === parentOf(channel) && isVoice(c) === isVoice(channel))
  ).sort(byPosition);
  const index = siblings.findIndex(c => c.id === id);
  const neighbour = siblings[direction === "up" ? index - 1 : index + 1];
  return neighbour ? { kind: direction === "up" ? "before" : "after", targetId: neighbour.id } : null;
}
