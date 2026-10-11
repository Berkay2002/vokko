import { useEffect, useState } from 'react';
import { Hash, MessageSquareText } from 'lucide-react';
import { ChannelType, RelationshipType, isThreadType } from '../api/types';
import type { Guild, Snowflake, User, UserProfile } from '../api/types';
import { Modal, guildIconUrl, guildInitials, request, resolveUrl, useGuilds, useMutualGuildsFromStore, useRelationship, Tooltip } from './shell';
import { useChat } from './ChatContext';
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
  return <div className="chat-start">
    <div className="chat-start-icon"><Hash size={42} /></div>
    <h1>Welcome to #{ch?.name}!</h1>
    <p>This is the start of the #{ch?.name} channel.{ch?.topic ? ` ${ch.topic}` : ''}</p>
  </div>;
}
