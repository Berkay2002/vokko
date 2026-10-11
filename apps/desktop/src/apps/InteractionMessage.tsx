// How interaction responses and app messages render inside a message row: the "used /cmd" line, the APP tag, the deferred
// "is thinking" state and the "Only you can see this" footer of ephemeral messages.
import { useState } from "react";
import { Eye } from "lucide-react";
import { request } from "../api/rest";
import { appStore, displayName } from "../api/store";
import { ApplicationCommandType, MessageFlags, type Message } from "../api/types";
import { Avatar } from "../chat/Avatar";
import "./apps.css";

export const isEphemeral = (message: Pick<Message, "flags">): boolean => ((message.flags ?? 0) & MessageFlags.Ephemeral) !== 0;
export const isLoading = (message: Pick<Message, "flags">): boolean => ((message.flags ?? 0) & MessageFlags.Loading) !== 0;

/** The line above an interaction response: "<avatar> Name used /command" (context menu commands name their target). */
export function InteractionHeader({ message, guildId }: { message: Message; guildId: string | null }) {
  const meta = message.interaction_metadata;
  if (!meta) return null;
  const state = appStore.getState();
  const member = guildId ? state.members[guildId]?.[meta.user.id] : undefined;
  const name = displayName(state.users[meta.user.id] ?? meta.user, member);
  const target = meta.target_user ? displayName(state.users[meta.target_user.id] ?? meta.target_user, guildId ? state.members[guildId]?.[meta.target_user.id] : undefined) : null;
  return (
    <div className="chat-reply apps-used" aria-label={`${name} used ${meta.command_type === ApplicationCommandType.ChatInput ? "/" : ""}${meta.name}`}>
      <span className="chat-reply-spine" />
      <Avatar user={meta.user} size={16} className="chat-reply-avatar" guildId={guildId} />
      <span className="chat-reply-name apps-used-name">{name}</span>
      <span className="apps-used-text">
        used{" "}
        <span className="apps-used-command">
          {meta.command_type === ApplicationCommandType.ChatInput ? "/" : ""}
          {meta.name}
        </span>
        {target && <> on {target}</>}
      </span>
    </div>
  );
}

/** Bots and webhooks carry the APP tag next to their name. */
export function AppTag({ message }: { message: Message }) {
  if (!message.author.bot) return null;
  return <span className="chat-bot-tag apps-tag">APP</span>;
}

/** A deferred response before the bot fills it in. */
export function ThinkingBody({ message, name }: { message: Message; name: string }) {
  if (!isLoading(message)) return null;
  return (
    <div className="apps-thinking" role="status">
      {name} is thinking
      <span className="apps-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

/** "Only you can see this • Dismiss message" under an ephemeral message; dismissing deletes it for good. */
export function EphemeralFooter({ message }: { message: Message }) {
  const [busy, setBusy] = useState(false);
  if (!isEphemeral(message)) return null;
  return (
    <div className="apps-ephemeral">
      <Eye size={16} aria-hidden="true" />
      <span>Only you can see this</span>
      <span aria-hidden="true">•</span>
      <button
        type="button"
        className="apps-ephemeral-dismiss"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          request("DELETE", `/channels/${message.channel_id}/messages/${message.id}`).catch(() => setBusy(false));
        }}
      >
        Dismiss message
      </button>
    </div>
  );
}
