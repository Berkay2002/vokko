import type { Snowflake, User } from '../api/types';
import { avatarUrl, useMemberAvatar } from './shell';

/** `guildId` (guild channels only): the member's per-server avatar wins over the user's own, as in the shell's Avatar. */
export function Avatar({ user, size = 40, className, guildId }: { user: Pick<User, 'id' | 'avatar'>; size?: number; className?: string; guildId?: Snowflake | null }) {
  const memberAvatar = useMemberAvatar(guildId, user.id);
  return <img className={`chat-avatar${className ? ` ${className}` : ''}`} width={size} height={size} style={{ width: size, height: size }} src={avatarUrl({ id: user.id, avatar: memberAvatar || user.avatar })} alt="" draggable={false} />;
}
