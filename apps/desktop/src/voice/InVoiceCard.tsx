import { Info, MoreHorizontal, Pencil, Volume2 } from "lucide-react";
import { Perm } from "../api/permissions";
import { useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { channelContextItems } from "../shell/menus";
import { openModal } from "../shell/modalStore";
import { go, guildPath } from "../shell/nav";
import { usePermissions } from "../shell/usePermissions";
import { Tooltip, useContextMenu, type MenuItem } from "../ui";
import { useVoice } from "./store";

/** "In voice channel" card of profile popouts: where the person is, the channel status and a button to open the call. */
export function InVoiceCard({ userId, onOpen }: { userId: Snowflake; onOpen?: () => void }) {
  const state = useVoice(s => s.states[userId]);
  const user = useStore(s => s.users[userId] ?? (s.me?.id === userId ? s.me : undefined));
  // The viewer (not the card's user) is in this call: same check as the sidebar row.
  const inVoice = useVoice(s => !!state?.channel_id && (s.channelId === state.channel_id || (s.meId !== null && s.states[s.meId]?.channel_id === state.channel_id)));
  const channel = useStore(s => (state?.channel_id ? s.channels[state.channel_id] : undefined));
  const guild = useStore(s => (state?.guild_id ? s.guilds[state.guild_id] : undefined));
  const status = useVoice(s => (state?.channel_id ? s.channelStatus[state.channel_id] : undefined));
  const { can } = usePermissions(guild?.id, channel?.id);
  const menu = useContextMenu();
  if (!state?.channel_id || !channel) return null;
  // Same rule as VoiceChannelRow: MANAGE_CHANNELS anywhere, SET_VOICE_CHANNEL_STATUS only while in that channel;
  // the "Set Channel Status" placeholder only shows to someone in the call.
  const canSetStatus = can(Perm.MANAGE_CHANNELS) || (inVoice && can(Perm.SET_VOICE_CHANNEL_STATUS));
  const editStatus = canSetStatus && (!!status || inVoice);
  // Choosing an item from the "More" menu closes the profile popout too.
  const closing = (items: MenuItem[]): MenuItem[] =>
    items.map(item =>
      "type" in item
        ? item
        : { ...item, onSelect: item.onSelect && (() => (onOpen?.(), item.onSelect?.())), children: item.children && closing(item.children) },
    );
  const setStatus = () => {
    onOpen?.();
    openModal({ type: "voiceStatus", channelId: channel.id });
  };
  return (
    <section className="in-voice-card" aria-label="In voice channel">
      <div className="in-voice-header">
        <h3 className="in-voice-heading">In voice channel</h3>
        <Tooltip content="Only people who can see this channel can see this">
          <button type="button" className="in-voice-info" aria-label="Only people who can see this channel can see this">
            <Info size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        {guild && (
          <button
            type="button"
            className="in-voice-more"
            aria-label="More"
            aria-haspopup="menu"
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              menu.open({ clientX: rect.right + 4, clientY: rect.top }, closing(channelContextItems(channel, guild)));
            }}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>
      <div className="in-voice-body">
        <span className="in-voice-tile" aria-hidden="true">
          {user && <Avatar user={user} size={32} decoration={false} />}
        </span>
        <div className="in-voice-text">
          <span className="in-voice-channel">
            <Volume2 size={16} className="in-voice-channel-icon" aria-hidden="true" />
            <span className="in-voice-channel-name">{channel.name}</span>
          </span>
          {guild && <span className="in-voice-guild">in {guild.name}</span>}
          {editStatus ? (
            <button type="button" className="in-voice-status in-voice-status-button" onClick={setStatus}>
              <span className="in-voice-status-text">{status || "Set Channel Status"}</span>
              <Pencil size={12} aria-hidden="true" />
            </button>
          ) : (
            status && <span className="in-voice-status">{status}</span>
          )}
        </div>
      </div>
      {channel.guild_id && (
        <button
          type="button"
          className="in-voice-open"
          onClick={() => {
            onOpen?.();
            go(guildPath(channel.guild_id as string, channel.id));
          }}
        >
          Open Voice
        </button>
      )}
    </section>
  );
}
