// A voice channel in the channel list: speaker, name, status line, elapsed timer, hover actions and the users underneath.

import { useLocation } from "react-router";
import { Lock, MessageCircle, Pencil, Settings, UserPlus, Volume2 } from "lucide-react";
import { Perm } from "../api/permissions";
import { channelMentionCount, isChannelUnread, useStore } from "../api/store";
import type { Channel, Guild } from "../api/types";
import { isPrivateChannel } from "../shell/channelPrivacy";
import { useIsMuted } from "../shell/localState";
import { channelContextItems } from "../shell/menus";
import { openModal } from "../shell/modalStore";
import { go, guildPath } from "../shell/nav";
import { usePermissions } from "../shell/usePermissions";
import { PHONE_QUERY, Tooltip, useContextMenu } from "../ui";
import { joinVoiceChannel } from "./engine";
import { useVoice } from "./store";
import { formatElapsed, useElapsedSeconds, useVoiceUi } from "./uiStore";
import { VoiceChannelBadge, VoiceChannelUsers } from "./VoiceChannelUsers";

/** Elapsed call time, from our own voice state (so it also runs while the call is on another device). */
function ElapsedTimer({ channelId }: { channelId: string }) {
  const since = useVoice(s => (s.meId ? s.states[s.meId]?.connected_at : undefined));
  const seconds = useElapsedSeconds(since);
  const text = formatElapsed(seconds);
  return (
    <span className="voice-timer" aria-label={`Connected for ${formatElapsed(seconds)}`} data-channel-id={channelId}>
      {text}
    </span>
  );
}

export function VoiceChannelRow({ channel, guild }: { channel: Channel; guild: Guild }) {
  const location = useLocation();
  const menu = useContextMenu();
  const { can } = usePermissions(guild.id, channel.id);
  // Both hooks run on every render: `a || b` would skip the second hook while the channel itself is muted.
  const mutedSelf = useIsMuted(channel.id);
  const mutedParent = useIsMuted(channel.parent_id);
  const muted = mutedSelf || mutedParent;
  const inVoice = useVoice(s => s.channelId === channel.id || (s.meId !== null && s.states[s.meId]?.channel_id === channel.id));
  const statusText = useVoice(s => s.channelStatus[channel.id]);
  // Messages in the channel's text-in-voice chat.
  const unread = useStore(s => isChannelUnread(s, channel.id));
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const selected = location.pathname === `/channels/${guild.id}/${channel.id}`;
  const name = channel.name ?? "voice";
  // The server lets MANAGE_CHANNELS set it anywhere, SET_VOICE_CHANNEL_STATUS only while in that channel.
  const canSetStatus = can(Perm.MANAGE_CHANNELS) || (inVoice && can(Perm.SET_VOICE_CHANNEL_STATUS));
  const showStatus = (inVoice && canSetStatus) || !!statusText;
  const canInvite = can(Perm.CREATE_INSTANT_INVITE);
  const className = `channel-row voice${selected ? " selected" : ""}${unread && !muted ? " unread" : ""}${muted ? " muted" : ""}${inVoice ? " connected" : ""}${showStatus ? " has-status" : ""}`;
  const open = () => {
    // A phone opens the channel's preview (Join button) first; joining at once is the desktop behaviour.
    if (!window.matchMedia(PHONE_QUERY).matches) joinVoiceChannel(channel);
    go(guildPath(guild.id, channel.id));
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <li className="channel-row-wrap">
      <div
        className={className}
        role="button"
        tabIndex={0}
        aria-label={`${name} voice channel`}
        onClick={e => !(e.target as HTMLElement).closest(".channel-actions, .voice-status-line") && open()}
        onKeyDown={e => e.key === "Enter" && e.target === e.currentTarget && open()}
        onContextMenu={e => menu.open(e, channelContextItems(channel, guild))}
      >
        {isPrivateChannel(channel, guild.id) ? <Lock size={20} className="channel-icon" /> : <Volume2 size={20} className="channel-icon" />}
        <span className="channel-name">{name}</span>
        <VoiceChannelBadge channel={channel} />
        {mentions > 0 ? <span className="count-badge">{mentions}</span> : null}
        {inVoice && <ElapsedTimer channelId={channel.id} />}
        <span className="channel-actions" onClick={stop}>
          <Tooltip content="Open Chat" side="top">
            <button
              type="button"
              className="channel-action"
              aria-label="Open Chat"
              onClick={() => {
                useVoiceUi.getState().setChatOpen(true);
                go(guildPath(guild.id, channel.id));
              }}
            >
              <MessageCircle size={16} />
            </button>
          </Tooltip>
          {canInvite && (
            <Tooltip content="Create Invite" side="top">
              <button type="button" className="channel-action" aria-label="Create Invite" onClick={() => openModal({ type: "invite", channelId: channel.id })}>
                <UserPlus size={16} />
              </button>
            </Tooltip>
          )}
          {can(Perm.MANAGE_CHANNELS) && (
            <Tooltip content="Edit Channel" side="top">
              <button type="button" className="channel-action" aria-label="Edit Channel" onClick={() => openModal({ type: "editChannel", channelId: channel.id })}>
                <Settings size={16} />
              </button>
            </Tooltip>
          )}
        </span>
        {showStatus && (
          <button type="button" className="voice-status-line" disabled={!canSetStatus} onClick={() => openModal({ type: "voiceStatus", channelId: channel.id })}>
            <span className="voice-status-text">{statusText ?? "Set channel status"}</span>
            {canSetStatus && <Pencil size={12} aria-hidden="true" />}
          </button>
        )}
      </div>
      <VoiceChannelUsers channel={channel} guildId={guild.id} canInvite={canInvite} />
    </li>
  );
}
