// Phone: a slim bar above the content while you are in a call and not looking at it (Discord's in-call pill). The full
// controls live in the drawer's user panel, a page away; this keeps mute, deafen, leave and the way back in reach.

import { useNavigate } from "react-router";
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { usePhone } from "../ui";
import { leaveVoice, toggleSelfDeaf, toggleSelfMute } from "./engine";
import { QualityIcon, STATUS_LABEL } from "./VoiceConnectionPanel";
import { useVoice } from "./store";

/** `routeChannelId`: the channel on screen. `listOpen`: the phone's channel list page covers it (it carries the full panel). */
export function PhoneCallBar({ routeChannelId, listOpen }: { routeChannelId: string | null | undefined; listOpen: boolean }) {
  const phone = usePhone();
  const channelId = useVoice(s => s.channelId);
  const status = useVoice(s => s.status);
  const quality = useVoice(s => s.quality);
  const muted = useVoice(s => s.selfMute);
  const deafened = useVoice(s => s.selfDeaf);
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  const guild = useStore(s => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const navigate = useNavigate();
  if (!phone || !channelId || !channel || listOpen || routeChannelId === channelId) return null;
  const name = channel.guild_id ? (channel.name ?? "Voice") : dmName(channel);
  return (
    <section className="phone-call-bar" aria-label="Current call">
      <button type="button" className="phone-call-bar-main" aria-label={`Return to ${name} call`} onClick={() => void navigate(`/channels/${channel.guild_id ?? "@me"}/${channel.id}`)}>
        <QualityIcon quality={status === "connected" ? quality : "unknown"} size={18} />
        <span className="phone-call-bar-text">
          <span className="phone-call-bar-status">{STATUS_LABEL[status]}</span>
          <span className="phone-call-bar-where">{guild ? `${name} / ${guild.name}` : name}</span>
        </span>
      </button>
      <button type="button" className={`phone-call-bar-button${muted ? " active" : ""}`} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted} onClick={toggleSelfMute}>
        {muted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>
      <button type="button" className={`phone-call-bar-button${deafened ? " active" : ""}`} aria-label={deafened ? "Undeafen" : "Deafen"} aria-pressed={deafened} onClick={toggleSelfDeaf}>
        {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
      </button>
      <button type="button" className="phone-call-bar-button danger" aria-label="Disconnect" onClick={leaveVoice}>
        <PhoneOff size={20} />
      </button>
    </section>
  );
}
