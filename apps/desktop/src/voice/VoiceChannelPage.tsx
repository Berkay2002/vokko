// The page a voice channel opens in the main area: participant tiles, the alone/empty state, the control bar and the
// text-in-voice side panel. With peers the stage is a grid that maximises 16:9 tiles; clicking a tile focuses it (one big
// tile over a strip of the others, which can be hidden). Camera, screen share and activities open their UI shells.
// Like Discord, a participant who is streaming has two tiles: their user tile (camera or avatar) and a stream tile (the screen).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, Ellipsis, LayoutGrid, Maximize2, Mic, MicOff, Minimize2, Monitor, MonitorUp, Music, PhoneOff, SquareArrowOutUpRight, UserPlus, Users, Video, VideoOff, Volume2, HeadphoneOff, X } from "lucide-react";
import { Perm } from "../api/permissions";
import { displayName, useStore } from "../api/store";
import type { Channel, Snowflake, VoiceState } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { userContextItems } from "../shell/menus";
import { openModal } from "../shell/modalStore";
import { usePermissions } from "../shell/usePermissions";
import { hasOpenLayer, Tooltip, useContextMenu, usePrefs } from "../ui";
import { useDeviceMenus } from "./deviceMenus";
import { GRID_GAP, gridLayout } from "./gridLayout";
import { dismissVideoError, joinVoiceChannel, leaveVoice, setViewerQuality, toggleSelfMute, watchStream } from "./engine";
import { useMedia, useStreamingCheck, useVideo, type VideoHandle, type VideoSource } from "./mediaStore";
import { SoundboardPopout } from "./SoundboardPopout";
import { SoundEffectBadge, useSoundFlashClass } from "../soundboard";
import { useChannelVoiceStates, useIsSpeaking, useVoice } from "./store";
import { useVoiceUi } from "./uiStore";
import { VoiceChatPanel } from "./VoiceChatPanel";
import { openCameraOptions, toggleCamera, toggleScreenShare } from "./videoControls";
import { VIEWER_QUALITIES, VIEWER_QUALITY_LABEL, type ViewerQuality } from "./video/options";
import "./video/video.css";

/** Stable tile colour for people without a profile colour. */
function tileColor(userId: Snowflake, bannerColor: string | null | undefined): string {
  if (bannerColor && /^#[0-9a-f]{6}$/i.test(bannerColor)) return bannerColor;
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 28% 38%)`;
}

/** A <video> fed by a LiveKit track (or the fake transport's picture); the element belongs to React, the handle only attaches. */
function TileVideo({ handle, source, mirror }: { handle: VideoHandle; source: VideoSource; mirror: boolean }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={element} className={`voice-tile-video ${source}${mirror ? " mirror" : ""}`} autoPlay muted playsInline data-source={source} />;
}

/** solo: alone in the call. grid / strip / pip: focusable. focused: the big tile of focus mode (click returns to the grid). */
export type TileVariant = "solo" | "grid" | "focused" | "strip" | "pip";

const AVATAR_SIZE: Record<TileVariant, number> = { solo: 100, focused: 100, grid: 80, strip: 48, pip: 48 };

/** One tile of the stage: a participant's user tile, or (while they stream) their stream tile. */
export interface StageTile {
  /** `userId` for a user tile, `userId:stream` for a stream tile; what `useVoiceUi.focusedTile` holds. */
  id: string;
  state: VoiceState;
  stream: boolean;
}

export const stageTileId = (userId: Snowflake, stream: boolean): string => (stream ? `${userId}:stream` : userId);

/** The tiles for `states`, in order: each user tile preceded by their stream tile when `streaming` says they stream. */
export function stageTiles(states: VoiceState[], streaming: (state: VoiceState) => boolean): StageTile[] {
  return states.flatMap(state => {
    const user = { id: stageTileId(state.user_id, false), state, stream: false };
    return streaming(state) ? [{ id: stageTileId(state.user_id, true), state, stream: true }, user] : [user];
  });
}

export function useStageTiles(states: VoiceState[]): StageTile[] {
  return stageTiles(states, useStreamingCheck());
}

/**
 * A user tile (`stream` false): camera video or avatar, name, mute / deaf and the speaking ring. A stream tile (`stream` true,
 * only while the participant streams): their screen, the LIVE badge, Watch Stream and the stream tools.
 */
export function Tile({ state, guildId, variant, stream = false, onActivate }: { state: VoiceState; guildId: Snowflake | null; variant: TileVariant; stream?: boolean; onActivate?: () => void }) {
  const user = useStore(s => s.users[state.user_id]) ?? state.member?.user;
  const activity = useStore(s => s.presences[state.user_id]?.activities?.[0]?.name);
  const member = useStore(s => (guildId ? s.members[guildId]?.[state.user_id] : undefined)) ?? state.member;
  const speaking = useIsSpeaking(state.user_id);
  const flash = useSoundFlashClass(state.user_id);
  const own = useVoice(s => s.meId === state.user_id);
  // Our own stream's quality, as chosen in Go Live (it is saved as the new default). Others' streams don't carry theirs.
  const ownSpec = usePrefs(s => `${s.streamResolution.toUpperCase()} ${s.streamFps}FPS`);
  const menu = useContextMenu();
  const tile = useRef<HTMLDivElement>(null);
  const camera = useVideo(state.user_id, "camera");
  const screen = useVideo(state.user_id, "screen");
  const watching = useMedia(s => !!s.watching[state.user_id]);
  const quality = useMedia(s => s.quality[`${state.user_id}:screen`]);
  if (!user) return null;
  const name = displayName(user, member);
  const muted = state.mute || state.self_mute || state.suppress;
  const deaf = state.deaf || state.self_deaf;
  const small = variant === "strip" || variant === "pip";
  const focused = variant === "focused";
  const speakingText = !stream && speaking ? ", speaking" : "";
  const label = stream ? `${name}'s stream` : name;
  const interactive = !!onActivate;
  return (
    <div
      ref={tile}
      className={`voice-tile ${variant}${stream ? " stream" : ""}${!stream && speaking ? " speaking" : ""}${own ? " own" : ""}${stream ? "" : flash}`}
      data-user-id={state.user_id}
      data-stream={stream || undefined}
      data-speaking={(!stream && speaking) || undefined}
      role={interactive ? "button" : "group"}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? focused : undefined}
      aria-label={interactive ? (focused ? `Return to grid (${label}${speakingText})` : `Focus ${label}${speakingText}`) : `${label}${speakingText}`}
      // A stream tile is black behind the picture; before it is watched (no picture) a surface colour keeps it visible on the stage.
      style={{ background: stream ? (screen ? "#000" : "var(--background-surface-high)") : tileColor(user.id, user.banner_color) } as CSSProperties}
      onClick={onActivate}
      onKeyDown={e => {
        if (!onActivate || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onActivate();
      }}
      onContextMenu={e => menu.open(e, userContextItems(user, { guildId, anchor: tile.current }))}
    >
      {stream && screen ? (
        <TileVideo key="screen" handle={screen} source="screen" mirror={false} />
      ) : !stream && camera ? (
        <TileVideo key="camera" handle={camera} source="camera" mirror={own} />
      ) : (
        <Avatar user={user} member={member} size={AVATAR_SIZE[variant]} decoration={false} className="voice-tile-avatar" />
      )}
      {!stream && <SoundEffectBadge userId={state.user_id} />}
      {stream && (
        <div className="voice-tile-badges">
          {own && !small && <span className="voice-tile-spec">{ownSpec}</span>}
          <span className="voice-tile-live">LIVE</span>
        </div>
      )}
      {stream && !own && !watching && !small && (
        <button type="button" className="voice-tile-watch" 
          onClick={e => {
            // Watching from the grid also focuses the stream; on the focused tile it must not return to the grid.
            e.stopPropagation();
            watchStream(state.user_id, true);
            if (!focused) onActivate?.();
          }}
        >
          <Monitor size={28} aria-hidden="true" />
          Watch Stream
        </button>
      )}
      {stream && !own && watching && !small && (
        <div className="voice-tile-tools">
          <button
            type="button"
            className="voice-tile-tool"
            aria-label="Stream quality"
            onClick={e => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, [
                ...VIEWER_QUALITIES.map((q: ViewerQuality) => ({ id: `quality-${q}`, label: VIEWER_QUALITY_LABEL[q], checked: (quality ?? "auto") === q, onSelect: () => setViewerQuality(state.user_id, "screen", q) })),
                { type: "separator" as const },
                { id: "stop-watching", label: "Stop Watching", onSelect: () => watchStream(state.user_id, false) },
              ]);
            }}
          >
            {VIEWER_QUALITY_LABEL[quality ?? "auto"]} <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="voice-tile-labels">
        <span className="voice-tile-name">
          {stream && <Monitor size={14} aria-label="Streaming" role="img" />}
          <span className="voice-tile-name-text">{name}</span>
          {!stream && muted && <MicOff size={14} aria-label="Muted" role="img" />}
          {!stream && deaf && <HeadphoneOff size={14} aria-label="Deafened" role="img" />}
        </span>
        {!stream && activity && !small && <span className="voice-tile-activity">{activity}</span>}
      </div>
    </div>
  );
}

export function BarButton({ label, tooltip, active, danger, disabled, onClick, buttonRef, children }: { label: string; tooltip?: string; active?: boolean; danger?: boolean; disabled?: boolean; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; buttonRef?: (el: HTMLButtonElement | null) => void; children: React.ReactNode }) {
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
  const cameraOn = useMedia(s => s.cameraOn);
  const screenOn = useMedia(s => s.screenOn);
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
        <BarButton label={cameraOn ? "Turn off camera" : "Turn on camera"} tooltip={cameraOn ? "Turn Off Camera" : "Turn On Camera"} active={cameraOn} onClick={toggleCamera}>
          {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
        </BarButton>
        <BarButton label="Camera options" tooltip="Camera Options" onClick={openCameraOptions}>
          <ChevronDown size={16} />
        </BarButton>
      </div>
      <div className="voice-bar-group">
        <BarButton label={screenOn ? "Stop streaming" : "Share your screen"} tooltip={screenOn ? "Stop Streaming" : "Share Your Screen"} active={screenOn} onClick={toggleScreenShare}>
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

function VideoError() {
  const error = useMedia(s => s.error);
  if (!error) return null;
  return (
    <div className="voice-video-error" role="alert">
      <span>{error}</span>
      <button type="button" className="voice-video-error-close" aria-label="Dismiss" onClick={dismissVideoError}>
        <X size={14} aria-hidden="true" />
      </button>
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

/** Content-box size of an element, kept current with a ResizeObserver. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize(prev => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Grid view: the column count that gives the largest 16:9 tiles, last row centred. */
function TileGrid({ tiles, guildId, onFocus }: { tiles: StageTile[]; guildId: Snowflake | null; onFocus: (tileId: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const { width, height } = useBoxSize(box);
  const layout = gridLayout(tiles.length, width, height, GRID_GAP);
  const style = layout.tileWidth > 0 ? ({ "--voice-tile-w": `${layout.tileWidth}px`, width: `${layout.cols * layout.tileWidth + (layout.cols - 1) * GRID_GAP}px` } as CSSProperties) : undefined;
  return (
    <div ref={box} className="voice-tiles grid">
      <div className="voice-grid" style={style} data-cols={layout.cols || undefined}>
        {tiles.map(t => (
          <Tile key={t.id} state={t.state} guildId={guildId} variant="grid" stream={t.stream} onActivate={() => onFocus(t.id)} />
        ))}
      </div>
    </div>
  );
}

function MembersToggle({ hidden }: { hidden: boolean }) {
  const label = hidden ? "Show Members" : "Hide Members";
  return (
    <div className={`voice-members-toggle${hidden ? " members-hidden" : ""}`}>
      <Tooltip content={label} side="top">
        <button type="button" className="voice-members-pill" aria-label={label} onClick={() => useVoiceUi.getState().setMembersHidden(!hidden)}>
          {hidden ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          <Users size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

/** Focus view: the focused tile fills the stage over a strip of the others (hideable); a hidden live stream shows as a PiP. */
function FocusView({ tiles, focused, guildId }: { tiles: StageTile[]; focused: StageTile; guildId: Snowflake | null }) {
  const hidden = useVoiceUi(s => s.membersHidden);
  const setFocusedTile = useVoiceUi(s => s.setFocusedTile);
  const others = tiles.filter(t => t.id !== focused.id);
  const pip = hidden ? others.find(t => t.stream) : undefined;
  return (
    <div className={`voice-focus${hidden ? " members-hidden" : ""}`}>
      <div className="voice-focus-main">
        <div className="voice-focus-frame">
          <Tile key={focused.id} state={focused.state} guildId={guildId} variant="focused" stream={focused.stream} onActivate={() => setFocusedTile(null)} />
          {hidden && <MembersToggle hidden />}
        </div>
        {pip && (
          <div className="voice-pip">
            <Tile key={pip.id} state={pip.state} guildId={guildId} variant="pip" stream onActivate={() => setFocusedTile(pip.id)} />
          </div>
        )}
      </div>
      {!hidden && (
        <div className="voice-strip-wrap">
          <MembersToggle hidden={false} />
          <div className="voice-strip" role="group" aria-label="Members">
            {others.map(t => (
              <Tile key={t.id} state={t.state} guildId={guildId} variant="strip" stream={t.stream} onActivate={() => setFocusedTile(t.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

export function VoiceChannelPage({ channel }: { channel: Channel }) {
  const page = useRef<HTMLElement>(null);
  const states = useChannelVoiceStates(channel.id);
  const connected = useVoice(s => s.channelId === channel.id);
  const elsewhere = useVoice(s => s.channelId !== null && s.channelId !== channel.id);
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const tiles = useStageTiles(states);
  // Count tiles, not people: someone alone in the call who streams still has two (their camera and their screen).
  const multiple = tiles.length > 1;
  const empty = !connected && states.length === 0;
  const focusedId = useVoiceUi(s => s.focusedTile);
  const focused = multiple && focusedId ? tiles.find(t => t.id === focusedId) : undefined;

  // One-shot request from outside the stage ("Watch Stream" in the channel list): focus that stream's tile once it is on this call's stage.
  const focusStream = useVoiceUi(s => s.focusStream);
  const requested = connected && focusStream ? tiles.find(t => t.stream && t.state.user_id === focusStream) : undefined;
  useEffect(() => {
    if (!requested) return;
    const ui = useVoiceUi.getState();
    ui.setFocusedTile(requested.id);
    ui.requestStreamFocus(null);
  }, [requested?.id]);

  // The focused tile is gone (the participant left or stopped streaming, or the call shrank to one tile): back to the grid.
  useEffect(() => {
    if (focusedId && !focused) useVoiceUi.getState().setFocusedTile(null);
  }, [focusedId, focused]);

  // Escape leaves focus mode. Capture phase, so it runs before the shell's Escape (mark as read), which skips prevented events.
  const inFocus = !!focused;
  useEffect(() => {
    if (!inFocus) return;
    const onKey = (e: KeyboardEvent) => {
      // Plain Escape only (Shift+Escape marks the server read), and never while a popout, menu or modal owns Escape.
      if (e.key !== "Escape" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || isEditable(e.target) || hasOpenLayer() || document.querySelector('[role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      useVoiceUi.getState().setFocusedTile(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inFocus]);

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
          {focused ? (
            <FocusView tiles={tiles} focused={focused} guildId={channel.guild_id} />
          ) : multiple ? (
            <TileGrid tiles={tiles} guildId={channel.guild_id} onFocus={id => useVoiceUi.getState().setFocusedTile(id)} />
          ) : (
            <div className="voice-tiles single">
              {tiles.map(t => (
                <Tile key={t.id} state={t.state} guildId={channel.guild_id} variant="solo" stream={t.stream} />
              ))}
            </div>
          )}
          {connected && <VideoError />}
          {connected && !multiple && <AloneCard channel={channel} />}
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
