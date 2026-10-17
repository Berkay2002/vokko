import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, HeadphoneOff, Lock, MicOff, UserPlus, Video } from "lucide-react";
import { StremioIcon } from "../stremio";
import { displayName, useStore } from "../api/store";
import type { Channel, Snowflake, VoiceState } from "../api/types";
import { TagChip } from "../perks/TagChip";
import { useContextMenu } from "../ui";
import { listeningActivity, playingLabel } from "../activity/format";
import { ActivityIcon } from "../shell/ActivityIcon";
import { usePlaying } from "../shell/ActivityLine";
import { Avatar } from "../shell/Avatar";
import { userContextItems } from "../shell/menus";
import { openModal } from "../shell/modalStore";
import { openProfile } from "../shell/ProfileCard";
import { isChannelFull } from "./engine";
import { useIsStreaming } from "./mediaStore";
import { useChannelVoiceStates, useIsSpeaking, useVoice } from "./store";
import { SoundEffectBadge, useSoundFlashClass } from "../soundboard";
import { LivePill, StreamCard } from "./StreamCard";

function StateIcon({ label, server, children }: { label: string; server?: boolean; children: ReactNode }) {
  return (
    <span className={`voice-user-icon${server ? " server" : ""}`} role="img" aria-label={label} title={label}>
      {children}
    </span>
  );
}

const CARD_OPEN_DELAY_MS = 150;
const CARD_CLOSE_DELAY_MS = 200;

type CardMode = "hover" | "keyboard" | null;

/**
 * Open state of a row's stream card. Hover opens it (with a short leave delay so the pointer can cross to the card);
 * keyboard focus on the row opens it too, and such a card ignores the mouse passing over. ArrowRight, or Enter while open,
 * moves focus into the card; Escape closes it (from inside the card, focus goes back to the row).
 */
function useStreamCard(enabled: boolean, row: React.RefObject<HTMLLIElement | null>) {
  const [mode, setModeState] = useState<CardMode>(null);
  const [focusTick, setFocusTick] = useState(0);
  const modeRef = useRef<CardMode>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const skipFocus = useRef(false);
  const pointerDown = useRef(false);
  const setMode = (next: CardMode) => {
    modeRef.current = next;
    setModeState(next);
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (next: CardMode, ms: number) => {
    clear();
    timer.current = setTimeout(() => setMode(next), ms);
  };
  const shut = () => {
    clear();
    setMode(null);
  };
  const openByKeyboard = () => {
    clear();
    setMode("keyboard");
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!enabled) shut();
  }, [enabled]);
  const inside = (el: Element | null) => !!el && (!!row.current?.contains(el) || !!box.current?.contains(el));
  const open = mode !== null && enabled;
  return {
    open,
    focusTick,
    box,
    close: shut,
    /** Escape in the card (or after Watch Stream): close it and give focus back to the row without reopening the card. */
    dismiss() {
      const refocus = !!box.current?.contains(document.activeElement);
      shut();
      if (refocus) {
        skipFocus.current = true;
        row.current?.focus();
      }
    },
    /** Row keys for the card; true when the key was used (the row then skips its own Enter). */
    onRowKey(e: React.KeyboardEvent): boolean {
      if (!enabled || e.target !== e.currentTarget) return false;
      if (e.key === "ArrowRight" || (e.key === "Enter" && open)) {
        e.preventDefault();
        openByKeyboard();
        setFocusTick(t => t + 1);
        return true;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        e.stopPropagation();
        shut();
        return true;
      }
      return false;
    },
    rowProps: {
      onPointerDown: () => {
        // Only when this press will focus the row: on an already focused row no focus event follows to clear the flag.
        pointerDown.current = document.activeElement !== row.current;
      },
      onMouseEnter: () => enabled && modeRef.current !== "keyboard" && later("hover", CARD_OPEN_DELAY_MS),
      onMouseLeave: () => enabled && modeRef.current !== "keyboard" && later(null, CARD_CLOSE_DELAY_MS),
      onFocus: (e: React.FocusEvent) => {
        if (e.target !== e.currentTarget) return;
        // A click focuses the row too: that opens the profile, not the card (no flash).
        const byPointer = pointerDown.current;
        pointerDown.current = false;
        if (skipFocus.current) skipFocus.current = false;
        else if (enabled && !byPointer) openByKeyboard();
      },
      onBlur: (e: React.FocusEvent) => {
        if (e.target === e.currentTarget && !inside(e.relatedTarget as Element | null)) shut();
      },
    },
    cardProps: {
      onPointerEnter: clear,
      onPointerLeave: () => modeRef.current === "hover" && later(null, CARD_CLOSE_DELAY_MS),
      onBlurOut: (next: Element | null) => {
        if (!inside(next)) shut();
      },
    },
  };
}

function VoiceUserRow({ state, guildId }: { state: VoiceState; guildId: Snowflake }) {
  const user = useStore(s => s.users[state.user_id]) ?? state.member?.user;
  const member = useStore(s => s.members[guildId]?.[state.user_id]) ?? state.member;
  const tagGuildName = useStore(s => (user?.primary_guild ? s.guilds[user.primary_guild.guild_id]?.name : undefined));
  const speaking = useIsSpeaking(state.user_id);
  const flash = useSoundFlashClass(state.user_id);
  const localMuted = useVoice(s => !!s.localMutes[state.user_id]);
  // Other people's rows dim while you are not in their call and they are not talking (reference spec 1).
  const away = useVoice(s => s.channelId !== state.channel_id);
  const menu = useContextMenu();
  const row = useRef<HTMLLIElement>(null);
  const playing = usePlaying(state.user_id);
  const streaming = useIsStreaming(state);
  const listening = useStore(s => listeningActivity(s.presences[state.user_id]));
  const carded = streaming || !!listening;
  const card = useStreamCard(carded, row);
  if (!user) return null;
  const name = displayName(user, member);
  const muted = state.mute || state.self_mute || state.suppress;
  const deaf = state.deaf || state.self_deaf;
  const item = (
    <li
      ref={row}
      className={`voice-occupant voice-user${speaking ? " speaking" : ""}${away && !speaking ? " away" : ""}${flash}`}
      data-user-id={state.user_id}
      data-speaking={speaking || undefined}
      tabIndex={0}
      aria-label={`${name}${streaming ? ", streaming" : ""}${speaking ? ", speaking" : ""}`}
      aria-haspopup={carded ? "dialog" : undefined}
      aria-expanded={carded ? card.open : undefined}
      {...card.rowProps}
      onClick={() => {
        card.close();
        if (row.current) openProfile(row.current, state.user_id, guildId);
      }}
      onKeyDown={e => {
        if (card.onRowKey(e) || e.key !== "Enter" || !row.current) return;
        card.close();
        openProfile(row.current, state.user_id, guildId);
      }}
      onContextMenu={e => {
        card.close();
        menu.open(e, userContextItems(user, { guildId, anchor: row.current }));
      }}
    >
      <span className="voice-user-avatar">
        <Avatar user={user} member={member} size={24} decoration={false} />
        <SoundEffectBadge userId={state.user_id} />
      </span>
      <span className="voice-occupant-name">{name}</span>
      <TagChip tag={user.primary_guild} guildName={tagGuildName} />
      {streaming && <LivePill className="voice-user-live" />}
      {playing && (
        <span className="voice-user-game" role="img" aria-label={playingLabel(playing)} title={playingLabel(playing)}>
          <ActivityIcon activity={playing} size={14} />
        </span>
      )}
      <span className="voice-user-icons">
        {state.self_video && (
          <StateIcon label="Camera On">
            <Video size={14} />
          </StateIcon>
        )}
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
  if (!carded || !state.channel_id) return item;
  // A sibling of the row, not a child: React events bubble through portals, so a click in the card would open the profile.
  return (
    <>
      {item}
      <StreamCard
        anchor={row.current}
        open={card.open}
        focusTick={card.focusTick}
        onDismiss={card.dismiss}
        userId={state.user_id}
        channelId={state.channel_id}
        name={name}
        listening={streaming ? null : listening}
        boxRef={card.box}
        {...card.cardProps}
      />
    </>
  );
}

/** Connected users under a voice channel in the channel list (speaking rings only inside your own call). */
export function VoiceChannelUsers({ channel, guildId, canInvite }: { channel: Pick<Channel, "id" | "name">; guildId: Snowflake; canInvite?: boolean }) {
  const states = useChannelVoiceStates(channel.id);
  const inside = useVoice(s => s.channelId === channel.id || (s.meId !== null && s.states[s.meId]?.channel_id === channel.id));
  const bot = useVoice(s => s.stremio[channel.id]?.bot_identity);
  if (states.length === 0) return null;
  return (
    <ul className="voice-occupants voice-users" aria-label={`Users in ${channel.name ?? "voice channel"}`}>
      {states.map(state => (
        <VoiceUserRow key={state.user_id} state={state} guildId={guildId} />
      ))}
      {bot && (
        <li className="voice-bot-user" data-bot-identity={bot}>
          <span className="voice-bot-avatar" aria-hidden="true">
            <StremioIcon size={14} />
          </span>
          <span>Stremio</span>
          <span className="voice-bot-badge">Bot</span>
        </li>
      )}
      {inside && canInvite && (
        <li className="voice-invite-item">
          <button type="button" className="voice-invite-row" onClick={() => openModal({ type: "invite", channelId: channel.id })}>
            <span className="voice-invite-icon">
              <UserPlus size={14} />
            </span>
            <span className="voice-invite-label">Invite to voice</span>
            <ChevronRight size={16} className="voice-invite-chevron" />
          </button>
        </li>
      )}
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
