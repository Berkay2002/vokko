import { ApiRequestError } from "../api/errors";
import { Perm, channelPermissions, hasBit } from "../api/permissions";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import type { Channel, Guild, Snowflake } from "../api/types";
import { chatToast } from "../chat/toast";
import { channelMoves, stepTarget, type DropTarget } from "./reorder";

/** Whether the viewer has MANAGE_ROLES in `channel` (needed to sync a moved channel with its new category). */
function canLockIn(guild: Guild): (channel: Channel) => boolean {
  const state = appStore.getState();
  const meId = state.me?.id ?? "";
  const member = state.members[guild.id]?.[meId];
  const actor = { id: meId, roles: member?.roles ?? [], communication_disabled_until: member?.communication_disabled_until };
  return channel => hasBit(channelPermissions(guild, actor, channel), Perm.MANAGE_ROLES);
}

const guildChannels = (guildId: Snowflake) => Object.values(appStore.getState().channels).filter(c => c.guild_id === guildId);

/**
 * Sends PATCH /guilds/{id}/channels for moving `id` to `target`. The sidebar only moves on the CHANNEL_UPDATE events, so a
 * rejected request leaves every row where it was; the reason goes to the toast (a polite live region). Resolves true on success.
 */
export async function moveChannel(guild: Guild, id: Snowflake, target: DropTarget): Promise<boolean> {
  const updates = channelMoves(guildChannels(guild.id), id, target, canLockIn(guild));
  if (updates.length === 0) return false;
  try {
    await request<void>("PATCH", `/guilds/${guild.id}/channels`, updates);
    return true;
  } catch (error) {
    const denied = error instanceof ApiRequestError && error.status === 403;
    chatToast(denied ? "You don't have permission to move that channel." : "Couldn't move the channel. Try again.");
    return false;
  }
}

/** Move Up / Move Down from the context menu: moves one row and announces the new place. */
export async function stepChannel(guild: Guild, channel: Channel, direction: "up" | "down"): Promise<void> {
  const target = stepTarget(guildChannels(guild.id), channel.id, direction);
  if (!target || !(await moveChannel(guild, channel.id, target))) return;
  const neighbour = appStore.getState().channels[target.kind === "into" ? target.categoryId : target.targetId];
  chatToast(`Moved ${channel.name ?? "channel"} ${direction === "up" ? "above" : "below"} ${neighbour?.name ?? "the next one"}.`);
}

/** Move to Category: puts the channel at the top of `category`. */
export async function moveToCategory(guild: Guild, channel: Channel, category: Channel): Promise<void> {
  if (await moveChannel(guild, channel.id, { kind: "into", categoryId: category.id })) chatToast(`Moved ${channel.name ?? "channel"} to ${category.name ?? "the category"}.`);
}
