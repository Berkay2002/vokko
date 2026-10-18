import { appStore, channelOrThread, displayName } from "../api/store";
import type { Message } from "../api/types";
import { plainPreview } from "./util";

/** plainPreview of a message, with mentions named from the message and the store (util.ts cannot import the store). */
export function messagePreview(message: Pick<Message, "content" | "mentions">, max?: number): string {
  const s = appStore.getState();
  return plainPreview(message.content, max, {
    user: id => {
      const user = message.mentions.find(u => u.id === id) ?? s.users[id];
      return user ? displayName(user) : null;
    },
    role: id => Object.values(s.guilds).flatMap(g => g.roles).find(r => r.id === id)?.name,
    channel: id => channelOrThread(s, id)?.name,
  });
}
