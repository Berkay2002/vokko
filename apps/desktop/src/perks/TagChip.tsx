import { Hexagon } from "lucide-react";
import type { UserPrimaryGuild } from "../api/types";
import { badgeById, intToHex } from "./catalog";

/**
 * A server tag as a static chip (badge glyph + 1-4 letters), styled by the same `.chat-server-tag` rules as the tag next to message
 * authors so it looks identical in profile cards and previews. Click-through tag cards live in `chat/ServerTag.tsx`.
 */
export function TagChip({ tag, guildName }: { tag: Pick<UserPrimaryGuild, "tag" | "badge" | "color_primary"> | null | undefined; guildName?: string }) {
  if (!tag || !tag.tag) return null;
  const Icon = badgeById(tag.badge)?.Icon ?? Hexagon;
  return (
    <span className="chat-server-tag static" title={guildName ? `${tag.tag} · ${guildName}` : tag.tag}>
      <Icon size={14} strokeWidth={2.5} className="chat-server-tag-badge" style={tag.color_primary > 0 ? { color: intToHex(tag.color_primary) } : undefined} aria-hidden="true" />
      <span>{tag.tag}</span>
    </span>
  );
}
