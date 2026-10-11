import { useMemo, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { Compass, Plus } from "lucide-react";
import logo from "../../assets/icon.svg";
import { avatarUrl, channelMentionCount, dmMentionCount, guildUnread, isChannelUnread, useStore } from "../api/store";
import { ChannelType, type Channel, type Guild } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { GuildIcon } from "./Avatar";
import { firstTextChannel } from "./channels";
import { useIsMuted } from "./localState";
import { guildContextItems } from "./menus";
import { guildPath } from "./nav";
import { openModal } from "./modalStore";

function RailItem({ state, mentions, tooltip, muted, children }: { state: "selected" | "unread" | "idle"; mentions?: number; tooltip: ReactNode; muted?: boolean; children: ReactNode }) {
  return (
    <div className={`rail-item${muted ? " muted" : ""}`} data-state={state}>
      <span className="rail-pill" />
      <Tooltip content={tooltip} side="right">
        {children}
      </Tooltip>
      {!!mentions && mentions > 0 && <span className="rail-badge">{mentions > 99 ? "99+" : mentions}</span>}
    </div>
  );
}

function GuildRailItem({ guild }: { guild: Guild }) {
  const location = useLocation();
  const selected = location.pathname.startsWith(`/channels/${guild.id}`);
  const info = useStore(s => guildUnread(s, guild.id));
  const lastChannel = useStore(s => s.lastChannelByGuild[guild.id]);
  const channels = useStore(s => Object.values(s.channels).filter(c => c.guild_id === guild.id));
  const menu = useContextMenu();
  const target = (lastChannel && channels.find(c => c.id === lastChannel)?.id) ?? firstTextChannel(channels)?.id;
  const muted = useIsMuted(guild.id);
  const state = selected ? "selected" : info.unread && !muted ? "unread" : "idle";

  return (
    <RailItem state={state} mentions={info.mentions} tooltip={guild.name} muted={muted}>
      <NavLink to={guildPath(guild.id, target)} className="rail-tile rail-guild" aria-label={guild.name} onContextMenu={e => menu.open(e, guildContextItems(guild))}>
        <GuildIcon guild={guild} size={40} />
      </NavLink>
    </RailItem>
  );
}

function DmRailItem({ channel }: { channel: Channel }) {
  const location = useLocation();
  const selected = location.pathname === `/channels/@me/${channel.id}`;
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const first = channel.recipients?.[0];
  const label = channel.name ?? (channel.recipients ?? []).map(r => r.global_name ?? r.username).join(", ");
  return (
    <RailItem state={selected ? "selected" : "unread"} mentions={mentions} tooltip={label}>
      <NavLink to={`/channels/@me/${channel.id}`} className="rail-tile rail-dm" aria-label={label}>
        {first ? <img src={avatarUrl(first)} alt="" width={40} height={40} draggable={false} /> : <span className="rail-dm-fallback" />}
      </NavLink>
    </RailItem>
  );
}

export function ServerRail() {
  const location = useLocation();
  const guilds = useStore(s => s.guildOrder.map(id => s.guilds[id]).filter((g): g is Guild => !!g));
  const unreadDms = useStore(s => s.privateChannels.map(id => s.channels[id]).filter((c): c is Channel => !!c && isChannelUnread(s, c.id)));
  const dmMentions = useStore(dmMentionCount);
  const home = location.pathname.startsWith("/channels/@me");
  const visibleDms = useMemo(() => unreadDms.filter(c => c.type === ChannelType.DM || c.type === ChannelType.GroupDM), [unreadDms]);

  return (
    <nav className="server-rail" aria-label="Servers sidebar">
      <RailItem state={home ? "selected" : "idle"} tooltip="Direct Messages" mentions={dmMentions}>
        <NavLink to="/channels/@me" className={`rail-tile rail-home${home ? " selected" : ""}`} aria-label="Direct Messages">
          <img src={logo} alt="" width={24} height={24} draggable={false} />
        </NavLink>
      </RailItem>
      {visibleDms.map(c => (
        <DmRailItem key={c.id} channel={c} />
      ))}
      <div className="rail-separator" />
      {guilds.map(g => (
        <GuildRailItem key={g.id} guild={g} />
      ))}
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
    </nav>
  );
}
