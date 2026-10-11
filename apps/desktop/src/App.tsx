import { useEffect, useRef, useState, type FormEvent, type CSSProperties } from 'react';
import seed from '../../../fixtures/demo.json';
import { desktopAvailable, dispatch } from './bridge';
import type { Member, Snapshot } from './protocol';

function Avatar({ member, small = false }: { member: Member; small?: boolean }) {
  return <span aria-hidden="true" className={`avatar${small ? ' small' : ''}`} style={{ '--avatar-color': member.color } as CSSProperties}>{member.initials}</span>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(seed as Snapshot);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(!desktopAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const channel = snapshot.channels.find(item => item.id === snapshot.selected_channel_id);
  const community = snapshot.communities.find(item => item.id === channel?.community_id);
  const user = snapshot.members.find(item => item.id === snapshot.current_user_id);
  const messages = snapshot.messages.filter(item => item.channel_id === channel?.id);
  const draft = channel ? drafts[channel.id] ?? '' : '';

  useEffect(() => {
    if (!desktopAvailable) return;
    let active = true;
    dispatch('session.inspect').then(state => {
      if (active) { setSnapshot(state); setReady(true); }
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [snapshot.selected_channel_id, messages.length]);

  async function selectChannel(id: string) {
    if (!ready || submitting.current) return;
    if (!desktopAvailable) {
      // Browser preview changes only the displayed channel; mutations require the Rust bridge.
      setSnapshot(state => ({ ...state, selected_channel_id: id }));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try { setSnapshot(await dispatch('channel.select', { channel_id: id })); }
    catch (reason) { setError(String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!channel || channel.kind !== 'text' || !draft.trim() || !desktopAvailable || !ready || submitting.current) return;
    const id = channel.id;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      setSnapshot(await dispatch('message.send', { channel_id: id, content: draft }));
      setDrafts(state => ({ ...state, [id]: '' }));
    } catch (reason) { setError(String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <div className="app-shell">
    <nav className="server-rail" aria-label="Communities">
      <div className="home-mark" aria-label="Vokko">v<span>•</span></div>
      <div className="rail-divider" />
      {snapshot.communities.map(item => <button key={item.id} className={`server-button ${community?.id === item.id ? 'active' : ''}`} aria-label={item.name} aria-pressed={community?.id === item.id} title={item.name} disabled={!ready || busy} onClick={() => {
        const first = snapshot.channels.find(candidate => candidate.community_id === item.id && candidate.kind === 'text');
        if (first) void selectChannel(first.id);
      }}>{item.initials}</button>)}
      <div className="rail-bottom">OPEN<br />SOURCE</div>
    </nav>

    <aside className="channel-sidebar" aria-label="Channel sidebar">
      <header className="community-header"><strong>{community?.name ?? 'Vokko'}</strong><span className="community-tag">LOCAL</span></header>
      <div className="channel-list">
        <p className="category-label">TEXT CHANNELS</p>
        {snapshot.channels.filter(item => item.community_id === community?.id && item.kind === 'text').map(item => <button className={`channel-button ${channel?.id === item.id ? 'selected' : ''}`} key={item.id} aria-current={channel?.id === item.id ? 'page' : undefined} disabled={!ready || busy} onClick={() => void selectChannel(item.id)}><span aria-hidden="true">#</span>{item.name}</button>)}
        <p className="category-label voice-label">VOICE CHANNELS</p>
        {snapshot.channels.filter(item => item.community_id === community?.id && item.kind === 'voice').map(item => <button className={`channel-button ${channel?.id === item.id ? 'selected' : ''}`} key={item.id} aria-current={channel?.id === item.id ? 'page' : undefined} disabled={!ready || busy} onClick={() => void selectChannel(item.id)}><span aria-hidden="true">◖</span>{item.name}<small>SOON</small></button>)}
      </div>
      <div className="user-panel">{user && <Avatar member={user} small />}<div><strong>{user?.name}</strong><span>Local session</span></div><span className="status-dot" aria-label="Local session active" /></div>
    </aside>

    <main className="conversation">
      <header className="conversation-header"><span className="channel-hash" aria-hidden="true">{channel?.kind === 'voice' ? '◖' : '#'}</span><strong>{channel?.name}</strong><span className="header-divider" /><p>{channel?.description}</p></header>
      <div className="session-banner" role="status">{desktopAvailable ? 'Local preview · Messages stay in this session and reset when you close the app.' : 'Browser preview · Open the desktop app to try local messaging.'}</div>
      {error && <div role="alert" className="error-banner">{error}</div>}
      <section className="message-history" aria-label={`Messages in ${channel?.name ?? 'channel'}`}>
        <div className="channel-intro"><div className="intro-symbol" aria-hidden="true">{channel?.kind === 'voice' ? '◖' : '#'}</div><h1>{channel?.kind === 'voice' ? channel.name : `Welcome to #${channel?.name}`}</h1><p>{channel?.kind === 'voice' ? 'Voice calls are not available in this first build.' : channel?.description}</p></div>
        {messages.length > 0 && <div className="history-divider"><span>Sample conversation</span></div>}
        {messages.map(message => {
          const author = snapshot.members.find(item => item.id === message.author_id);
          return <article className="message" key={message.id}>
            {author && <Avatar member={author} />}
            <div className="message-body"><div className="message-meta"><strong>{author?.name ?? 'Unknown member'}</strong><time dateTime={new Date(message.created_at_ms).toISOString()}>{new Date(message.created_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{message.id.startsWith('local-') && <span className="local-label">LOCAL</span>}</div><p>{message.content}</p></div>
          </article>;
        })}
        <div ref={end} />
      </section>
      <form className="composer" onSubmit={event => void send(event)}>
        <label className="sr-only" htmlFor="message-input">Message #{channel?.name}</label>
        <div className="composer-box"><textarea id="message-input" rows={1} maxLength={2000} value={draft} disabled={!desktopAvailable || !ready || busy || channel?.kind !== 'text'} placeholder={channel?.kind === 'voice' ? 'Voice is coming soon' : `Message #${channel?.name}`} onChange={event => {
          if (channel) setDrafts(state => ({ ...state, [channel.id]: event.target.value }));
        }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /><button type="submit" aria-label="Send message" disabled={!desktopAvailable || !ready || busy || !draft.trim() || channel?.kind !== 'text'}>Send <span aria-hidden="true">↗</span></button></div>
        <div className="composer-hint">{desktopAvailable ? 'Enter to send · Shift + Enter for a new line' : 'Read-only browser preview'}<span>{draft.length}/2000</span></div>
      </form>
    </main>

    <aside className="members-sidebar" aria-label="Members">
      <div className="members-heading">MEMBERS — {snapshot.members.length}</div>
      {snapshot.members.map(member => <div className="member" key={member.id}><div className="member-avatar"><Avatar member={member} small /><span className="status-dot" /></div><div><strong>{member.name}</strong><span>{member.id === snapshot.current_user_id ? 'That’s you' : 'Sample member'}</span></div></div>)}
      <div className="community-note"><span>BUILT IN THE OPEN</span><p>Your conversations.<br />Your community.</p><small>Vokko · First foundations</small></div>
    </aside>
  </div>;
}
