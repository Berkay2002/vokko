// `?seed=big`: a large server for the perf harness (e2e/perf.spec.ts). On top of the normal seed: "Big Server" owned by sam with
// 200 channels in 10 categories, 5,000 members (a third online, five hoisted roles) and #firehose with 20,000 messages over 60 days
// (text, markdown, code, replies, image attachments, link embeds and reactions). Deterministic: no Math.random.
// Messages are written straight into the store: addMessage() fans read states out to every member, which is O(members) per message.

import { ChannelType, MessageType, type Attachment, type Embed, type PresenceStatus } from "../types";
import { db, nextId, sortedMessages, type MockMessage } from "./db";
import { addChannel, createAccount, createGuildRecord } from "./ops";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const BIG = { channels: 200, members: 5_000, messages: 20_000, channelName: "firehose", guildName: "Big Server" } as const;

const WORDS = ("the build is green again but the gateway still drops a frame when the member list scrolls past the offline group and nobody " +
  "knows why so lets profile it tomorrow with the new harness maybe ship a fix before the weekend coffee first though").split(" ");
const CODE = "```ts\nconst rows = useMemo(() => buildRows(state), [state.messages]);\n```";
const IMAGE_SVG = (hue: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="hsl(${hue} 55% 35%)"/>` +
  `<circle cx="480" cy="120" r="60" fill="hsl(${(hue + 40) % 360} 80% 75%)"/></svg>`;
const IMAGES = Array.from({ length: 8 }, (_, i) => `data:image/svg+xml;utf8,${encodeURIComponent(IMAGE_SVG(i * 45))}`);
const EMOJI = ["👍", "😂", "🔥", "❤️", "👀", "🎉"];

function sentence(n: number, len: number): string {
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(WORDS[(n * 7 + i * 13) % WORDS.length] ?? "ok");
  return out.join(" ");
}

export function seedBig(): void {
  const sam = [...db.accounts.values()].find(a => a.user.username === "sam");
  if (!sam) return;
  const R = sam.user.id;
  const guildId = createGuildRecord(R, BIG.guildName);
  const guild = db.guilds.get(guildId);
  if (!guild) return;

  // Roles: five hoisted, by position.
  const roleNames = ["Staff", "Moderators", "Contributors", "Supporters", "Regulars"];
  const roles = roleNames.map((name, i) => ({ id: nextId(), name, color: [0xf0b232, 0x3ba55d, 0x5865f2, 0xeb459e, 0x1abc9c][i] ?? 0, hoist: true, position: 5 - i, permissions: "0", mentionable: false }));
  guild.guild.roles.push(...roles);

  // Members: sam plus 4,999 generated accounts. Every third is online (some idle / dnd), every 25th has a custom status.
  const joined = new Date(Date.now() - 90 * DAY).toISOString();
  const memberIds: string[] = [R];
  for (let i = 1; i < BIG.members; i++) {
    const status: PresenceStatus = i % 3 !== 0 ? "offline" : i % 15 === 0 ? "idle" : i % 21 === 0 ? "dnd" : "online";
    const account = createAccount({ username: `user${i}`, global_name: i % 4 === 0 ? null : `User ${i}`, status, custom_status: i % 25 === 0 ? `status ${i}` : null });
    const id = account.user.id;
    memberIds.push(id);
    // Roles cascade: 1 in 200 staff, 1 in 50 mods, 1 in 20 contributors, 1 in 10 supporters, 1 in 4 regulars.
    const role = i % 200 === 0 ? 0 : i % 50 === 0 ? 1 : i % 20 === 0 ? 2 : i % 10 === 0 ? 3 : i % 4 === 0 ? 4 : -1;
    guild.members.set(id, { nick: i % 9 === 0 ? `nick${i}` : null, roles: role >= 0 && roles[role] ? [roles[role].id] : [], joined_at: joined });
  }
  guild.members.set(R, { nick: null, roles: [roles[0]?.id ?? ""].filter(Boolean), joined_at: joined });

  // Channels: the default two categories + #general + General voice exist; add 8 more categories and fill to 200 channels.
  const categories = [...db.channels.values()].filter(c => c.guild_id === guildId && c.type === ChannelType.GuildCategory);
  for (let i = 0; i < 8; i++) categories.push(addChannel(guildId, { name: `Category ${i + 1}`, type: ChannelType.GuildCategory }));
  const firstText = categories[0];
  const firehose = addChannel(guildId, { name: BIG.channelName, type: ChannelType.GuildText, parent_id: firstText?.id ?? null, topic: "20,000 messages." });
  let count = [...db.channels.values()].filter(c => c.guild_id === guildId).length;
  for (let i = 0; count < BIG.channels; i++, count++) {
    const parent = categories[i % categories.length];
    const voice = i % 10 === 9;
    addChannel(guildId, { name: voice ? `Voice ${i}` : `channel-${i}`, type: voice ? ChannelType.GuildVoice : ChannelType.GuildText, parent_id: parent?.id ?? null });
  }

  // #firehose: 20,000 messages from 300 authors over 60 days, in bursts so grouping and day dividers both show.
  const authors = memberIds.slice(0, 300);
  const list = sortedMessages(firehose.id);
  const start = Date.now() - 60 * DAY;
  const step = (60 * DAY - 10 * MIN) / BIG.messages;
  for (let n = 0; n < BIG.messages; n++) {
    const ms = Math.floor(start + n * step);
    const author = authors[Math.floor(n / 3) % authors.length] ?? R;
    const attachments: Attachment[] = n % 13 === 5 ? [{ id: nextId(ms), filename: `shot-${n}.svg`, content_type: "image/svg+xml", size: 300, url: IMAGES[n % IMAGES.length] ?? "", width: 640, height: 360 }] : [];
    const embeds: Embed[] = n % 17 === 3 ? [{ type: "rich", title: `Release notes ${n}`, description: sentence(n, 24), url: `https://example.com/notes/${n}`, color: 0x5865f2, provider: { name: "example.com" } }] : [];
    const reply = n % 11 === 7 && n > 0 ? list[n - 1 - (n % 5)] : undefined;
    const content = n % 29 === 0 ? CODE : n % 7 === 0 ? `**${sentence(n, 4)}** ${sentence(n + 1, 30)}` : sentence(n, 4 + (n % 18));
    const reactions = n % 6 === 1 ? [{ emoji: { id: null, name: EMOJI[n % EMOJI.length] ?? "👍" }, user_ids: authors.slice(0, 1 + (n % 9)) }] : [];
    if (n % 30 === 1) reactions.push({ emoji: { id: null, name: "🎉" }, user_ids: [R, ...authors.slice(5, 8)] });
    const message: MockMessage = {
      id: nextId(ms),
      channel_id: firehose.id,
      guild_id: guildId,
      author_id: author,
      content,
      timestamp: new Date(ms).toISOString(),
      edited_timestamp: null,
      type: reply ? MessageType.Reply : MessageType.Default,
      mention_ids: reply ? [reply.author_id] : [],
      mention_everyone: false,
      attachments,
      reactions,
      pinned: n % 2000 === 0,
      pinned_at: n % 2000 === 0 ? new Date(ms).toISOString() : null,
      reference_id: reply?.id ?? null,
      nonce: null,
      embeds,
    };
    list.push(message);
  }
  const last = list.at(-1);
  firehose.last_message_id = last?.id ?? null;
  sam.readStates.set(firehose.id, { channel_id: firehose.id, last_message_id: last?.id ?? null, mention_count: 0 });
}
