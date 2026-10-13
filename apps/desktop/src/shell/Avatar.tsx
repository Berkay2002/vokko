import type { CSSProperties } from "react";
import { avatarUrl, guildIconUrl, guildInitials, useStore } from "../api/store";
import type { Guild, GuildMember, PresenceStatus, Snowflake, User } from "../api/types";
import { AvatarDecoration } from "../perks/AvatarDecoration";
import { AnimatedImage } from "../ui/AnimatedMedia";

/** 10 px status badge (online dot, idle crescent, dnd bar, offline ring). Sits on a ring of the row background. */
export function StatusBadge({ status, size = 10 }: { status: PresenceStatus; size?: number }) {
  const color = status === "online" ? "var(--status-online)" : status === "idle" ? "var(--text-status-idle)" : status === "dnd" ? "var(--text-status-dnd)" : "var(--text-status-offline)";
  return (
    <svg className="status-badge" width={size} height={size} viewBox="0 0 10 10" aria-label={status} role="img">
      {status === "online" && <circle cx="5" cy="5" r="5" fill={color} />}
      {status === "idle" && <path d="M5 0a5 5 0 1 0 5 5 3.6 3.6 0 0 1-5-5z" fill={color} />}
      {status === "dnd" && (
        <>
          <circle cx="5" cy="5" r="5" fill={color} />
          <rect x="2" y="4" width="6" height="2" rx="1" fill="var(--status-badge-cut, var(--background-base-low))" />
        </>
      )}
      {status === "offline" && <path fillRule="evenodd" d="M5 0a5 5 0 1 0 0 10A5 5 0 0 0 5 0zm0 2.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" fill={color} />}
    </svg>
  );
}

export interface AvatarProps {
  user: Pick<User, "id" | "avatar"> & { avatar_decoration?: string | null };
  /** The viewer's guild context: the member's per-server avatar wins over the user's own. Pass `guildId` to look the member up in the store. */
  member?: Pick<GuildMember, "avatar"> | null;
  guildId?: Snowflake | null;
  /** Decoration id drawn around the avatar. Default: the user's own; `false` hides it. Only drawn from 32 px up. */
  decoration?: string | null | false;
  size?: number;
  /** Show a presence badge using the store presence of this user. */
  status?: boolean;
  /** Dim the avatar (offline members). */
  dim?: boolean;
  className?: string;
}

/** An avatar picture. A GIF avatar follows the "Play GIFs" and reduced-motion settings: a still first frame that plays on hover or focus when GIFs may not autoplay. */
export function AvatarImage({ src, size, className }: { src: string; size: number; className?: string }) {
  if (/\.gif(?:[?#]|$)/i.test(src)) return <AnimatedImage kind="gif" stillWhenReduced className={className} src={src} alt="" width={size} height={size} draggable={false} />;
  return <img className={className} src={src} alt="" width={size} height={size} draggable={false} />;
}

export function Avatar({ user, member, guildId, decoration, size = 32, status, dim, className }: AvatarProps) {
  const presence = useStore(s => (status ? s.presences[user.id]?.status ?? "offline" : undefined));
  const guildMember = useStore(s => (member === undefined && guildId ? s.members[guildId]?.[user.id] : undefined));
  const style: CSSProperties = { width: size, height: size };
  const decorationId = decoration === false || size < 32 ? null : decoration ?? user.avatar_decoration ?? null;
  return (
    <span className={`avatar ${className ?? ""}`} style={style}>
      <AvatarImage className={`avatar-img${dim ? " dim" : ""}`} src={avatarUrl({ id: user.id, avatar: (member ?? guildMember)?.avatar || user.avatar })} size={size} />
      {decorationId && <AvatarDecoration id={decorationId} />}
      {presence && (
        <span className="avatar-status">
          <StatusBadge status={presence} size={size >= 40 ? 12 : 10} />
        </span>
      )}
    </span>
  );
}

/** Server icon: image or the name's initials on a dark tile. */
export function GuildIcon({ guild, size = 40, className }: { guild: Pick<Guild, "name" | "icon">; size?: number; className?: string }) {
  const url = guildIconUrl(guild);
  if (url) return <img className={`guild-icon ${className ?? ""}`} src={url} alt="" width={size} height={size} style={{ width: size, height: size }} draggable={false} />;
  const initials = guildInitials(guild.name);
  return (
    <span className={`guild-icon guild-icon-text ${className ?? ""}`} style={{ width: size, height: size, fontSize: initials.length > 2 ? 12 : 14 }} aria-hidden="true">
      {initials}
    </span>
  );
}

export function useIsMe(userId: Snowflake): boolean {
  return useStore(s => s.me?.id === userId);
}
