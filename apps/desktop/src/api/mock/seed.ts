// Seed data mirroring `vokko-server seed`: users sam, carol, alice, bob, nova (password "vokko-dev"),
// "Sam's server", a 60-message DM sam <-> carol and a few smaller conversations.

import { ChannelFlags, ChannelType, ForumLayout, OverwriteType, RelationshipType, StickerFormat, type Attachment, type Sticker, type User } from "../types";
import { Perm } from "../permissions";
import { db, nextId, sortedMessages, type MockChannel, type MockMessage } from "./db";
import { stickerSvg, svgDataUri } from "./gifs";
import { addChannel, addMessage, createAccount, createGuildRecord, openDM, openGroupDM } from "./ops";
import { createForumPost, initChannelFields, startThreadFromMessage } from "./threads";
import { setRelationship } from "./views";
import { seedVoiceState } from "./voice";

const MIN = 60_000;
const HOUR = 60 * MIN;

const GRADIENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2f8f"/><stop offset="0.55" stop-color="#d1495b"/><stop offset="1" stop-color="#f4a259"/></linearGradient></defs>
<rect width="800" height="450" fill="url(#g)"/><circle cx="590" cy="150" r="70" fill="#ffe8b0" opacity="0.9"/>
<path d="M0 340 Q150 270 300 330 T600 320 T800 300 V450 H0Z" fill="#1d1b3a" opacity="0.85"/>
<path d="M0 390 Q200 340 400 385 T800 370 V450 H0Z" fill="#12112b"/></svg>`;

function seedImage(): Attachment {
  return {
    id: nextId(),
    filename: "sunset.svg",
    content_type: "image/svg+xml",
    size: GRADIENT_SVG.length,
    url: `data:image/svg+xml;utf8,${encodeURIComponent(GRADIENT_SVG)}`,
    width: 800,
    height: 450,
  };
}

interface Line {
  who: "R" | "B";
  text: string;
  /** seconds since the previous message (default cycles through short gaps) */
  gap?: number;
  reply?: number;
  react?: [string, ("R" | "B")[]][];
  edited?: boolean;
  image?: boolean;
  pin?: boolean;
}

const DM: Line[] = [
  { who: "B", text: "hey, did you get the build running on your end?" },
  { who: "R", text: "yeah, the dev server came up fine" },
  { who: "R", text: "the gateway part still needs a mock though" },
  { who: "B", text: "nice. i'll push the schema tonight" },
  { who: "B", text: "reminder: snowflakes are **strings** on the wire, never parse them as numbers", pin: true, react: [["👍", ["R"]]] },
  { who: "R", text: "right, bigint territory 😅" },
  { who: "B", text: "exactly" },
  { who: "R", text: "what do we do about the unread pill on the server rail?" },
  { who: "B", text: "compare `last_message_id` with the read state, same as discord does" },
  { who: "R", text: "makes sense", reply: 8 },
  { who: "R", text: "and the mention badge comes from `mention_count`?" },
  { who: "B", text: "yep, the server increments it when the message mentions you" },
  { who: "B", text: "or @everyone", gap: 20 },
  { who: "R", text: "ok let me wire that up tomorrow", gap: 16 * HOUR / 1000 },
  { who: "R", text: "morning! started on the member list", edited: true },
  { who: "B", text: "good morning, how's it looking?" },
  { who: "R", text: "hoisted roles on top, then online, then offline" },
  { who: "R", text: "here's the grouping helper:" },
  {
    who: "R",
    text: "```ts\nconst unread = (channel: Channel, read?: ReadState) =>\n  compareIds(channel.last_message_id ?? \"0\", read?.last_message_id ?? \"0\") > 0;\n```",
  },
  { who: "B", text: "clean. ship it" },
  { who: "B", text: "ok that works really well", react: [["❤️", ["R", "B"]], ["🔥", ["B"]]] },
  { who: "R", text: "thanks!" },
  { who: "B", text: "btw how did the typography pass go" },
  { who: "R", text: "Noto Sans at 16px with 1.375 line height, close enough for now" },
  { who: "B", text: "look at this render from last night", image: true, gap: 6 * 60 },
  { who: "R", text: "ooh that gradient", reply: 24 },
  { who: "R", text: "which tool did you use?" },
  { who: "B", text: "just a hand-written svg, took five minutes" },
  { who: "R", text: "lol of course 😂", react: [["😂", ["B"]]] },
  { who: "B", text: "we should use it as the default server banner", gap: 90 },
  { who: "R", text: "good idea, adding it to the todo" },
  { who: "R", text: "- avatars\n- banners\n- the invite page" },
  { who: "B", text: "**bold** *italic* __underline__ ~~strike~~ ||spoiler|| `code` https://example.com", gap: 20 * HOUR / 1000 },
  { who: "R", text: "markdown looks right to me" },
  { who: "B", text: "what about # headings?" },
  { who: "R", text: "# big heading\nand some text underneath" },
  { who: "B", text: "nice" },
  { who: "R", text: "now the dm list needs a close button on hover" },
  { who: "B", text: "and presence dots, don't forget the idle moon" },
  { who: "R", text: "already done, idle is a half moon, dnd a bar" },
  { who: "B", text: "> compare ids as BigInt, not as strings\nthis is the one that always bites", reply: 33 },
  { who: "R", text: "length first, then lexicographic, no BigInt needed" },
  { who: "B", text: "oh that's neat" },
  { who: "R", text: "learned it from the discord client bundle 😉" },
  { who: "B", text: "hah", react: [["👀", ["R"]]] },
  { who: "B", text: "ok so what's left for the shell?" },
  { who: "R", text: "friends page, modals, user settings", gap: 40 },
  { who: "R", text: "then login and register" },
  { who: "B", text: "that's a lot", edited: true },
  { who: "R", text: "it's fine, the hard part is the gateway" },
  { who: "B", text: "true, resume with backoff and all that" },
  { who: "R", text: "heartbeat, resume, invalid session, re-identify" },
  { who: "B", text: "i'll write the server side replay buffer tonight", gap: 3 * HOUR / 1000 },
  { who: "B", text: "500 events per session sounds fine?" },
  { who: "R", text: "sure, bigger than that and we just re-identify" },
  { who: "B", text: "perfect" },
  { who: "R", text: "call later?", gap: 2 * 60 },
  { who: "B", text: "give me 10 minutes" },
  { who: "R", text: "👍", react: [["👍", ["B"]]] },
  { who: "B", text: "ok ready when you are" },
  { who: "R", text: "joining now" },
];

function addDmConversation(channel: MockChannel, ids: Record<"R" | "B", string>): void {
  const gaps = [25, 48, 70, 35, 90, 20, 55];
  let offsetSeconds = 0;
  const offsets: number[] = [];
  DM.forEach((line, i) => {
    offsetSeconds += line.gap ?? gaps[i % gaps.length] ?? 30;
    offsets.push(offsetSeconds);
  });
  const total = offsetSeconds;
  const start = Date.now() - 14 * MIN - total * 1000;
  const created: string[] = [];
  DM.forEach((line, i) => {
    const referenced = line.reply !== undefined ? created[line.reply] : undefined;
    const message = addMessage({
      channel,
      author_id: ids[line.who],
      content: line.text,
      timestamp: start + (offsets[i] ?? 0) * 1000,
      reference_id: referenced ?? null,
      attachments: line.image ? [seedImage()] : [],
      silent: true,
    });
    created.push(message.id);
    if (line.edited) message.edited_timestamp = new Date(Date.parse(message.timestamp) + 3 * MIN).toISOString();
    if (line.pin) {
      message.pinned = true;
      message.pinned_at = new Date(Date.parse(message.timestamp) + MIN).toISOString();
    }
    for (const [name, who] of line.react ?? []) message.reactions.push({ emoji: { id: null, name }, user_ids: who.map(w => ids[w]) });
  });
}

/**
 * #stock-talk in the guild: the message-area showcase (invented text). Server tags on two authors, replies (to text, to an image, to a deleted
 * message), a ping-reply and an @everyone that mention sam, a single image, an image grid, emoji-only and inline-emoji lines, and dates old
 * enough (3 days) to show the locale date format plus one yesterday and one today.
 */
function seedMessageShowcase(ctx: { guildId: string; parentId: string; R: string; A: string; Bo: string; N: string; admin: string; sam: User; bob: User }): MockChannel {
  const { guildId, parentId, R, A, Bo, N, admin, sam, bob } = ctx;
  sam.primary_guild = { guild_id: guildId, tag: "VKO", badge: "bolt", color_primary: 0x5865f2, color_secondary: 0x3b2f8f };
  bob.primary_guild = { guild_id: guildId, tag: "GG", badge: "leaf", color_primary: 0x3ba55d, color_secondary: 0x1d6b3a };
  const channel = addChannel(guildId, { name: "stock-talk", type: ChannelType.GuildText, parent_id: parentId, topic: "Charts, takes and bad ideas." });
  const day = 24 * HOUR;
  const at = (offsetMs: number): number => Date.now() - offsetMs;
  const post = (who: string, content: string, offsetMs: number, extra: { reply?: string; attachments?: Attachment[] } = {}) =>
    addMessage({ channel, author_id: who, content, timestamp: at(offsetMs), reference_id: extra.reply ?? null, attachments: extra.attachments ?? [], silent: true });

  const base = 3 * day;
  post(R, "squeeze watch: the float on this one is tiny", base);
  const chart = post(R, "", base - 20 * MIN, { attachments: [seedImage()] });
  post(N, "damn 🤯", base - 25 * MIN);
  post(Bo, "nice chart", base - 26 * MIN, { reply: chart.id });
  post(R, "9% pop since lunch", base - 28 * MIN);
  post(R, "most of it happened in the last hour, the volume was silly", base - 28 * MIN - 40_000);
  const hope = post(N, "i hope it keeps sliding, i want a cheaper entry", base - 30 * MIN);
  post(R, "its a long way down then", base - 30 * MIN - 30_000, { reply: hope.id });
  const long = post(N, "holding through the next print anyway, but the debt load could turn into a much bigger problem in a higher rate environment than anyone is pricing in right now", base - 31 * MIN);
  post(R, "they print cash right now, they will be fine", base - 31 * MIN - 45_000, { reply: long.id });
  const cash = post(R, "and they can sign deals with the big labs too", base - 31 * MIN - 80_000);
  post(N, "yeah i know", base - 32 * MIN, { reply: cash.id });
  // A reply whose target is deleted afterwards (the wire says referenced_message = null).
  const gone = post(N, "scratch that, wrong ticker", base - 33 * MIN);
  post(Bo, "lol happens", base - 33 * MIN - 20_000, { reply: gone.id });
  const list = sortedMessages(channel.id);
  const goneIndex = list.findIndex(m => m.id === gone.id);
  if (goneIndex >= 0) list.splice(goneIndex, 1);

  post(A, "morning all, three charts from the weekend scan", day + 2 * HOUR, { attachments: [seedImage(), seedImage(), seedImage()] });
  post(N, "🔥", day + HOUR);
  post(N, "this one is a **solid** setup :eyes: not financial advice 😅", day + HOUR - MIN);
  post(Bo, `@everyone market opens in ten, coffee up`, 2 * HOUR);
  post(A, `<@${R}> did you see the filing? worth a look before the bell`, 90 * MIN);
  // A role mention of a role sam has (Admin): the row is highlighted for sam, the wire has no mention_roles so the client reads the content.
  post(A, `<@&${admin}> can an admin sign off the release notes?`, 12 * MIN);
  const status = post(R, "reading it now, will post a summary", 80 * MIN);
  post(Bo, "thanks!", 40 * MIN, { reply: status.id });
  post(N, "the summary will be long, brace yourselves", 20 * MIN, { reply: status.id });
  // Several mentions in one group: each mentioned line is its own tinted block with its own bar, the plain line between them is not.
  post(Bo, `<@${R}>`, 10 * MIN);
  post(Bo, `<@${R}>`, 10 * MIN - 5_000);
  post(Bo, "hello", 10 * MIN - 10_000);
  post(Bo, `<@${R}>`, 10 * MIN - 15_000);
  return channel;
}

/**
 * Threads, an announcement channel with news, and a forum channel with tags and posts. Times are relative to now; the forum posts use
 * the 7 day auto-archive so a long-open mock session does not archive them under the user's feet.
 */
function seedThreads(ctx: { general: MockChannel; announcements: MockChannel; guildId: string; textCategory: string; docsQuestion: MockMessage; replayBuffer: MockMessage; morning: MockMessage; R: string; A: string; B: string; Bo: string; N: string }): void {
  const { general, announcements, guildId, textCategory, docsQuestion, replayBuffer, morning, R, A, B, Bo, N } = ctx;
  const ago = (minutes: number): number => Date.now() - minutes * MIN;
  const reply = (channel: MockChannel, who: string, text: string, minutesAgo: number) => addMessage({ channel, author_id: who, content: text, timestamp: ago(minutesAgo), silent: true });

  // An active thread (sam is in it) and an archived one under #general.
  const docs = startThreadFromMessage(general, docsQuestion, "gateway docs", N, 1440, Date.parse(docsQuestion.timestamp));
  reply(docs, R, "the resume section is the part to read first", 232);
  reply(docs, A, "I'll add a sequence diagram next week", 225);
  reply(docs, N, "great, thanks both", 221);
  const buffer = startThreadFromMessage(general, replayBuffer, "replay buffer sizing", B, 1440, Date.parse(replayBuffer.timestamp));
  reply(buffer, Bo, "is 500 enough for a laptop that sleeps?", 118);
  reply(buffer, B, "if not it just re-identifies, no harm done", 115);
  if (buffer.thread_metadata) {
    buffer.thread_metadata.archived = true;
    buffer.thread_metadata.archive_timestamp = new Date(ago(60 * 30)).toISOString();
  }

  // A locked thread sam has not joined (bob owns it, so as bob it reads as locked without Manage Threads).
  const coffee = startThreadFromMessage(general, morning, "coffee setups", Bo, 1440, Date.parse(morning.timestamp));
  reply(coffee, A, "pour-over, every day", 290);
  reply(coffee, Bo, "locking this before it turns into a flame war", 280);
  if (coffee.thread_metadata) coffee.thread_metadata.locked = true;

  // Announcements: a couple of news posts (publish them to followers from the message menu).
  const news = (who: string, text: string, minutesAgo: number) => addMessage({ channel: announcements, author_id: who, content: text, timestamp: ago(minutesAgo), silent: true });
  news(R, "**Vokko 0.4** is out: threads, forum channels and announcement follows.", 60 * 26);
  news(A, "The docs site now has a page for the gateway protocol. Feedback welcome in #dev-talk.", 60 * 5);

  // Forum channel.
  const forum = addChannel(guildId, { name: "support", type: ChannelType.GuildForum, parent_id: textCategory, topic: "Ask for help or share ideas. One post per topic." });
  forum.position = 5;
  initChannelFields(forum, {
    available_tags: [
      { name: "Question", emoji_name: "❓" },
      { name: "Bug", emoji_name: "🐛" },
      { name: "Feature", emoji_name: "💡" },
      { name: "Docs", emoji_name: "📖" },
      { name: "Solved", moderated: true, emoji_name: "✅" },
    ],
    default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
    default_forum_layout: ForumLayout.List,
    default_auto_archive_duration: 10080,
  });
  const tag = (name: string): string => forum.available_tags?.find(t => t.name === name)?.id ?? "";
  const post = (name: string, who: string, content: string, tags: string[], minutesAgo: number) =>
    createForumPost({ forum, name, author_id: who, content, tags: tags.map(tag), auto_archive_duration: 10080, now: ago(minutesAgo), silent: true });

  const guide = post("Read this before posting", R, "Search first, pick a tag, and keep one topic per post. Be kind.", [], 60 * 72);
  guide.thread.flags = ChannelFlags.Pinned;
  reply(guide.thread, A, "pinned for newcomers", 60 * 71);
  const loop = post("Gateway reconnect loop after resume", Bo, "After my laptop wakes up the client reconnects every second and never settles. Anything I can check?", ["Bug"], 60 * 20);
  reply(loop.thread, B, "which build? the backoff fix landed last week", 60 * 19);
  reply(loop.thread, Bo, "0.3.2, I'll update and report back", 60 * 18);
  reply(loop.thread, R, "if it still loops, attach the console log", 60 * 17);
  const tagQ = post("How do I change my server tag?", N, "I joined a server with a tag and I'd like to switch to another one. Where is that setting?", ["Question"], 60 * 9);
  reply(tagQ.thread, A, "User Settings, then Profiles, then Server Tag", 60 * 8);
  const contrast = post("Member list contrast in light theme", A, "The offline group header is hard to read on the light theme.", ["Bug", "Docs"], 60 * 4);
  reply(contrast.thread, R, "confirmed, will fix with the next token pass", 60 * 3);
  const idea = post("Idea: show joined threads under their channel", Bo, "Would be nice to see the threads I joined right in the channel list.", ["Feature"], 45);

  // Reactions on starter messages (forum cards show the top one). Sam has read the guide, the server tag question and the docs thread
  // (posts sam replied in are read by sending), so the newest post is the unread one.
  loop.message.reactions.push({ emoji: { id: null, name: "👍" }, user_ids: [A, B] });
  idea.message.reactions.push({ emoji: { id: null, name: "💡" }, user_ids: [N] }, { emoji: { id: null, name: "👍" }, user_ids: [A, B, N] });
  const sam = db.accounts.get(R);
  for (const t of [guide.thread, tagQ.thread, docs]) sam?.readStates.set(t.id, { channel_id: t.id, last_message_id: t.last_message_id, mention_count: 0 });
}

/** Populate an empty database. Safe to call once at module load. */
export function seed(): void {
  if (db.accounts.size > 0) return;
  const sam = createAccount({ username: "sam", global_name: "Sam", status: "online", bio: "Building Vokko.", banner_color: "#5b6cf0" });
  const carol = createAccount({ username: "carol", global_name: "Carol", status: "online", bio: "Server side of things.", banner_color: "#3ba55d" });
  const alice = createAccount({ username: "alice", global_name: "Alice", status: "online", custom_status: "Writing docs", banner_color: "#d1495b" });
  const bob = createAccount({ username: "bob", global_name: "Bob", status: "idle", banner_color: "#f4a259" });
  const nova = createAccount({ username: "nova", global_name: "Nova", status: "dnd", custom_status: "Heads down", banner_color: "#8e5bd9" });
  const R = sam.user.id;
  const B = carol.user.id;
  const A = alice.user.id;
  const Bo = bob.user.id;
  const N = nova.user.id;

  // A banned account (not a member) so the Bans page has a row.
  const spammer = createAccount({ username: "spambot", global_name: "Spam Bot", status: "offline" });

  // Relationships (from sam's side): three friends, one incoming request from nova.
  setRelationship(R, B, RelationshipType.Friend, RelationshipType.Friend);
  setRelationship(R, A, RelationshipType.Friend, RelationshipType.Friend);
  setRelationship(R, Bo, RelationshipType.Friend, RelationshipType.Friend);
  setRelationship(R, N, RelationshipType.IncomingRequest, RelationshipType.OutgoingRequest);
  setRelationship(B, A, RelationshipType.Friend, RelationshipType.Friend);

  // Guild
  const guildId = createGuildRecord(R, "Sam's server");
  const guild = db.guilds.get(guildId);
  if (!guild) return;
  const admin = nextId();
  const moderator = nextId();
  const member = nextId();
  guild.guild.roles.push(
    { id: admin, name: "Admin", color: 0xf0b232, hoist: true, position: 3, permissions: Perm.ADMINISTRATOR.toString(), mentionable: false },
    {
      id: moderator,
      name: "Moderator",
      color: 0x3ba55d,
      hoist: true,
      position: 2,
      permissions: (Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_MESSAGES | Perm.MANAGE_NICKNAMES | Perm.MANAGE_THREADS).toString(),
      mentionable: true,
    },
    { id: member, name: "Member", color: 0x5865f2, hoist: false, position: 1, permissions: "0", mentionable: false },
  );
  const joined = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  guild.members.set(R, { nick: null, roles: [admin], joined_at: joined });
  guild.members.set(A, { nick: null, roles: [moderator], joined_at: joined });
  guild.members.set(Bo, { nick: "Bobby", roles: [member], joined_at: joined });
  guild.members.set(N, { nick: null, roles: [member], joined_at: joined });
  guild.members.set(B, { nick: null, roles: [member], joined_at: joined });

  db.bans.set(guildId, new Map([[spammer.user.id, "Posting scam links"]]));

  // Demo stickers (generated artwork, no assets). The sticker picker groups them under the server.
  const sticker = (name: string, tags: string, description: string, hue: number): Sticker => ({
    id: nextId(),
    guild_id: guildId,
    name,
    description,
    tags,
    format_type: StickerFormat.PNG,
    url: svgDataUri(stickerSvg(name, hue)),
    available: true,
    user: sam.user,
  });
  db.stickers.set(guildId, [
    sticker("wave", "hello,hi,greeting", "A friendly wave", 210),
    sticker("party", "celebrate,confetti,yay", "Time to celebrate", 320),
    sticker("thumbs-up", "yes,approve,ok", "Looks good to me", 140),
  ]);

  const channels = [...db.channels.values()].filter(c => c.guild_id === guildId);
  const textCategory = channels.find(c => c.name === "Text Channels");
  const voiceCategory = channels.find(c => c.name === "Voice Channels");
  const general = channels.find(c => c.name === "general");
  const generalVoice = channels.find(c => c.name === "General" && c.type === ChannelType.GuildVoice);
  if (!textCategory || !voiceCategory || !general || !generalVoice) return;
  const info = addChannel(guildId, { name: "Info", type: ChannelType.GuildCategory });
  info.position = 0;
  textCategory.position = 1;
  voiceCategory.position = 2;
  const welcome = addChannel(guildId, { name: "welcome", type: ChannelType.GuildText, parent_id: info.id, topic: "Say hi and read the rules." });
  const announcements = addChannel(guildId, { name: "announcements", type: ChannelType.GuildAnnouncement, parent_id: info.id, topic: "Release notes and news." });
  // a standing invite, so the /invite/vokkodev page has something to show in mock mode
  db.invites.set("vokkodev", { code: "vokkodev", guild_id: guildId, channel_id: welcome.id, expires_at: null });
  // Private channel: hidden from @everyone, visible to Moderators (and the owner / admins).
  const staff = addChannel(guildId, {
    name: "staff",
    type: ChannelType.GuildText,
    parent_id: info.id,
    topic: "Moderators only.",
    permission_overwrites: [
      { id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() },
      { id: moderator, type: OverwriteType.Role, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" },
    ],
  });
  general.topic = "Chat about anything.";
  const random = addChannel(guildId, { name: "random", type: ChannelType.GuildText, parent_id: textCategory.id, topic: "Off-topic." });
  const devTalk = addChannel(guildId, { name: "dev-talk", type: ChannelType.GuildText, parent_id: textCategory.id, topic: "Rust, TypeScript and gateway protocol nerdery." });
  addChannel(guildId, { name: "memes", type: ChannelType.GuildText, parent_id: textCategory.id });
  const gaming = addChannel(guildId, { name: "Gaming", type: ChannelType.GuildVoice, parent_id: voiceCategory.id });
  // Already in voice when anyone signs in: Alice and Bob in General (the mock transport makes them "speak"), Nova in Gaming.
  // "Solo" (limit 1) is full, so the channel list shows its lock.
  seedVoiceState(A, generalVoice.id, 25);
  seedVoiceState(Bo, generalVoice.id, 12);
  seedVoiceState(N, gaming.id, 40);
  addChannel(guildId, { name: "AFK", type: ChannelType.GuildVoice, parent_id: voiceCategory.id });
  const solo = addChannel(guildId, { name: "Solo", type: ChannelType.GuildVoice, parent_id: voiceCategory.id, user_limit: 1 });
  seedVoiceState(B, solo.id, 5);

  const say = (channel: MockChannel, who: string, text: string, minutesAgo: number) =>
    addMessage({ channel, author_id: who, content: text, timestamp: Date.now() - minutesAgo * MIN, silent: true });

  say(staff, A, "reminder: spammers get banned on sight, no warnings", 60 * 24 * 2);
  say(staff, R, "agreed, invites are off for now", 60 * 24 * 2 - 5);
  say(welcome, R, "Welcome to **Sam's server**! Be kind, have fun.", 60 * 24 * 7);
  say(welcome, A, "Glad to be here 👋", 60 * 24 * 7 - 3);
  say(general, A, "morning everyone", 300);
  const morning = say(general, Bo, "morning ☕", 296);
  const docsQuestion = say(general, N, "has anyone looked at the new gateway docs?", 240);
  say(general, R, "yes, resume replays missed dispatches and ends with RESUMED", 235);
  say(general, A, `<@${R}> nice, I'll add that to the docs page`, 230);
  say(general, N, "thanks!", 229);
  const replayBuffer = say(general, B, "the replay buffer holds 500 events per session", 120);
  say(general, Bo, "that should be plenty", 118);
  say(devTalk, B, "pushed the migration for read states", 90);
  const g2 = say(devTalk, R, "```rust\nlet unread = channel.last_message_id > read.last_message_id;\n```", 80);
  say(devTalk, A, "does that handle channels with no read state yet?", 40);
  say(devTalk, B, "treats them as unread, like discord", 35);
  const r1 = say(random, Bo, "anyone up for a game tonight?", 200);
  say(random, N, `<@${R}> you in?`, 150);
  say(random, N, `<@${R}> I'm making popcorn 🍿`, 149);

  seedThreads({ general, announcements, guildId, textCategory: textCategory.id, docsQuestion, replayBuffer, morning, R, A, B, Bo, N });

  // Read states for sam: dev-talk partly unread, random has two mentions.
  const state = (channelId: string, last: string | null, mentions = 0) => sam.readStates.set(channelId, { channel_id: channelId, last_message_id: last, mention_count: mentions });
  const stockTalk = seedMessageShowcase({ guildId, parentId: textCategory.id, R, A, Bo, N, admin, sam: sam.user, bob: bob.user });
  for (const c of [welcome, general, stockTalk, announcements]) state(c.id, c.last_message_id);
  state(devTalk.id, g2.id);
  state(random.id, r1.id, 2);

  // DMs
  const dmCarol = openDM(R, B);
  addDmConversation(dmCarol, { R, B });
  sam.readStates.set(dmCarol.id, { channel_id: dmCarol.id, last_message_id: dmCarol.last_message_id, mention_count: 0 });

  const dmAlice = openDM(R, A);
  say(dmAlice, R, "can you review the docs PR when you have a minute?", 180);
  const a2 = say(dmAlice, A, "sure, looking now", 175);
  say(dmAlice, A, "left two comments, mostly nits", 25);
  sam.readStates.set(dmAlice.id, { channel_id: dmAlice.id, last_message_id: a2.id, mention_count: 0 });

  const dmBob = openDM(R, Bo);
  say(dmBob, Bo, "gg last night", 60 * 20);
  const b2 = say(dmBob, R, "gg, rematch soon", 60 * 20 - 2);
  sam.readStates.set(dmBob.id, { channel_id: dmBob.id, last_message_id: b2.id, mention_count: 0 });

  const group = openGroupDM(R, [N, Bo]);
  say(group, N, "movie night on friday?", 600);
  say(group, Bo, "I'm in", 590);
  const gl = say(group, R, "same, I'll bring snacks", 585);
  sam.readStates.set(group.id, { channel_id: group.id, last_message_id: gl.id, mention_count: 0 });
}
