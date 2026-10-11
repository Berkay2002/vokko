import type { User } from '../api/types';
import { avatarUrl } from './shell';

export function Avatar({ user, size = 40, className }: { user: Pick<User, 'id' | 'avatar'>; size?: number; className?: string }) {
  return <img className={`chat-avatar${className ? ` ${className}` : ''}`} width={size} height={size} style={{ width: size, height: size }} src={avatarUrl(user)} alt="" draggable={false} />;
}
