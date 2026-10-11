import type { User } from '../api/types';
import { defaultAvatarUrl } from './shell';

export function Avatar({ user, size = 40, className }: { user: Pick<User, 'id' | 'avatar'>; size?: number; className?: string }) {
  return <img className={`chat-avatar${className ? ` ${className}` : ''}`} width={size} height={size} src={user.avatar ?? defaultAvatarUrl(user.id)} alt="" draggable={false} />;
}
