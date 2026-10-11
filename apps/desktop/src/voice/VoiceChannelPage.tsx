// The page a voice channel opens in the main area: participant tiles, the alone/empty state, the control bar and the
// text-in-voice side panel. Camera, screen share and activities are later milestones: their buttons open the UI shells.

import { useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Ellipsis, LayoutGrid, Maximize2, Mic, MicOff, Minimize2, Monitor, MonitorUp, Music, PhoneOff, SquareArrowOutUpRight, UserPlus, Users, Video, VideoOff, Volume2, HeadphoneOff } from "lucide-react";
import { Perm } from "../api/permissions";
import { displayName, useStore } from "../api/store";
import type { Channel, Snowflake, VoiceState } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { userContextItems } from "../shell/menus";
import { openModal } from "../shell/modalStore";
import { usePermissions } from "../shell/usePermissions";
import { Tooltip, useContextMenu } from "../ui";
import { useDeviceMenus } from "./deviceMenus";
import { joinVoiceChannel, leaveVoice, toggleSelfMute } from "./engine";
import { SoundboardPopout } from "./SoundboardPopout";
import { useChannelVoiceStates, useIsSpeaking, useVoice } from "./store";
import { useVoiceUi } from "./uiStore";
import { VoiceChatPanel } from "./VoiceChatPanel";

/** Stable tile colour for people without a profile colour. */
function tileColor(userId: Snowflake, bannerColor: string | null | undefined): string {
  if (bannerColor && /^#[0-9a-f]{6}$/i.test(bannerColor)) return bannerColor;
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 28% 38%)`;
}

function Tile({ state, guildId, solo }: { state: VoiceState; guildId: Snowflake | null; solo: boolean }) {
  const user = useStore(s => s.users[state.user_id]) ?? state.member?.user;
  const member = useStore(s => (guildId ? s.members[guildId]?.[state.user_id] : undefined)) ?? state.member;
  const speaking = useIsSpeaking(state.user_id);
  const own = useVoice(s => s.meId === state.user_id);
  const menu = useContextMenu();
  const tile = useRef<HTMLDivElement>(null);
  if (!user) return null;
  const name = displayName(user, member);
  const muted = state.mute || state.self_mute || state.suppress;
  const deaf = state.deaf || state.self_deaf;
  return (
    <div
      ref={tile}
      className={`voice-tile${speaking ? " speaking" : ""}${solo ? " solo" : ""}${own ? " own" : ""}`}
      data-user-id={state.user_id}
      data-speaking={speaking || undefined}
      role="group"
      aria-label={`${name}${speaking ? ", speaking" : ""}`}
      style={{ background: tileColor(user.id, user.banner_color) } as CSSProperties}
      onContextMenu={e => menu.open(e, userContextItems(user, { guildId, anchor: tile.current }))}
    >
      <Avatar user={user} member={member} size={solo ? 100 : 80} decoration={false} className="voice-tile-avatar" />
      <span className="voice-tile-name">
        <span className="voice-tile-name-text">{name}</span>
        {muted && <MicOff size={14} aria-label="Muted" role="img" />}
        {deaf && <HeadphoneOff size={14} aria-label="Deafened" role="img" />}
      </span>
    </div>
  );
}

function BarButton({ label, tooltip, active, danger, disabled, onClick, buttonRef, children }: { label: string; tooltip?: string; active?: boolean; danger?: boolean; disabled?: boolean; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; buttonRef?: (el: HTMLButtonElement | null) => void; children: React.ReactNode }) {
  return (
    <Tooltip content={tooltip ?? label} side="top">
      <button
        ref={buttonRef}
        type="button"
        className={`voice-bar-button${active ? " active" : ""}${danger ? " danger" : ""}`}
        aria-label={label}
        aria-pressed={active}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ControlBar({ channel, page }: { channel: Channel; page: React.RefObject<HTMLElement | null> }) {
  const muted = useVoice(s => s.selfMute);
  const deafened = useVoice(s => s.selfDeaf);
  const menu = useContextMenu();
  const { micItems } = useDeviceMenus();
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const [boardAnchor, setBoardAnchor] = useState<HTMLElement | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const below = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { clientX: rect.left, clientY: rect.top - 4 };
  };
  const toggleFullscreen = () => {
    const el = page.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().then(() => setFullscreen(false));
    else void el.requestFullscreen?.().then(() => setFullscreen(true), () => undefined);
  };
  const micLabel = muted || deafened ? "Unmute microphone" : "Mute microphone";
  return (
    <div className="voice-bar">
      <div className="voice-bar-group">
        <BarButton label={micLabel} tooltip={muted ? "Unmute" : "Mute"} active={muted} onClick={toggleSelfMute}>
          {muted || deafened ? <MicOff size={20} /> : <Mic size={20} />}
        </BarButton>
        <BarButton label="Input options" tooltip="Input Options" onClick={e => menu.open(below(e), micItems())}>
          <ChevronDown size={16} />
        </BarButton>
        <BarButton label="Turn on camera" tooltip="Turn On Camera" onClick={() => openModal({ type: "cameraPreview" })}>
          <VideoOff size={20} />
        </BarButton>
        <BarButton label="Camera options" tooltip="Camera Options" onClick={() => openModal({ type: "cameraPreview" })}>
          <ChevronDown size={16} />
        </BarButton>
      </div>
      <div className="voice-bar-group">
        <BarButton label="Share your screen" onClick={() => openModal({ type: "screenShare" })}>
          <MonitorUp size={20} />
        </BarButton>
        <BarButton label="Start an activity" tooltip="Activities aren't available yet" disabled>
          <LayoutGrid size={20} />
        </BarButton>
        <BarButton label="Soundboard" tooltip="Open Soundboard" active={boardOpen} buttonRef={setBoardAnchor} onClick={() => setBoardOpen(o => !o)}>
          <Music size={20} />
        </BarButton>
        <BarButton
          label="More"
          onClick={e =>
            menu.open(below(e), [
              { id: "invite", label: "Invite to Voice", onSelect: () => openModal({ type: "invite", channelId: channel.id }) },
              { type: "separator" },
              { id: "chat", label: chatOpen ? "Hide Chat" : "Show Chat", onSelect: () => useVoiceUi.getState().setChatOpen(!chatOpen) },
              { id: "settings", label: "Edit Channel", onSelect: () => openModal({ type: "editChannel", channelId: channel.id }) },
              { type: "separator" },
              { id: "voice-settings", label: "Voice & Video Settings", onSelect: () => openModal({ type: "userSettings", section: "voice" }) },
            ])
          }
        >
          <Ellipsis size={20} />
        </BarButton>
      </div>
      <Tooltip content="Disconnect" side="top">
        <button type="button" className="voice-hangup" aria-label="Leave voice channel" onClick={leaveVoice}>
          <PhoneOff size={22} />
        </button>
      </Tooltip>
      <div className="voice-bar-side">
        <BarButton label="Pop out" tooltip="Pop out (coming with the desktop app)" disabled>
          <SquareArrowOutUpRight size={20} />
        </BarButton>
        <BarButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
        </BarButton>
      </div>
      <SoundboardPopout anchor={boardAnchor} open={boardOpen} onClose={() => setBoardOpen(false)} />
    </div>
  );
}

function AloneCard({ channel }: { channel: Channel }) {
  const { can } = usePermissions(channel.guild_id, channel.id);
  return (
    <div className="voice-alone">
      <div className="voice-alone-art" aria-hidden="true">
        <Volume2 size={56} />
        <Users size={40} />
        <Video size={40} />
      </div>
      <p className="voice-alone-text">It's quiet in here. Invite someone to jump in.</p>
      <div className="voice-alone-actions">
        <button type="button" className="voice-alone-button" disabled={!can(Perm.CREATE_INSTANT_INVITE)} onClick={() => openModal({ type: "invite", channelId: channel.id })}>
          <UserPlus size={18} /> Invite to Voice
        </button>
        <Tooltip content="Activities aren't available yet" side="top">
          <button type="button" className="voice-alone-button" aria-disabled="true">
            <LayoutGrid size={18} /> Choose Activity
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function VoiceChannelPage({ channel }: { channel: Channel }) {
  const page = useRef<HTMLElement>(null);
  const states = useChannelVoiceStates(channel.id);
  const connected = useVoice(s => s.channelId === channel.id);
  const elsewhere = useVoice(s => s.channelId !== null && s.channelId !== channel.id);
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const hasPeers = states.length > 1;
  const empty = !connected && states.length === 0;

  return (
    <section ref={page} className={`voice-page${empty ? " empty" : ""}`} aria-label={`${channel.name ?? "Voice"} call`}>
      {empty ? (
        <div className="voice-stage">
          <div className="voice-empty-state">
            <h2 className="voice-empty-title">{channel.name ?? "Voice"}</h2>
            <p className="voice-empty-sub">No one is currently in the voice channel</p>
            <button type="button" className="voice-empty-join" onClick={() => joinVoiceChannel(channel)}>
              {elsewhere ? "Move Here" : "Join Voice Channel"}
            </button>
          </div>
        </div>
      ) : (
        <div className="voice-stage">
          <div className={`voice-tiles${states.length === 1 ? " single" : ""}`}>
            {states.map(state => (
              <Tile key={state.user_id} state={state} guildId={channel.guild_id} solo={states.length === 1} />
            ))}
          </div>
          {connected && !hasPeers && <AloneCard channel={channel} />}
          {connected ? (
            <ControlBar channel={channel} page={page} />
          ) : (
            <div className="voice-join">
              <button type="button" className="btn btn-primary voice-join-button" onClick={() => joinVoiceChannel(channel)}>
                <Volume2 size={18} /> {elsewhere ? "Move Here" : "Join Voice"}
              </button>
            </div>
          )}
        </div>
      )}
      {chatOpen && <VoiceChatPanel channel={channel} />}
    </section>
  );
}
