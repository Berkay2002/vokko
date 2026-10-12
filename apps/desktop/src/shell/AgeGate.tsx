import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useStore } from "../api/store";
import { NsfwLevel, type Channel, type Guild } from "../api/types";

const confirmed = new Set<string>();
const listeners = new Set<() => void>();
const seen = (key: string): boolean => confirmed.has(key) || localStorage.getItem(key) === "1";
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Which confirmation applies to a channel: the whole server, or the channel (a thread inherits its parent's nsfw flag). */
function gateOf(channel: Channel | undefined, guild: Guild | undefined, parent: Channel | undefined) {
  const guildWide = guild?.nsfw_level === NsfwLevel.AgeRestricted;
  const applies = !!channel?.guild_id && (guildWide || !!channel.nsfw || !!parent?.nsfw);
  const key = guildWide ? `vokko.ageGate.guild.${channel?.guild_id}` : `vokko.ageGate.channel.${parent?.nsfw ? parent.id : channel?.id}`;
  return { guildWide, applies, key };
}

/** True while the channel is age-restricted and the user has not pressed Continue yet; reactive to Continue. */
export function useAgeGated(channel: Channel | undefined): boolean {
  const guild = useStore(s => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const parent = useStore(s => (channel?.parent_id ? s.channels[channel.parent_id] : undefined));
  const { applies, key } = gateOf(channel, guild, parent);
  return useSyncExternalStore(subscribe, () => applies && !seen(key));
}

/** Age-restricted channel / server gate shown in place of the channel content until the user confirms (remembered per channel or guild). */
export function AgeGate({ channel, children }: { channel: Channel; children: ReactNode }) {
  const guild = useStore(s => (channel.guild_id ? s.guilds[channel.guild_id] : undefined));
  const parent = useStore(s => (channel.parent_id ? s.channels[channel.parent_id] : undefined));
  const { guildWide, key } = gateOf(channel, guild, parent);
  const navigate = useNavigate();
  const button = useRef<HTMLButtonElement>(null);
  const gated = useAgeGated(channel);
  useEffect(() => {
    if (gated) button.current?.focus();
  }, [gated, key]);
  if (!gated) return <>{children}</>;
  const kind = guildWide ? "Server" : "Channel";
  return (
    <section className="main-empty age-gate" aria-labelledby="age-gate-title">
      <h2 id="age-gate-title">Age-Restricted {kind}</h2>
      <p>This {kind.toLowerCase()} may contain content that is not suitable for users under 18.</p>
      <div className="age-gate-actions">
        <button type="button" className="btn" onClick={() => void navigate("/channels/@me")}>Nevermind</button>
        <button
          ref={button}
          type="button"
          className="btn"
          onClick={() => {
            localStorage.setItem(key, "1");
            confirmed.add(key);
            listeners.forEach(fn => fn());
          }}
        >
          Continue
        </button>
      </div>
    </section>
  );
}
