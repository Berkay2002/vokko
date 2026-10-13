// DM call UI: header buttons, the call panel above the DM chat, the incoming-call overlay and the DM list / rail marker.
// Tiles and bar buttons are the voice channel page's (src/voice); everything here only arranges them for a DM.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { BellRing, Headphones, HeadphoneOff, Mic, MicOff, MonitorPlay, MonitorUp, Phone, PhoneOff, Users, Video, VideoOff, X } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { ChannelType, type Channel, type Snowflake, type User } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { Tooltip } from "../ui";
import { useChannelVoiceStates, useVoice } from "../voice/store";
import { BarButton, Tile, useStageTiles } from "../voice/VoiceChannelPage";
import { openModal } from "../shell/modalStore";
import { WatchTile } from "../watch";
import { toggleSelfDeaf, toggleSelfMute } from "../voice/engine";
import { useMedia } from "../voice/mediaStore";
import { toggleCamera, toggleScreenShare } from "../voice/videoControls";
import { acceptCall, declineCall, hangUp, ringCall, startCall } from "./engine";
import { callStore, incomingCalls, outgoingRinging, useCalls } from "./store";

const NO_IDS: Snowflake[] = [];

function useUsers(ids: Snowflake[], channel: Channel | undefined): User[] {
  const users = useStore(s => s.users);
  return useMemo(
    () => ids.map(id => users[id] ?? channel?.recipients?.find(r => r.id === id)).filter((u): u is User => !!u),
    [ids, users, channel],
  );
}

function HeaderButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip content={label} side="bottom">
      <button type="button" className={`toolbar-button${active ? " active" : ""}`} aria-label={label} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

/** DM header: start (or join) a voice / video call. */
export function CallButtons({ channel }: { channel: Channel }) {
  const ongoing = useCalls(s => !!s.calls[channel.id]);
  const here = useVoice(s => s.channelId === channel.id);
  return (
    <>
      <HeaderButton label={here ? "In Voice Call" : ongoing ? "Join Voice Call" : "Start Voice Call"} active={here} onClick={() => !here && startCall(channel)}>
        <Phone size={24} />
      </HeaderButton>
      <HeaderButton label={ongoing && !here ? "Join Video Call" : "Start Video Call"} onClick={() => startCall(channel, true)}>
        <Video size={24} />
      </HeaderButton>
    </>
  );
}

function RingingTile({ user, outgoing, channelId }: { user: User; outgoing: boolean; channelId: Snowflake }) {
  return (
    <div className="dm-call-ringing" data-user-id={user.id} role="group" aria-label={`${user.global_name ?? user.username}, ${outgoing ? "ringing" : "not in the call"}`}>
      <Avatar user={user} size={80} decoration={false} className={outgoing ? "dm-call-ringing-avatar pulse" : "dm-call-ringing-avatar"} />
      {!outgoing && (
        <Tooltip content="Ring" side="top">
          <button type="button" className="dm-call-ring" aria-label={`Ring ${user.global_name ?? user.username}`} onClick={() => void ringCall(channelId, [user.id])}>
            <BellRing size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** The call area at the top of a DM: who is in it, who is being rung, and the call bar. Nothing when there is no call. */
export function CallPanel({ channel }: { channel: Channel }) {
  const call = useCalls(s => s.calls[channel.id]);
  const meId = useCalls(s => s.meId);
  const ringingIds = useCalls(useShallow(s => (s.calls[channel.id] ? outgoingRinging(s, channel.id) : NO_IDS)));
  const states = useChannelVoiceStates(channel.id);
  const here = useVoice(s => s.channelId === channel.id);
  const status = useVoice(s => (s.channelId === channel.id ? s.status : null));
  const muted = useVoice(s => s.selfMute);
  const deafened = useVoice(s => s.selfDeaf);
  const cameraOn = useMedia(s => s.cameraOn);
  const screenOn = useMedia(s => s.screenOn);
  const watching = useVoice(s => !!s.watch[channel.id]);
  const tiles = useStageTiles(states, channel.id);
  const inside = useMemo(() => new Set(states.map(s => s.user_id)), [states]);
  const ringing = useUsers(ringingIds, channel);
  const absentIds = useMemo(
    () => (channel.recipients ?? []).map(r => r.id).filter(id => id !== meId && !inside.has(id) && !ringingIds.includes(id)),
    [channel.recipients, meId, inside, ringingIds],
  );
  const absent = useUsers(absentIds, channel);
  if (!call && !here) return null;
  const connecting = here && status !== "connected";
  return (
    <section className="dm-call" aria-label="Call">
      <div className="dm-call-stage">
        {tiles.map(t => (
          <div key={t.id} className={`dm-call-tile${t.watch ? " watch" : ""}`}>
            {t.watch ? <WatchTile channelId={channel.id} variant="focused" /> : <Tile state={t.state} guildId={null} variant="grid" stream={t.stream} />}
          </div>
        ))}
        {here && ringing.map(user => <RingingTile key={user.id} user={user} outgoing channelId={channel.id} />)}
        {here && channel.type === ChannelType.DM && absent.map(user => <RingingTile key={user.id} user={user} outgoing={false} channelId={channel.id} />)}
      </div>
      <p className="dm-call-status" role="status" aria-live="polite">
        {connecting ? "Connecting…" : here && ringing.length > 0 && states.length <= 1 ? "Ringing…" : here ? "" : `${states.length} in the call`}
      </p>
      <div className="dm-call-bar">
        {here ? (
          <>
            <BarButton label={muted ? "Unmute" : "Mute"} active={muted} onClick={toggleSelfMute}>
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </BarButton>
            <BarButton label={deafened ? "Undeafen" : "Deafen"} active={deafened} onClick={toggleSelfDeaf}>
              {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
            </BarButton>
            <BarButton label={cameraOn ? "Turn off camera" : "Turn on camera"} tooltip={cameraOn ? "Turn Off Camera" : "Turn On Camera"} active={cameraOn} onClick={toggleCamera}>
              {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
            </BarButton>
            <BarButton label={screenOn ? "Stop streaming" : "Share your screen"} tooltip={screenOn ? "Stop Streaming" : "Share Your Screen"} active={screenOn} onClick={toggleScreenShare}>
              <MonitorUp size={20} />
            </BarButton>
            <BarButton label="Watch Together" tooltip="Watch YouTube Together" active={watching} onClick={() => (watching ? undefined : openModal({ type: "watchTogether", channelId: channel.id }))}>
              <MonitorPlay size={20} />
            </BarButton>
            {channel.type === ChannelType.GroupDM && (
              <BarButton label="Ring Everyone" onClick={() => void ringCall(channel.id)}>
                <BellRing size={20} />
              </BarButton>
            )}
            <Tooltip content="Leave Call" side="top">
              <button type="button" className="dm-call-hangup" aria-label="Leave Call" onClick={hangUp}>
                <PhoneOff size={20} />
              </button>
            </Tooltip>
          </>
        ) : (
          <button type="button" className="dm-call-join" onClick={() => startCall(channel)}>
            <Phone size={18} /> Join Call
          </button>
        )}
      </div>
    </section>
  );
}

function IncomingCard({ channelId }: { channelId: Snowflake }) {
  const channel = useStore(s => s.channels[channelId]);
  if (!channel) return null;
  const name = dmName(channel);
  const first = channel.type === ChannelType.DM ? channel.recipients?.[0] : undefined;
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`Incoming call from ${name}`}>
      <button type="button" className="incoming-call-close" aria-label="Close" onClick={() => callStore.getState().dispatch({ type: "dismiss", channelId })}>
        <X size={16} />
      </button>
      <div className="incoming-call-avatar pulse">{first ? <Avatar user={first} size={80} decoration={false} /> : <Users size={40} aria-hidden="true" />}</div>
      <div className="incoming-call-name">{name}</div>
      <div className="incoming-call-sub">Incoming Call…</div>
      <div className="incoming-call-actions">
        <Tooltip content="Decline" side="bottom">
          <button type="button" className="incoming-call-button decline" aria-label="Decline" onClick={() => void declineCall(channelId)}>
            <PhoneOff size={20} />
          </button>
        </Tooltip>
        <Tooltip content="Accept with Video" side="bottom">
          <button type="button" className="incoming-call-button video" aria-label="Accept with Video" onClick={() => acceptCall(channelId, true)}>
            <Video size={20} />
          </button>
        </Tooltip>
        <Tooltip content="Accept" side="bottom">
          <button type="button" className="incoming-call-button accept" aria-label="Accept" onClick={() => acceptCall(channelId)}>
            <Phone size={20} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Incoming calls ringing us, stacked in the corner. */
export function IncomingCalls() {
  const inVoice = useVoice(s => s.channelId);
  const key = useCalls(s => incomingCalls(s, inVoice).map(call => call.channelId).join(","));
  if (!key) return null;
  return (
    <div className="incoming-calls">
      {key.split(",").map(id => (
        <IncomingCard key={id} channelId={id} />
      ))}
    </div>
  );
}

/** In-call marker for a DM row / rail avatar. */
export function CallBadge({ channelId }: { channelId: Snowflake }) {
  const ongoing = useCalls(s => !!s.calls[channelId]);
  const here = useVoice(s => s.channelId === channelId);
  if (!ongoing && !here) return null;
  return (
    <span className={`dm-call-badge${here ? " here" : ""}`} role="img" aria-label={here ? "In this call" : "Call in progress"}>
      <Phone size={12} strokeWidth={2.5} />
    </span>
  );
}
