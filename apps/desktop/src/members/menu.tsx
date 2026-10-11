import { Fingerprint } from "lucide-react";
import type { MenuItem } from "../ui";
import type { Snowflake, User } from "../api/types";
import { UNAVAILABLE, userContextItems } from "../shell/menus";

type Item = Exclude<MenuItem, { type: "separator" }>;

const SEP: MenuItem = { type: "separator" };
const unavailable = (id: string, label: string, danger?: boolean): Item => ({ id, label, danger, disabled: true, tooltip: UNAVAILABLE });

/**
 * The row "⋮" menu of the members table, Discord's order: Profile, Message | Change Nickname, Ignore, Block | Roles, Open in Mod View |
 * Copy User ID. Actions come from the shared user context menu (same permission checks and requests); entries Vokko lacks are disabled.
 */
export function memberRowItems(user: User, guildId: Snowflake, anchor: HTMLElement | null): MenuItem[] {
  const shared = new Map<string, Item>();
  for (const item of userContextItems(user, { guildId, anchor })) if (!("type" in item)) shared.set(item.id, item);
  const pick = (...ids: string[]) => ids.flatMap(id => (shared.has(id) ? [shared.get(id) as Item] : []));
  const copyId = shared.get("copy-id");
  const groups: Item[][] = [
    pick("profile", "message"),
    [...pick("change-nickname"), ...(shared.has("message") ? [unavailable("ignore", "Ignore")] : []), ...pick("block", "unblock")],
    [...pick("roles"), unavailable("mod-view", "Open in Mod View")],
    copyId ? [{ ...copyId, icon: <Fingerprint size={18} aria-hidden="true" /> }] : [],
  ];
  const out: MenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push(SEP);
    out.push(...group);
  }
  return out;
}
