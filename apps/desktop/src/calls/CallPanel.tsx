// The call area above a DM chat: who is in the call, who is being rung, and the call bar. Split out of the startup bundle with the
// voice channel page whose tiles and bar buttons it uses (CallUi.tsx mounts it through lazyModule).

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { BellRing, Headphones, HeadphoneOff, LayoutGrid, Mic, MicOff, MonitorPlay, MonitorUp, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useStore } from "../api/store";
import { ChannelType, type Channel, type Snowflake, type User } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { Tooltip, useContextMenu } from "../ui";
import { useChannelVoiceStates, useVoice } from "../voice/store";
import { BarButton, Tile, useStageTiles } from "../voice/VoiceChannelPage";
import { openModal } from "../shell/modalStore";
import { WatchTile } from "../watch";
import { GameTile, useGameMenuItems } from "../games";
import { openStremioPanel, StremioIcon, StremioPanel, StremioTile, useStremioPanel } from "../stremio";
import { openSpotifyPanel, SpotifyIcon, SpotifyPanel, SpotifyTile, useSpotifyPanel } from "../spotify";
import { toggleSelfDeaf, toggleSelfMute } from "../voice/engine";
import { useMedia } from "../voice/mediaStore";
import { canShareScreen, toggleCamera, toggleScreenShare } from "../voice/videoControls";
import { hangUp, ringCall, startCall } from "./engine";
import { outgoingRinging, useCalls } from "./store";

const NO_IDS: Snowflake[] = [];

function useUsers(ids: Snowflake[], channel: Channel | undefined): User[] {
  const users = useStore(s => s.users);
  return useMemo(
    () => ids.map(id => users[id] ?? channel?.recipients?.find(r => r.id === id)).filter((u): u is User => !!u),
    [ids, users, channel],
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
  const stremioOpen = useStremioPanel(s => s.open);
  const spotifyOpen = useSpotifyPanel(s => s.open);
  const gameItems = useGameMenuItems(channel);
  const menu = useContextMenu();
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
          <div key={t.id} className={`dm-call-tile${t.watch ? " watch" : ""}${t.stremio ? " stremio" : ""}${t.spotify ? " spotify" : ""}`}>
            {t.game ? (
              <GameTile channelId={channel.id} variant="focused" />
            ) : t.watch ? (
              <WatchTile channelId={channel.id} variant="focused" />
            ) : t.stremio ? (
              <StremioTile channelId={channel.id} variant="focused" />
            ) : t.spotify ? (
              <SpotifyTile channelId={channel.id} variant="focused" />
            ) : (
              <Tile state={t.state} guildId={null} variant="grid" stream={t.stream} />
            )}
          </div>
        ))}
        {here && ringing.map(user => <RingingTile key={user.id} user={user} outgoing channelId={channel.id} />)}
        {here && channel.type === ChannelType.DM && absent.map(user => <RingingTile key={user.id} user={user} outgoing={false} channelId={channel.id} />)}
      </div>
      {here && stremioOpen && <StremioPanel channelId={channel.id} />}
      {here && spotifyOpen && <SpotifyPanel channelId={channel.id} />}
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
            {(screenOn || canShareScreen()) && (
              <BarButton label={screenOn ? "Stop streaming" : "Share your screen"} tooltip={screenOn ? "Stop Streaming" : "Share Your Screen"} active={screenOn} onClick={toggleScreenShare}>
                <MonitorUp size={20} />
              </BarButton>
            )}
            <BarButton label="Watch Together" tooltip="Watch YouTube Together" active={watching} onClick={() => (watching ? undefined : openModal({ type: "watchTogether", channelId: channel.id }))}>
              <MonitorPlay size={20} />
            </BarButton>
            <BarButton
              label="Activities"
              active={stremioOpen || spotifyOpen}
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                menu.open({ clientX: rect.left, clientY: rect.top - 4 }, [
                  { id: "watch-together", label: "Watch Together (YouTube)", icon: <MonitorPlay size={18} />, iconStart: true, sub: "Watch a YouTube video in sync", onSelect: () => (watching ? undefined : openModal({ type: "watchTogether", channelId: channel.id })) },
                  { id: "stremio", label: "Stremio", icon: <StremioIcon size={18} />, iconStart: true, sub: "Play a movie or episode from your Stremio", onSelect: openStremioPanel },
                  { id: "spotify", label: "Spotify", icon: <SpotifyIcon size={18} />, iconStart: true, sub: "Play music for everyone in the call", onSelect: openSpotifyPanel },
                  { type: "separator" },
                  ...gameItems,
                ]);
              }}
            >
              <LayoutGrid size={20} />
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

