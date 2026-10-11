import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { Compass, Download, Plus, Users, Volume2 } from "lucide-react";
import { useVoice } from "../voice";
import { useCalls } from "../calls/store";
import logo from "../../assets/icon.svg";
import { avatarUrl, channelMentionCount, dmName, guildUnread, isChannelUnread, useStore } from "../api/store";
import { ChannelType, RelationshipType, type Channel, type Guild, type Snowflake } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { GuildIcon } from "./Avatar";
import { DownloadAppsModal } from "./DownloadApps";
import { firstTextChannel } from "./channels";
import { isMutedAt, useIsMuted, useLocalState } from "./localState";
import { effectiveLevel } from "../notify/decide";
import { unreadLabel } from "./DmSidebar";
import { guildContextItems } from "./menus";
import { guildPath } from "./nav";
import { openModal } from "./modalStore";
import { RailGuilds } from "../rail/RailGuilds";

function RailItem({ state, mentions, tooltip, muted, voice, children }: { state: "selected" | "unread" | "idle"; mentions?: number; tooltip: ReactNode; muted?: boolean; voice?: boolean; children: ReactNode }) {
  return (
    <div className={`rail-item${muted ? " muted" : ""}`} data-state={state}>
      <span className="rail-pill" />
      <Tooltip content={tooltip} side="right" className="tooltip-lg" gap={12}>
        {children}
      </Tooltip>
      {/* The count is in the link's name already. */}
      {!!mentions && mentions > 0 && <span className="rail-badge" aria-hidden="true">{mentions > 99 ? "99+" : mentions}</span>}
      {voice && (
        <span className="rail-voice-badge" aria-hidden="true">
          <Volume2 size={10} strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

function GuildRailItem({ guild }: { guild: Guild }) {
  const location = useLocation();
  const selected = location.pathname.startsWith(`/channels/${guild.id}`);
  const info = useStore(s => guildUnread(s, guild.id));
  // Select the link target, not the channel list: the list changes on every message in the guild.
  const target = useStore(s => {
    const last = s.lastChannelByGuild[guild.id];
    const channels = Object.values(s.channels).filter(c => c.guild_id === guild.id);
    return (last && channels.find(c => c.id === last)?.id) ?? firstTextChannel(channels)?.id;
  });
  const menu = useContextMenu();
  const muted = useIsMuted(guild.id);
  const state = selected ? "selected" : info.unread && !muted ? "unread" : "idle";
  // Our own voice state, so the badge also shows while the call runs on another device.
  const inCall = useVoice(s => s.guildId === guild.id || (s.meId !== null && s.states[s.meId]?.guild_id === guild.id));

  return (
    <RailItem state={state} mentions={info.mentions} tooltip={guild.name} muted={muted} voice={inCall}>
      <NavLink to={guildPath(guild.id, target)} className="rail-tile rail-guild" aria-label={[guild.name, muted ? null : unreadLabel(info.mentions, false), inCall ? "Voice call active" : null].filter(Boolean).join(", ")} onContextMenu={e => menu.open(e, guildContextItems(guild))}>
        <GuildIcon guild={guild} size={40} />
      </NavLink>
    </RailItem>
  );
}

/** An unread DM or group DM between Home and the separator: round avatar (group icon for group DMs), unread pill, mention badge. */
function DmRailItem({ channel, leaving, onGone }: { channel: Channel; leaving: boolean; onGone: (id: Snowflake) => void }) {
  const location = useLocation();
  const selected = location.pathname === `/channels/@me/${channel.id}`;
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const first = channel.recipients?.[0];
  const group = channel.type === ChannelType.GroupDM || !first;
  const label = dmName(channel);
  const inCall = useCalls(s => !!s.calls[channel.id]);
  const slot = useRef<HTMLDivElement>(null);
  // A leaving item turns inert; if it held focus (opened with the keyboard), focus follows the conversation to its DM list row.
  useLayoutEffect(() => {
    if (!leaving || !slot.current?.contains(document.activeElement)) return;
    (document.querySelector<HTMLElement>(`.dm-row[href$="/${channel.id}"]`) ?? document.querySelector<HTMLElement>(".server-rail .rail-home"))?.focus();
  }, [leaving, channel.id]);
  return (
    <div
      ref={slot}
      className={`rail-dm-slot${leaving ? " leaving" : ""}`}
      data-channel-id={channel.id}
      inert={leaving || undefined}
      onAnimationEnd={e => {
        if (leaving && e.target === e.currentTarget) onGone(channel.id);
      }}
    >
      <RailItem state={selected ? "selected" : "unread"} mentions={leaving ? 0 : mentions} tooltip={label} voice={inCall}>
        <NavLink to={`/channels/@me/${channel.id}`} className="rail-tile rail-dm" aria-label={[label, unreadLabel(mentions, true), inCall ? "Call active" : null].filter(Boolean).join(", ")}>
          {group ? (
            <span className="rail-dm-group">
              <Users size={20} />
            </span>
          ) : (
            <img src={avatarUrl(first)} alt="" width={40} height={40} draggable={false} />
          )}
        </NavLink>
      </RailItem>
    </div>
  );
}

/** Keeps DMs that were just read in place until their exit animation ends (they pop out of the rail like Discord's). */
function useLeavingDms(dms: Channel[]): { list: { channel: Channel; leaving: boolean }[]; gone: (id: Snowflake) => void } {
  const previous = useRef(dms);
  const [leaving, setLeaving] = useState<{ channel: Channel; index: number }[]>([]);
  const ids = dms.map(c => c.id).join(",");
  useEffect(() => {
    const current = new Set(dms.map(c => c.id));
    const removed = previous.current.flatMap((channel, index) => (current.has(channel.id) ? [] : [{ channel, index }]));
    previous.current = dms;
    setLeaving(list => [...list.filter(l => !current.has(l.channel.id) && !removed.some(r => r.channel.id === l.channel.id)), ...removed]);
    // Keyed on the id list: a fresh array with the same DMs is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const gone = useCallback((id: Snowflake) => setLeaving(rest => rest.filter(l => l.channel.id !== id)), []);
  const list = dms.map(channel => ({ channel, leaving: false }));
  // A DM that came back during its exit animation is already in `dms` (until the effect drops it from `leaving`): no second copy.
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) {
    if (!dms.some(c => c.id === l.channel.id)) list.splice(Math.min(l.index, list.length), 0, { channel: l.channel, leaving: true });
  }
  return { list, gone };
}

export function ServerRail() {
  const location = useLocation();
  // privateChannels is already newest first; every unread DM / group DM gets its own rail item.
  const unreadDms = useStore(s => s.privateChannels.map(id => s.channels[id]).filter((c): c is Channel => !!c && (c.type === ChannelType.DM || c.type === ChannelType.GroupDM) && isChannelUnread(s, c.id)));
  // Home's own badge counts incoming friend requests (DM mentions sit on the DMs' own items below it).
  const pending = useStore(s => Object.values(s.relationships).filter(r => r.type === RelationshipType.IncomingRequest).length);
  const home = location.pathname.startsWith("/channels/@me");
  const [downloadOpen, setDownloadOpen] = useState(false);
  // Muted DMs and DMs set to "Nothing" stay out of the rail, like the Dock / taskbar badge (notify/badge.ts).
  const local = useLocalState(s => s);
  const now = Date.now();
  // DMs with an ongoing call stay on the rail too, with the voice marker (calls are never muted away).
  const callIds = useCalls(useShallow(s => Object.keys(s.calls)));
  const callDms = useStore(useShallow(s => callIds.map(id => s.channels[id]).filter((c): c is Channel => !!c && (c.type === ChannelType.DM || c.type === ChannelType.GroupDM))));
  const dms = useLeavingDms([...callDms, ...unreadDms.filter(c => !callIds.includes(c.id) && !isMutedAt(local, c.id, now) && effectiveLevel(local, [c.id]) !== "none")]);

  return (
    <nav className="server-rail" aria-label="Servers sidebar">
      <RailItem state={home ? "selected" : "idle"} tooltip="Direct Messages" mentions={pending}>
        <NavLink to="/channels/@me" className={`rail-tile rail-home${home ? " selected" : ""}`} aria-label={pending > 0 ? `Direct Messages, ${pending} pending friend request${pending === 1 ? "" : "s"}` : "Direct Messages"}>
          <img src={logo} alt="" width={24} height={24} draggable={false} />
        </NavLink>
      </RailItem>
      {dms.list.map(({ channel, leaving }) => (
        <DmRailItem key={channel.id} channel={channel} leaving={leaving} onGone={dms.gone} />
      ))}
      <div className="rail-separator" />
      <RailGuilds renderGuild={g => <GuildRailItem guild={g} />} />
      <RailItem state="idle" tooltip="Add a Server">
        <button type="button" className="rail-tile rail-action rail-add" aria-label="Add a Server" onClick={() => openModal({ type: "createServer" })}>
          <Plus size={20} />
        </button>
      </RailItem>
      <RailItem state="idle" tooltip="Explore Discoverable Servers">
        <button type="button" className="rail-tile rail-action rail-discover" aria-label="Explore Discoverable Servers" aria-disabled="true">
          <Compass size={20} />
        </button>
      </RailItem>
      <RailItem state="idle" tooltip="Download Desktop App">
        <button type="button" className="rail-tile rail-action rail-download" aria-label="Download Desktop App" onClick={() => setDownloadOpen(true)}>
          <Download size={20} />
        </button>
      </RailItem>
      <DownloadAppsModal open={downloadOpen} onClose={() => setDownloadOpen(false)} />
    </nav>
  );
}
