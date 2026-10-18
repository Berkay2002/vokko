// DM call UI: header buttons, the call panel above the DM chat, the incoming-call overlay and the DM list / rail marker.
// The call panel itself is CallPanel.tsx, loaded with the voice channel page whose tiles and bar buttons it arranges for a DM.

import { Phone, PhoneOff, Users, Video, X } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { ChannelType, type Channel, type Snowflake } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { Tooltip } from "../ui";
import { lazyModule } from "../ui/lazyModule";
import { useVoice } from "../voice/store";
import { acceptCall, declineCall, startCall } from "./engine";
import { callStore, incomingCalls, useCalls } from "./store";

const panel = lazyModule(() => import("./CallPanel"));

/** The call area at the top of a DM (CallPanel.tsx). Nothing when there is no call; the bare panel while its chunk loads. */
export function CallPanel({ channel }: { channel: Channel }) {
  const ongoing = useCalls(s => !!s.calls[channel.id]);
  const here = useVoice(s => s.channelId === channel.id);
  const Panel = panel.use()?.CallPanel;
  if (!ongoing && !here) return null;
  return Panel ? <Panel channel={channel} /> : <section className="dm-call" aria-label="Call" aria-busy="true" />;
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
