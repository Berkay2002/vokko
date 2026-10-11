import { useEffect, useState } from 'react';
import { Hash, MessageCircle, MessageSquareText, Pencil } from 'lucide-react';
import { ChannelType, RelationshipType, isThreadType } from '../api/types';
import type { Channel, Guild, Snowflake, User, UserProfile } from '../api/types';
import { Modal, Perm, guildIconUrl, guildInitials, openModal, request, resolveUrl, useGuild, useGuildChannels, useGuilds, useMutualGuildsFromStore, usePermissions, useRelationship, Tooltip } from './shell';
import { useChat } from './ChatContext';
import { useChannelState } from './messageStore';
import { WelcomeChecklist } from '../community';
import { Avatar } from './Avatar';

/** Guilds shared with `userId`: GET /users/{id}/profile, falling back to the members the store already holds. */
function useMutualGuilds(userId: Snowflake): Guild[] {
  const fallback = useMutualGuildsFromStore(userId);
  const guilds = useGuilds();
  const [ids, setIds] = useState<Snowflake[] | null>(null);
  useEffect(() => {
    let live = true;
    setIds(null);
    request<UserProfile>('GET', `/users/${userId}/profile`)
      .then(p => { if (live) setIds(p.mutual_guilds.map(g => g.id)); })
      .catch(() => { if (live) setIds(null); });
    return () => { live = false; };
  }, [userId]);
  if (!ids) return fallback;
  return ids.map(id => guilds[id]).filter((g): g is Guild => !!g);
}

function GuildChip({ guild }: { guild: Guild }) {
  const icon = guildIconUrl(guild);
  return <span className="chat-start-guild" title={guild.name}>
    {icon ? <img src={resolveUrl(icon)} alt="" draggable={false} /> : <span>{guildInitials(guild.name)}</span>}
  </span>;
}

function DmRelationRow({ user, name }: { user: User; name: string }) {
  const relationship = useRelationship(user.id);
  const mutual = useMutualGuilds(user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const type = relationship?.type;

  async function run(method: 'PUT' | 'DELETE', body?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await request<null>(method, `/users/@me/relationships/${user.id}`, body); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    setBusy(false);
  }

  const friendButton = (() => {
    switch (type) {
      case RelationshipType.Friend: return <button type="button" className="chat-start-btn" disabled={busy} onClick={() => void run('DELETE')}>Remove Friend</button>;
      case RelationshipType.OutgoingRequest: return <button type="button" className="chat-start-btn" disabled>Friend Request Sent</button>;
      case RelationshipType.IncomingRequest: return <>
        <button type="button" className="chat-start-btn" disabled={busy} onClick={() => void run('PUT')}>Accept Friend Request</button>
        <button type="button" className="chat-start-btn" disabled={busy} onClick={() => void run('DELETE')}>Ignore</button>
      </>;
      case RelationshipType.Blocked: return null;
      default: return <button type="button" className="chat-start-btn" disabled={busy} onClick={() => void run('PUT')}>Add Friend</button>;
    }
  })();

  return <>
    <div className="chat-start-relation">
      {mutual.length > 0 && <>
        <Tooltip content={mutual.map(g => g.name).join(', ')} side="top">
          <span className="chat-start-mutual">
            <span className="chat-start-guilds">{mutual.slice(0, 3).map(g => <GuildChip key={g.id} guild={g} />)}</span>
            {mutual.length} Mutual Server{mutual.length === 1 ? '' : 's'}
          </span>
        </Tooltip>
        <span className="chat-start-dot" aria-hidden="true" />
      </>}
      {friendButton}
      {type === RelationshipType.Blocked
        ? <button type="button" className="chat-start-btn" disabled={busy} onClick={() => void run('DELETE')}>Unblock</button>
        : <button type="button" className="chat-start-btn" disabled={busy} onClick={() => setConfirmBlock(true)}>Block</button>}
      {error && <span className="chat-start-error" role="alert">{error}</span>}
    </div>
    <Modal open={confirmBlock} onClose={() => setConfirmBlock(false)} title={`Block ${name}`}
      footer={<>
        <button type="button" className="chat-btn link" onClick={() => setConfirmBlock(false)}>Cancel</button>
        <button type="button" className="chat-btn danger" onClick={() => { setConfirmBlock(false); void run('PUT', { type: RelationshipType.Blocked }); }}>Block</button>
      </>}>
      <p className="chat-modal-text">Are you sure you want to block <b>{name}</b>? Blocking also removes them from your friends.</p>
    </Modal>
  </>;
}

export function ChannelStart() {
  const chat = useChat();
  const ch = chat.channel;
  if (ch && ch.type === ChannelType.DM) {
    const other = ch.recipients?.[0];
    const name = other ? chat.nameOf(other) : 'this user';
    return <div className="chat-start">
      {other && <Avatar user={other} size={80} className="chat-start-avatar" />}
      <h1>{name}</h1>
      <h2>{other?.username}</h2>
      <p>This is the beginning of your direct message history with <b>{name}</b>.</p>
      {other && <DmRelationRow user={other} name={name} />}
    </div>;
  }
  if (ch && ch.type === ChannelType.GroupDM) {
    const names = (ch.recipients ?? []).map(u => chat.nameOf(u)).join(', ');
    return <div className="chat-start"><h1>{names}</h1><p>Welcome to the beginning of the group.</p></div>;
  }
  if (ch && isThreadType(ch.type)) {
    return <div className="chat-start">
      <div className="chat-start-icon"><MessageSquareText size={42} /></div>
      <h1>{ch.name}</h1>
      <p>This is the start of the thread.</p>
    </div>;
  }
  // Text-in-voice: a speech bubble, the bare channel name (no hash) and a shortcut to the channel settings.
  const voice = ch?.type === ChannelType.GuildVoice;
  const label = voice ? ch?.name : `#${ch?.name}`;
  return <div className="chat-start">
    <div className="chat-start-icon">{voice ? <MessageCircle size={42} /> : <Hash size={42} />}</div>
    <h1>Welcome to {label}!</h1>
    <p>This is the start of the {label} channel.{ch?.topic ? ` ${ch.topic}` : ''}</p>
    {voice && ch && <VoiceStartActions channel={ch} />}
    {ch && chat.guildId && <ServerChecklist guildId={chat.guildId} channelId={ch.id} />}
  </div>;
}

function VoiceStartActions({ channel }: { channel: Channel }) {
  const { can } = usePermissions(channel.guild_id, channel.id);
  if (!can(Perm.MANAGE_CHANNELS)) return null;
  return <button type="button" className="chat-start-btn" style={{ marginTop: 12 }} onClick={() => openModal({ type: 'editChannel', channelId: channel.id })}>
    <Pencil size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Edit Channel
  </button>;
}

function useGuildStartChannel(guildId: Snowflake): Snowflake | undefined {
  const guild = useGuild(guildId);
  const channels = useGuildChannels(guildId);
  const system = guild?.system_channel_id;
  if (system && channels.some(c => c.id === system)) return system;
  return channels.find(c => c.type === ChannelType.GuildText)?.id;
}

/** The new-server checklist belongs to the server's first channel (the system channel, else the first text channel). */
function ServerChecklist({ guildId, channelId }: { guildId: Snowflake; channelId: Snowflake }) {
  const chat = useChat();
  const first = useGuildStartChannel(guildId);
  const state = useChannelState(channelId);
  if (first !== channelId) return null;
  const sentFirstMessage = state.messages.some(m => m.author.id === chat.me.id && m.type === 0);
  return <WelcomeChecklist guildId={guildId} channelId={channelId} sentFirstMessage={sentFirstMessage} />;
}
