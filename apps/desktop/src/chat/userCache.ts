// Users seen in message payloads (authors, mentions, reply targets). Complements the shell store, which only knows members/friends.
import type { Message, Snowflake, User } from '../api/types';

const cache = new Map<Snowflake, User>();

export function rememberMessage(m: Message): void {
  cache.set(m.author.id, m.author);
  for (const u of m.mentions) cache.set(u.id, u);
  if (m.referenced_message) cache.set(m.referenced_message.author.id, m.referenced_message.author);
}

export function rememberMessages(list: Message[]): void {
  for (const m of list) rememberMessage(m);
}

export function cachedUser(id: Snowflake): User | undefined {
  return cache.get(id);
}
