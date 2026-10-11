// STUB (vokko-chat): small in-memory backend for developing the chat area. Shell's real mock replaces it at milestone A merge.
import { ChannelType, MessageType } from '../types';
import type { ApiError, Attachment, Channel, CreateMessageRequest, Guild, GuildMember, Message, Reaction, ReactionEmoji, Role, Snowflake, User } from '../types';
import { gateway } from '../gateway';
import { setState } from '../store';

const EPOCH = 1420070400000n;
let counter = 0n;
export function snowflakeAt(ms: number): string {
  counter = (counter + 1n) % 4096n;
  return (((BigInt(ms) - EPOCH) << 22n) | counter).toString();
}
export const nextId = (): string => snowflakeAt(Date.now());

const user = (id: string, username: string, global_name: string): User => ({ id, username, global_name, avatar: null, banner_color: null, bio: null, bot: false });
export const ME = user('100000000000000001', 'sam', 'Sam');
const ALICE = user('100000000000000002', 'alice', 'Alice');
const BOB = user('100000000000000003', 'bob', 'Bob');
const NOVA = user('100000000000000004', 'nova', 'Nova');
const CAROL = user('100000000000000005', 'carol', 'Carol');
const USERS = [ME, ALICE, BOB, NOVA, CAROL];

const GUILD_ID = '200000000000000001';
const roles: Role[] = [
  { id: GUILD_ID, name: '@everyone', color: 0, hoist: false, position: 0, permissions: '0', mentionable: false },
  { id: '210000000000000001', name: 'Moderator', color: 0x2ecc71, hoist: true, position: 2, permissions: '0', mentionable: true },
  { id: '210000000000000002', name: 'Builder', color: 0xe91e63, hoist: true, position: 1, permissions: '0', mentionable: true },
];
const guild: Guild = { id: GUILD_ID, name: "Sam's server", icon: null, owner_id: ME.id, roles, system_channel_id: '300000000000000001' };
const guildMembers: Record<string, GuildMember> = {
  [ME.id]: { user: ME, nick: null, roles: [roles[1]!.id], joined_at: new Date().toISOString() },
  [ALICE.id]: { user: ALICE, nick: null, roles: [roles[2]!.id], joined_at: new Date().toISOString() },
  [BOB.id]: { user: BOB, nick: 'Bobby', roles: [], joined_at: new Date().toISOString() },
  [NOVA.id]: { user: NOVA, nick: null, roles: [], joined_at: new Date().toISOString() },
};

const channels: Record<string, Channel> = {
  '300000000000000001': { id: '300000000000000001', type: ChannelType.GuildText, guild_id: GUILD_ID, name: 'general', topic: 'Welcome to Sam\'s server', position: 0, parent_id: null, last_message_id: null },
  '300000000000000002': { id: '300000000000000002', type: ChannelType.GuildText, guild_id: GUILD_ID, name: 'dev', topic: null, position: 1, parent_id: null, last_message_id: null },
  '400000000000000001': { id: '400000000000000001', type: ChannelType.DM, guild_id: null, name: null, topic: null, position: 0, parent_id: null, recipients: [ALICE], last_message_id: null },
  '400000000000000002': { id: '400000000000000002', type: ChannelType.DM, guild_id: null, name: null, topic: null, position: 0, parent_id: null, recipients: [BOB], last_message_id: null },
};

const store = new Map<string, Message[]>(); // ascending by id
const pins = new Map<string, Set<string>>();
const reactors = new Map<string, Map<string, Set<string>>>(); // messageId -> emojiKey -> user ids
const emojiKey = (e: ReactionEmoji): string => (e.id ? `${e.name}:${e.id}` : e.name);

function cmp(a: string, b: string): number { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
function tsOf(id: string): string { return new Date(Number((BigInt(id) >> 22n) + EPOCH)).toISOString(); }

function blank(channelId: string, author: User, content: string, id = nextId()): Message {
  const ch = channels[channelId];
  return {
    id, channel_id: channelId, guild_id: ch?.guild_id ?? null, author, content, timestamp: tsOf(id), edited_timestamp: null, type: MessageType.Default,
    mentions: [], mention_everyone: false, attachments: [], reactions: [], pinned: false, message_reference: null, referenced_message: null, nonce: null,
    ...(ch?.guild_id ? { member: { nick: guildMembers[author.id]?.nick ?? null, roles: guildMembers[author.id]?.roles ?? [] } } : {}),
  };
}

function art(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1e1f22"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><text x="320" y="210" font-family="sans-serif" font-size="42" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function seed(): void {
  const dm = '400000000000000001';
  const now = Date.now();
  const H = 3_600_000;
  const list: Message[] = [];
  const add = (agoH: number, who: User, content: string, mut?: (m: Message) => void): Message => {
    const m = blank(dm, who, content, snowflakeAt(now - agoH * H));
    mut?.(m);
    list.push(m);
    return m;
  };
  const filler = ['hey, did you see the new build?', 'yeah it looks great', 'lol', 'ok give me five minutes', 'sounds good', 'on my way', 'brb', 'what about tomorrow?', 'works for me', 'nice one'];
  for (let i = 0; i < 40; i++) add(80 - i * 0.7, i % 3 === 0 ? ME : ALICE, `${filler[i % filler.length]} (${i})`);
  const first = add(26, ALICE, 'Check out this **new** layout I made :tada:');
  add(25.99, ALICE, 'second line in the same group');
  add(25, ME, 'Looks _great_! ~~old~~ new. Here is the snippet:\n```ts\nconst answer: number = 42;\nconsole.log(`answer=${answer}`);\n```');
  add(24, ALICE, 'Yes please', m => { m.type = MessageType.Reply; m.message_reference = { message_id: first.id, channel_id: dm, guild_id: null }; m.referenced_message = first; });
  add(23, ME, 'here is the screenshot', m => { m.attachments = [{ id: nextId(), filename: 'layout.svg', content_type: 'image/svg+xml', size: 18234, url: art('layout.svg', '#5865f2'), width: 640, height: 400 }]; });
  add(5, ALICE, 'Fixed typo', m => { m.edited_timestamp = new Date(now - 4 * H).toISOString(); });
  add(4, ME, 'thanks <@100000000000000002>! 😀', m => { m.reactions = [{ emoji: { id: null, name: '👍' }, count: 2, me: true }, { emoji: { id: null, name: '🎉' }, count: 1, me: false }]; m.mentions = [ALICE]; });
  add(0.4, ALICE, 'ping <@100000000000000001> are you around?', m => { m.mentions = [ME]; });
  for (const m of list) {
    if (m.reactions.length) {
      const map = new Map<string, Set<string>>();
      for (const r of m.reactions) map.set(emojiKey(r.emoji), new Set(r.me ? [ME.id, ALICE.id].slice(0, r.count) : [ALICE.id]));
      reactors.set(m.id, map);
    }
  }
  store.set(dm, list);
  const gen = '300000000000000001';
  store.set(gen, ['Welcome to the server!', 'Please read the rules.', 'gg'].map((c, i) => blank(gen, i === 1 ? ME : ALICE, c, snowflakeAt(now - (10 - i) * H))));
  store.set('400000000000000002', [blank('400000000000000002', BOB, 'hey', snowflakeAt(now - 2 * H))]);
  store.set('300000000000000002', []);
  for (const [cid, msgs] of store) { const ch = channels[cid]; if (ch) ch.last_message_id = msgs[msgs.length - 1]?.id ?? null; }
}
seed();

export function initMockStore(): void {
  setState({
    me: ME,
    users: Object.fromEntries(USERS.map(u => [u.id, u])),
    guilds: { [GUILD_ID]: guild },
    channels,
    privateChannels: ['400000000000000001', '400000000000000002'],
    members: { [GUILD_ID]: guildMembers },
    presences: Object.fromEntries(USERS.map(u => [u.id, { user_id: u.id, status: 'online' as const, custom_status: null }])),
    readStates: Object.fromEntries(Object.keys(channels).map(id => [id, { channel_id: id, last_message_id: store.get(id)?.[Math.max(0, (store.get(id)?.length ?? 0) - 3)]?.id ?? null, mention_count: 0 }])),
  });
}
initMockStore();

class MockError extends Error {
  constructor(public status: number, public body: ApiError) { super(body.message); }
}
const fail = (status: number, code: number, message: string): never => { throw new MockError(status, { code, message }); };

function messagesOf(channelId: string): Message[] {
  const l = store.get(channelId);
  if (!l) return fail(404, 10003, 'Unknown Channel');
  return l;
}
function reactionsFor(m: Message): Reaction[] {
  const map = reactors.get(m.id);
  if (!map) return [];
  return [...map.entries()].filter(([, s]) => s.size > 0).map(([key, s]) => {
    const original = m.reactions.find(r => emojiKey(r.emoji) === key);
    const [name, id] = key.split(':');
    const emoji: ReactionEmoji = original?.emoji ?? { id: id ?? null, name: name ?? key };
    return { emoji, count: s.size, me: s.has(ME.id) };
  });
}
function publish(m: Message): Message {
  const out = { ...m, reactions: reactionsFor(m), pinned: pins.get(m.channel_id)?.has(m.id) ?? false };
  return out;
}

export function handle(method: string, rawPath: string, body: unknown): unknown {
  try { return route(method, rawPath, body); }
  catch (e) {
    if (e instanceof MockError) { const err = new Error(e.message) as Error & { status: number; body: ApiError }; err.status = e.status; err.body = e.body; throw err; }
    throw e;
  }
}

function route(method: string, rawPath: string, body: unknown): unknown {
  const [path = '', query = ''] = rawPath.split('?');
  const q = new URLSearchParams(query);
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'channels' || !seg[1]) return fail(404, 0, `mock: unsupported ${method} ${path}`);
  const channelId = seg[1];
  if (seg[2] === 'messages' && seg.length === 3) {
    const all = messagesOf(channelId);
    if (method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 50)));
      const before = q.get('before'), after = q.get('after'), around = q.get('around');
      let page: Message[];
      if (before) page = all.filter(m => cmp(m.id, before) < 0).slice(-limit).reverse();
      else if (after) page = all.filter(m => cmp(m.id, after) > 0).slice(0, limit).reverse();
      else if (around) {
        const idx = all.findIndex(m => cmp(m.id, around) >= 0);
        const i = idx < 0 ? all.length : idx;
        page = all.slice(Math.max(0, i - Math.floor(limit / 2)), i + Math.ceil(limit / 2)).reverse();
      } else page = all.slice(-limit).reverse();
      return page.map(publish);
    }
    if (method === 'POST') {
      const req = body as CreateMessageRequest;
      const content = (req.content ?? '').trim();
      const attachments = (req.attachment_ids ?? []).map(id => pendingAttachments.get(id)).filter((a): a is Attachment => !!a);
      if (!content && attachments.length === 0) return fail(400, 50006, 'Cannot send an empty message');
      if (content.length > 2000) return fail(400, 50035, 'Invalid Form Body');
      const m = blank(channelId, ME, content);
      m.nonce = req.nonce ?? null;
      m.attachments = attachments;
      m.mentions = USERS.filter(u => content.includes(`<@${u.id}>`));
      m.mention_everyone = /@everyone|@here/.test(content);
      if (req.message_reference) {
        const ref = all.find(x => x.id === req.message_reference?.message_id);
        m.type = MessageType.Reply;
        m.message_reference = { message_id: req.message_reference.message_id, channel_id: channelId, guild_id: m.guild_id };
        m.referenced_message = ref ? publish(ref) : null;
      }
      all.push(m);
      const ch = channels[channelId];
      if (ch) ch.last_message_id = m.id;
      gateway.emit('MESSAGE_CREATE', publish(m));
      return publish(m);
    }
  }
  if (seg[2] === 'messages' && seg[3]) {
    const all = messagesOf(channelId);
    const mid = seg[3];
    const idx = all.findIndex(m => m.id === mid);
    const m = all[idx];
    if (!m) return fail(404, 10008, 'Unknown Message');
    if (seg.length === 4) {
      if (method === 'PATCH') {
        if (m.author.id !== ME.id) return fail(403, 50005, 'Cannot edit a message authored by another user');
        const content = ((body as { content: string }).content ?? '').trim();
        if (!content) return fail(400, 50006, 'Cannot send an empty message');
        m.content = content;
        m.edited_timestamp = new Date().toISOString();
        gateway.emit('MESSAGE_UPDATE', publish(m));
        return publish(m);
      }
      if (method === 'DELETE') {
        all.splice(idx, 1);
        gateway.emit('MESSAGE_DELETE', { id: mid, channel_id: channelId, guild_id: m.guild_id });
        return null;
      }
    }
    if (seg[4] === 'ack' && method === 'POST') {
      setState(s => ({ readStates: { ...s.readStates, [channelId]: { channel_id: channelId, last_message_id: mid, mention_count: 0 } } }));
      gateway.emit('MESSAGE_ACK', { channel_id: channelId, message_id: mid });
      return null;
    }
    if (seg[4] === 'reactions' && seg[5]) {
      const emoji = decodeURIComponent(seg[5]);
      const [name, id] = emoji.includes(':') ? emoji.split(':') : [emoji, null];
      const re: ReactionEmoji = { id: id ?? null, name: name ?? emoji };
      const map = reactors.get(mid) ?? new Map<string, Set<string>>();
      reactors.set(mid, map);
      const set = map.get(emoji) ?? new Set<string>();
      map.set(emoji, set);
      if (seg[6] === '@me' && method === 'PUT') {
        if (!m.reactions.some(r => emojiKey(r.emoji) === emoji)) m.reactions.push({ emoji: re, count: 0, me: false });
        set.add(ME.id);
        gateway.emit('MESSAGE_REACTION_ADD', { user_id: ME.id, channel_id: channelId, message_id: mid, emoji: re });
        return null;
      }
      if (seg[6] === '@me' && method === 'DELETE') {
        set.delete(ME.id);
        gateway.emit('MESSAGE_REACTION_REMOVE', { user_id: ME.id, channel_id: channelId, message_id: mid, emoji: re });
        return null;
      }
      if (!seg[6] && method === 'GET') return [...set].map(uid => USERS.find(u => u.id === uid)).filter(Boolean);
    }
  }
  if (seg[2] === 'pins') {
    const set = pins.get(channelId) ?? new Set<string>();
    pins.set(channelId, set);
    if (method === 'GET') return messagesOf(channelId).filter(m => set.has(m.id)).reverse().map(publish);
    const mid = seg[3];
    if (mid && method === 'PUT') { set.add(mid); const m = messagesOf(channelId).find(x => x.id === mid); if (m) gateway.emit('MESSAGE_UPDATE', publish(m)); return null; }
    if (mid && method === 'DELETE') { set.delete(mid); const m = messagesOf(channelId).find(x => x.id === mid); if (m) gateway.emit('MESSAGE_UPDATE', publish(m)); return null; }
  }
  if (seg[2] === 'typing' && method === 'POST') return null;
  return fail(404, 0, `mock: unsupported ${method} ${path}`);
}

const pendingAttachments = new Map<string, Attachment>();
export async function upload(_channelId: string, file: File): Promise<Attachment> {
  const url = URL.createObjectURL(file);
  let width: number | null = null, height: number | null = null;
  if (file.type.startsWith('image/')) {
    await new Promise<void>(res => { const img = new Image(); img.onload = () => { width = img.naturalWidth; height = img.naturalHeight; res(); }; img.onerror = () => res(); img.src = url; });
  }
  const a: Attachment = { id: nextId(), filename: file.name, content_type: file.type || null, size: file.size, url, width, height };
  pendingAttachments.set(a.id, a);
  return a;
}

// Dev/e2e hooks: simulate other people.
export const mockControls = {
  me: ME,
  users: USERS,
  typing(userId: string, channelId: string): void { gateway.emit('TYPING_START', { channel_id: channelId, user_id: userId, timestamp: Math.floor(Date.now() / 1000) }); },
  say(userId: string, channelId: string, content: string): Message {
    const author = USERS.find(u => u.id === userId) ?? ALICE;
    const m = blank(channelId, author, content);
    m.mentions = USERS.filter(u => content.includes(`<@${u.id}>`));
    messagesOf(channelId).push(m);
    gateway.emit('MESSAGE_CREATE', publish(m));
    return m;
  },
  flood(channelId: string, count: number): void {
    const l = messagesOf(channelId);
    const base = Date.now() - count * 60_000 * 7;
    const older: Message[] = [];
    for (let i = 0; i < count; i++) older.push(blank(channelId, i % 5 < 3 ? ALICE : ME, `bulk message ${i + 1}`, snowflakeAt(base + i * 60_000 * 7)));
    l.unshift(...older);
  },
};
if (typeof window !== 'undefined') (window as unknown as { __vokko_mock: typeof mockControls }).__vokko_mock = mockControls;
export type { GuildMember };
