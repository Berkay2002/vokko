import { Perm } from "../api/permissions";
import { crosspostMessage } from "../api/rest";
import { useStore } from "../api/store";
import { ChannelType, MessageFlags, MessageType, type Channel, type Message } from "../api/types";
import { chatToast } from "../chat/toast";
import { usePermissions } from "../shell/usePermissions";
import { openThread, startThreadFlow } from "./threadUi";
import { hasThreadsType } from "./util";

export interface MessageThreadActions {
  /** Thread started from this message, if any. */
  thread: Channel | undefined;
  canCreateThread: boolean;
  /** The message sits in an announcement channel. */
  announcement: boolean;
  canPublish: boolean;
  published: boolean;
  createThread(): void;
  openThread(): void;
  publish(): void;
}

const isUserMessage = (m: Message): boolean => m.type === MessageType.Default || m.type === MessageType.Reply;

/**
 * Thread and announcement entries of a message (menu and hover toolbar): Create Thread / Open Thread, Publish / Published.
 * Availability follows the viewer's permissions; the server checks again.
 */
export function useMessageThreadActions(message: Message, pending: boolean): MessageThreadActions {
  const channel = useStore(s => s.channels[message.channel_id]);
  const live = useStore(s => s.threads[message.id]);
  const meId = useStore(s => s.me?.id);
  const { can } = usePermissions(message.guild_id, message.channel_id);
  const thread = live && live.parent_id === message.channel_id ? live : message.thread;
  const announcement = channel?.type === ChannelType.GuildAnnouncement;
  const published = ((message.flags ?? 0) & MessageFlags.Crossposted) !== 0;
  const copy = ((message.flags ?? 0) & MessageFlags.IsCrosspost) !== 0;
  const user = !pending && isUserMessage(message);
  const canCreateThread = user && hasThreadsType(channel) && !thread && can(Perm.CREATE_PUBLIC_THREADS) && can(Perm.READ_MESSAGE_HISTORY);
  const canPublish = user && announcement && !copy && (message.author.id === meId ? can(Perm.SEND_MESSAGES) : can(Perm.MANAGE_MESSAGES));
  return {
    thread,
    canCreateThread,
    announcement,
    canPublish,
    published,
    createThread: () => startThreadFlow(message.channel_id, message),
    openThread: () => thread && openThread(thread),
    publish: () => {
      crosspostMessage(message.channel_id, message.id).catch((e: unknown) => chatToast(e instanceof Error ? `Could not publish: ${e.message}` : "Could not publish this message."));
    },
  };
}
