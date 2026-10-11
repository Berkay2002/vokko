import { useEffect } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { ChatView } from "../chat/ChatView";
import { appStore, avatarUrl, defaultAvatarUrl, dmName, guildInitials, useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { logout } from "../api/auth";
import { firstTextChannel } from "./channels";

export function AppShell() {
  const params = useParams();
  const isHome = (params.guildId ?? "@me") === "@me";
  const guildId = isHome ? null : (params.guildId ?? null);
  const channelId = params.channelId ?? null;

  const guilds = useStore(s => s.guildOrder.map(id => s.guilds[id]).filter(Boolean));
  const privateChannels = useStore(s => s.privateChannels.map(id => s.channels[id]).filter((c): c is Channel => !!c));
  const guildChannels = useStore(s => (guildId ? Object.values(s.channels).filter(c => c.guild_id === guildId) : []));
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const me = useStore(s => s.me);
  const lastChannel = useStore(s => (guildId ? s.lastChannelByGuild[guildId] : undefined));

  useEffect(() => {
    appStore.getState().setRoute({ guildId, channelId });
  }, [guildId, channelId]);

  if (!isHome && !guild) return <Navigate to="/channels/@me" replace />;
  if (guildId && !channelId) {
    const target = (lastChannel && guildChannels.find(c => c.id === lastChannel)?.id) ?? firstTextChannel(guildChannels)?.id;
    if (target) return <Navigate to={`/channels/${guildId}/${target}`} replace />;
  }

  return (
    <div className="app-root shell">
      <nav className="shell-rail" aria-label="Servers">
        <NavLink to="/channels/@me" className="shell-rail-item">
          Home
        </NavLink>
        {guilds.map(g => (
          <NavLink key={g!.id} to={`/channels/${g!.id}`} className="shell-rail-item" title={g!.name}>
            {guildInitials(g!.name)}
          </NavLink>
        ))}
      </nav>
      <aside className="shell-sidebar">
        <div className="shell-sidebar-title">{isHome ? "Direct Messages" : guild?.name}</div>
        <div className="shell-sidebar-list">
          {isHome
            ? privateChannels.map(c => (
                <NavLink key={c.id} to={`/channels/@me/${c.id}`} className="shell-row">
                  <img src={c.recipients?.[0] ? avatarUrl(c.recipients[0]) : defaultAvatarUrl(c.id)} alt="" width={24} height={24} />
                  {dmName(c)}
                </NavLink>
              ))
            : guildChannels
                .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
                .map(c => (
                  <NavLink key={c.id} to={`/channels/${guildId}/${c.id}`} className="shell-row">
                    {c.type === ChannelType.GuildVoice ? "🔊" : "#"} {c.name}
                  </NavLink>
                ))}
        </div>
        <div className="shell-userpanel">
          {me && <img src={avatarUrl(me)} alt="" width={32} height={32} />}
          <span>{me?.global_name ?? me?.username}</span>
          <button type="button" className="icon-button" onClick={() => void logout()} title="Log out">
            ⎋
          </button>
        </div>
      </aside>
      <main className="shell-main">{channelId ? <ChatView key={channelId} channelId={channelId} /> : <div className="shell-empty">Pick a conversation.</div>}</main>
    </div>
  );
}
