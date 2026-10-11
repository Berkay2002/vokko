import { Volume2 } from "lucide-react";
import { useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { go, guildPath } from "../shell/nav";
import { useVoice } from "./store";

/** "In voice channel" card of profile popouts: where the person is, the channel status and a button to open the call. */
export function InVoiceCard({ userId, onOpen }: { userId: Snowflake; onOpen?: () => void }) {
  const state = useVoice(s => s.states[userId]);
  const channel = useStore(s => (state?.channel_id ? s.channels[state.channel_id] : undefined));
  const guild = useStore(s => (state?.guild_id ? s.guilds[state.guild_id] : undefined));
  const status = useVoice(s => (state?.channel_id ? s.channelStatus[state.channel_id] : undefined));
  if (!state?.channel_id || !channel) return null;
  return (
    <section className="in-voice-card" aria-label="In voice channel">
      <h3 className="in-voice-heading">In voice channel</h3>
      <div className="in-voice-body">
        <span className="in-voice-icon" aria-hidden="true">
          <Volume2 size={20} />
        </span>
        <div className="in-voice-text">
          <span className="in-voice-channel">{channel.name}</span>
          {guild && <span className="in-voice-guild">in {guild.name}</span>}
          {status && <span className="in-voice-status">{status}</span>}
        </div>
        {channel.guild_id && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              onOpen?.();
              go(guildPath(channel.guild_id as string, channel.id));
            }}
          >
            Open Voice
          </button>
        )}
      </div>
    </section>
  );
}
