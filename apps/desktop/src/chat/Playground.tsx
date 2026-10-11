// Dev fixture for the chat area: `?playground` (see main.tsx while the shell is not merged). Not part of the product UI.
import { useRef, useState } from 'react';
import { Hash, Pin, Users } from 'lucide-react';
import { ChannelType } from '../api/types';
import { ContextMenuHost, Popout } from '../ui';
import { useStore } from '../api/store';
import { Avatar } from './Avatar';
import { ChatView, PinnedMessages } from './index';

export default function Playground() {
  const channels = useStore(s => s.channels);
  const privateIds = useStore(s => s.privateChannels);
  const [channelId, setChannelId] = useState<string>(privateIds[0] ?? '');
  const [pins, setPins] = useState(false);
  const pinBtn = useRef<HTMLButtonElement>(null);
  const current = channels[channelId];
  const title = current?.name ?? current?.recipients?.[0]?.global_name ?? '';

  return <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', height: '100vh', background: '#313338', color: '#dbdee1', fontFamily: 'Noto Sans, Inter, system-ui, sans-serif' }}>
    <aside style={{ background: '#2b2d31', padding: 8, overflow: 'auto' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#949ba4', margin: '8px', textTransform: 'uppercase' }}>Direct Messages</div>
      {privateIds.map(id => {
        const c = channels[id];
        const u = c?.recipients?.[0];
        if (!c || !u) return null;
        return <button key={id} type="button" onClick={() => setChannelId(id)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '6px 8px', borderRadius: 4, border: 0, background: id === channelId ? 'rgba(78,80,88,.6)' : 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
          <Avatar user={u} size={32} /> {u.global_name ?? u.username}
        </button>;
      })}
      <div style={{ fontSize: 12, fontWeight: 700, color: '#949ba4', margin: '16px 8px 8px', textTransform: 'uppercase' }}>Text Channels</div>
      {Object.values(channels).filter(c => c.type === ChannelType.GuildText).map(c => <button key={c.id} type="button" onClick={() => setChannelId(c.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', borderRadius: 4, border: 0, background: c.id === channelId ? 'rgba(78,80,88,.6)' : 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
        <Hash size={18} /> {c.name}
      </button>)}
    </aside>
    <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, height: 48, padding: '0 16px', borderBottom: '1px solid #1f2023', boxShadow: '0 1px 0 rgba(0,0,0,.2)', flex: 'none' }}>
        <strong>{title}</strong>
        <span style={{ flex: 1 }} />
        <button ref={pinBtn} type="button" aria-label="Pinned Messages" onClick={() => setPins(v => !v)} style={{ border: 0, background: 'none', color: '#b5bac1', cursor: 'pointer' }}><Pin size={24} /></button>
        <Users size={24} color="#b5bac1" />
      </header>
      {channelId && <ChatView channelId={channelId} />}
      <Popout anchor={pinBtn} open={pins} onClose={() => setPins(false)} side="bottom"><PinnedMessages channelId={channelId} /></Popout>
    </main>
    <ContextMenuHost />
  </div>;
}
