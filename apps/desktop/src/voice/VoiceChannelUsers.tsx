import { useRef, type ReactNode } from "react";
import { HeadphoneOff, Lock, MicOff } from "lucide-react";
import { displayName, useStore } from "../api/store";
import type { Channel, Snowflake, VoiceState } from "../api/types";
import { useContextMenu } from "../ui";
import { Avatar } from "../shell/Avatar";
import { userContextItems } from "../shell/menus";
import { openProfile } from "../shell/ProfileCard";
import { isChannelFull } from "./engine";
import { useChannelVoiceStates, useIsSpeaking, useVoice } from "./store";

function StateIcon({ label, server, children }: { label: string; server?: boolean; children: ReactNode }) {
  return (
    <span className={`voice-user-icon${server ? " server" : ""}`} role="img" aria-label={label} title={label}>
      {children}
    </span>
  );
}

function VoiceUserRow({ state, guildId }: { state: VoiceState; guildId: Snowflake }) {
  const user = useStore(s => s.users[state.user_id]) ?? state.member?.user;
  const member = useStore(s => s.members[guildId]?.[state.user_id]) ?? state.member;
  const speaking = useIsSpeaking(state.user_id);
  const localMuted = useVoice(s => !!s.localMutes[state.user_id]);
  const menu = useContextMenu();
  const row = useRef<HTMLLIElement>(null);
  if (!user) return null;
  const name = displayName(user, member);
  const muted = state.mute || state.self_mute || state.suppress;
  const deaf = state.deaf || state.self_deaf;
  return (
    <li
      ref={row}
      className={`voice-occupant voice-user${speaking ? " speaking" : ""}`}
      data-user-id={state.user_id}
      data-speaking={speaking || undefined}
      tabIndex={0}
      aria-label={`${name}${speaking ? ", speaking" : ""}`}
      onClick={() => row.current && openProfile(row.current, state.user_id, guildId)}
      onKeyDown={e => e.key === "Enter" && row.current && openProfile(row.current, state.user_id, guildId)}
      onContextMenu={e => menu.open(e, userContextItems(user, { guildId, anchor: row.current }))}
    >
      <span className="voice-user-avatar">
        <Avatar user={user} member={member} size={24} decoration={false} />
      </span>
      <span className="voice-occupant-name">{name}</span>
      <span className="voice-user-icons">
        {localMuted && (
          <StateIcon label="Locally Muted">
            <MicOff size={14} />
          </StateIcon>
        )}
        {muted && (
          <StateIcon label={state.mute ? "Server Muted" : "Muted"} server={state.mute}>
            <MicOff size={14} />
          </StateIcon>
        )}
        {deaf && (
          <StateIcon label={state.deaf ? "Server Deafened" : "Deafened"} server={state.deaf}>
            <HeadphoneOff size={14} />
          </StateIcon>
        )}
      </span>
    </li>
  );
}

/** Connected users under a voice channel in the channel list (speaking rings only inside your own call). */
export function VoiceChannelUsers({ channel, guildId }: { channel: Pick<Channel, "id" | "name">; guildId: Snowflake }) {
  const states = useChannelVoiceStates(channel.id);
  if (states.length === 0) return null;
  return (
    <ul className="voice-occupants voice-users" aria-label={`Users in ${channel.name ?? "voice channel"}`}>
      {states.map(state => (
        <VoiceUserRow key={state.user_id} state={state} guildId={guildId} />
      ))}
    </ul>
  );
}

/** "02/05" occupancy next to a voice channel with a user limit, with a lock once it is full. */
export function VoiceChannelBadge({ channel }: { channel: Channel }) {
  const count = useChannelVoiceStates(channel.id).length;
  const full = useVoice(s => isChannelFull(channel, s));
  const limit = channel.user_limit ?? 0;
  if (limit <= 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className={`voice-limit${full ? " full" : ""}`} aria-label={full ? "Channel full" : `${count} of ${limit} users`} title={full ? "Channel full" : undefined}>
      {full && <Lock size={12} aria-hidden="true" />}
      <span className="voice-limit-count">{pad(count)}</span>
      <span className="voice-limit-max">{pad(limit)}</span>
    </span>
  );
}
