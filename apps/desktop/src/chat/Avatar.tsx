import type { Snowflake, User } from '../api/types';
import { AnimatedImage, avatarUrl, useMemberAvatar } from './shell';

/** `guildId` (guild channels only): the member's per-server avatar wins over the user's own, as in the shell's Avatar. */
export function Avatar({ user, size = 40, className, guildId }: { user: Pick<User, 'id' | 'avatar'>; size?: number; className?: string; guildId?: Snowflake | null }) {
  const memberAvatar = useMemberAvatar(guildId, user.id);
  const src = avatarUrl({ id: user.id, avatar: memberAvatar || user.avatar });
  const props = { className: `chat-avatar${className ? ` ${className}` : ''}`, width: size, height: size, style: { width: size, height: size }, src, alt: '', draggable: false };
  // A GIF avatar follows the "Play GIFs" and reduced-motion settings (a still frame until hovered when GIFs may not autoplay).
  return /\.gif(?:[?#]|$)/i.test(src) ? <AnimatedImage kind="gif" stillWhenReduced {...props} /> : <img {...props} />;
}
