import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { ChannelType, MessageType, RelationshipType, OverwriteType, StickerFormat, type Attachment, type Bookmark, type Gif, type GifCategories, type GifPage, type Message, type MessageSearchResponse, type Reminder, type Sticker } from "../types";
import { Perm } from "../permissions";
import { db, nextId } from "./db";
import { gifEmbeds } from "./gifs";
import { clearReminderTimers } from "./media";
import { addChannel, addMessage, createAccount, createGuildRecord, openDM } from "./ops";
import { handleRoute } from "./routes";
import { guildPayload, setRelationship } from "./views";

const ids: Record<string, string> = {};
let guildId = "";
let otherGuildId = "";
let general = "";

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};
const eventsOf = (t: string) => events.filter(e => e.t === t);

/** A pending upload owned by `who`, as POST /channels/{id}/attachments leaves it. */
function upload(who: string, init: Partial<Attachment> = {}): string {
  const attachment: Attachment = { id: nextId(), filename: "s.png", content_type: "image/png", size: 4096, url: "blob:sticker", width: 128, height: 128, ...init };
  db.pending.set(attachment.id, { attachment, owner: ids[who] ?? "" });
  return attachment.id;
}

const createSticker = (who: string, guild: string, name = "smile", extra: Record<string, unknown> = {}): Sticker =>
  call(who, "POST", `/guilds/${guild}/stickers`, { name, tags: "happy,face", attachment_id: upload(who), ...extra }) as Sticker;

const say = (who: string, channelId: string, content: string): Message => call(who, "POST", `/channels/${channelId}/messages`, { content }) as Message;

function addMember(guild: string, who: string): void {
  db.guilds.get(guild)!.members.set(ids[who]!, { nick: null, roles: [], joined_at: new Date().toISOString() });
}

beforeEach(() => {
  events.length = 0;
  clearReminderTimers();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.stickers, db.gifFavorites, db.bookmarks, db.mentionDismissals, db.reminders] as Map<string, unknown>[]) map.clear();
  db.gifProvider = "klipy";
  for (const name of ["owner", "member", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Media guild");
  addMember(guildId, "member");
  otherGuildId = createGuildRecord(ids.owner!, "Other guild");
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  events.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guild stickers", () => {
  it("creates, lists, edits and deletes a sticker and broadcasts the full list each time", () => {
    const sticker = createSticker("owner", guildId, "  smile ", { description: "A smile" });
    expect(sticker).toMatchObject({ guild_id: guildId, name: "smile", description: "A smile", tags: "happy,face", format_type: StickerFormat.PNG, available: true });
    expect(sticker.user?.id).toBe(ids.owner);
    const created = eventsOf("GUILD_STICKERS_UPDATE").at(-1);
    expect(created?.users.sort()).toEqual([ids.owner, ids.member].sort());
    expect((created?.d as { stickers: Sticker[] }).stickers.map(s => s.name)).toEqual(["smile"]);

    expect((call("member", "GET", `/guilds/${guildId}/stickers`) as Sticker[]).map(s => s.id)).toEqual([sticker.id]);
    expect((call("member", "GET", `/guilds/${guildId}/stickers/${sticker.id}`) as Sticker).name).toBe("smile");

    const edited = call("owner", "PATCH", `/guilds/${guildId}/stickers/${sticker.id}`, { name: "grin", description: null }) as Sticker;
    expect(edited).toMatchObject({ name: "grin", description: null, tags: "happy,face" });
    expect(((eventsOf("GUILD_STICKERS_UPDATE").at(-1)?.d as { stickers: Sticker[] }).stickers[0] ?? {}).name).toBe("grin");

    expect(call("owner", "DELETE", `/guilds/${guildId}/stickers/${sticker.id}`)).toBeUndefined();
    expect(call("owner", "GET", `/guilds/${guildId}/stickers`)).toEqual([]);
    expect((eventsOf("GUILD_STICKERS_UPDATE").at(-1)?.d as { stickers: Sticker[] }).stickers).toEqual([]);
    expect(errorOf(() => call("owner", "GET", `/guilds/${guildId}/stickers/${sticker.id}`))).toEqual({ status: 404, code: 10060 });
  });

  it("is members only, and permission rules follow MANAGE / CREATE_GUILD_EXPRESSIONS", () => {
    expect(errorOf(() => call("outsider", "GET", `/guilds/${guildId}/stickers`))).toEqual({ status: 403, code: 50001 });
    // Default @everyone has CREATE_GUILD_EXPRESSIONS: a member uploads, edits and deletes their own sticker only.
    const mine = createSticker("member", guildId, "mine");
    const owners = createSticker("owner", guildId, "owners");
    expect(call("member", "PATCH", `/guilds/${guildId}/stickers/${mine.id}`, { name: "mine2" })).toMatchObject({ name: "mine2" });
    expect(errorOf(() => call("member", "PATCH", `/guilds/${guildId}/stickers/${owners.id}`, { name: "nope" }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("member", "DELETE", `/guilds/${guildId}/stickers/${owners.id}`))).toEqual({ status: 403, code: 50013 });
    // The owner (all permissions) manages anybody's.
    expect(call("owner", "DELETE", `/guilds/${guildId}/stickers/${mine.id}`)).toBeUndefined();
    // Without CREATE_GUILD_EXPRESSIONS a member cannot upload.
    const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
    everyone.permissions = (BigInt(everyone.permissions) & ~Perm.CREATE_GUILD_EXPRESSIONS).toString();
    expect(errorOf(() => createSticker("member", guildId))).toEqual({ status: 403, code: 50013 });
    expect(db.stickers.get(guildId)).toHaveLength(1);
  });

  it("validates name, tags, format, size, dimensions and the 60 per server cap", () => {
    expect(errorOf(() => createSticker("owner", guildId, "x"))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => createSticker("owner", guildId, "ok", { tags: "a" }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => createSticker("owner", guildId, "ok", { description: "d".repeat(101) }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "ok", tags: "ok", attachment_id: upload("owner", { content_type: "image/svg+xml" }) }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "ok", tags: "ok", attachment_id: upload("owner", { size: 600 * 1024 }) }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "ok", tags: "ok", attachment_id: upload("owner", { width: 513 }) }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "ok", tags: "ok" }))).toEqual({ status: 400, code: 50035 });
    // someone else's upload is not usable
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "ok", tags: "ok", attachment_id: upload("member") }))).toEqual({ status: 400, code: 50035 });
    expect(call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "gif", tags: "ok", attachment_id: upload("owner", { content_type: "image/gif" }) })).toMatchObject({ format_type: StickerFormat.GIF });
    expect(call("owner", "POST", `/guilds/${guildId}/stickers`, { name: "web", tags: "ok", attachment_id: upload("owner", { content_type: "image/webp" }) })).toMatchObject({ format_type: StickerFormat.WebP });
    for (let i = 2; i < 60; i += 1) createSticker("owner", guildId, `sticker${i}`);
    expect(db.stickers.get(guildId)).toHaveLength(60);
    expect(errorOf(() => createSticker("owner", guildId, "one-too-many"))).toEqual({ status: 400, code: 30039 });
  });

  it("is part of the guild payload and is removed with the guild", () => {
    createSticker("owner", guildId, "inpayload");
    expect(guildPayload(guildId, ids.member!).stickers?.map(s => s.name)).toEqual(["inpayload"]);
    const gone = createSticker("owner", otherGuildId, "gone");
    expect(call("owner", "DELETE", `/guilds/${otherGuildId}`)).toBeUndefined();
    expect(db.stickers.get(otherGuildId)).toBeUndefined();
    expect(errorOf(() => call("owner", "GET", `/guilds/${otherGuildId}/stickers/${gone.id}`))).toEqual({ status: 404, code: 10004 });
  });
});

describe("sending stickers", () => {
  it("sends sticker-only messages in the own guild and keeps the copy after the sticker is deleted", () => {
    const sticker = createSticker("owner", guildId, "wave");
    const message = call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [sticker.id] }) as Message;
    expect(message.content).toBe("");
    expect(message.sticker_items).toEqual([{ id: sticker.id, name: "wave", format_type: StickerFormat.PNG, url: sticker.url }]);
    call("owner", "DELETE", `/guilds/${guildId}/stickers/${sticker.id}`);
    const history = call("member", "GET", `/channels/${general}/messages`) as Message[];
    expect(history[0]?.sticker_items?.[0]?.name).toBe("wave");
    expect(eventsOf("MESSAGE_CREATE").at(-1)?.d).toMatchObject({ sticker_items: [{ name: "wave" }] });
  });

  it("rejects unknown ids, more than 3 stickers and empty messages", () => {
    const sticker = createSticker("owner", guildId, "wave");
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, { sticker_ids: ["1"] }))).toEqual({ status: 400, code: 50035 });
    const four = [sticker.id, createSticker("owner", guildId, "two").id, createSticker("owner", guildId, "three").id, createSticker("owner", guildId, "four").id];
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, { sticker_ids: four }))).toEqual({ status: 400, code: 50035 });
    expect((call("owner", "POST", `/channels/${general}/messages`, { sticker_ids: four.slice(0, 3) }) as Message).sticker_items).toHaveLength(3);
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, { content: "  " }))).toEqual({ status: 400, code: 50035 });
  });

  it("uses a sticker of another server only as a member of it and with USE_EXTERNAL_STICKERS", () => {
    const foreign = createSticker("owner", otherGuildId, "foreign");
    // member is not in the other guild; the owner is
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [foreign.id] }))).toEqual({ status: 403, code: 50013 });
    addMember(otherGuildId, "member");
    expect((call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [foreign.id] }) as Message).sticker_items?.[0]?.name).toBe("foreign");
    // revoke USE_EXTERNAL_STICKERS from @everyone of the channel's guild
    const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
    everyone.permissions = (BigInt(everyone.permissions) & ~Perm.USE_EXTERNAL_STICKERS).toString();
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [foreign.id] }))).toEqual({ status: 403, code: 50013 });
    // a sticker of the channel's own server still works
    const own = createSticker("owner", guildId, "own");
    expect(call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [own.id] })).toMatchObject({ sticker_items: [{ name: "own" }] });
  });

  it("allows external stickers in DMs for a member of the sticker's server", () => {
    const foreign = createSticker("owner", otherGuildId, "foreign");
    addMember(otherGuildId, "member");
    setRelationship(ids.member!, ids.outsider!, RelationshipType.Friend, RelationshipType.Friend);
    const dm = openDM(ids.member!, ids.outsider!);
    expect(call("member", "POST", `/channels/${dm.id}/messages`, { sticker_ids: [foreign.id] })).toMatchObject({ sticker_items: [{ name: "foreign" }] });
  });

  it("has=sticker finds exactly the sticker messages", () => {
    const sticker = createSticker("owner", guildId, "wave");
    say("owner", general, "plain text");
    const withSticker = call("owner", "POST", `/channels/${general}/messages`, { sticker_ids: [sticker.id] }) as Message;
    const result = call("owner", "GET", `/guilds/${guildId}/messages/search?has=sticker`) as MessageSearchResponse;
    expect(result.messages.map(hit => hit[0]?.id)).toEqual([withSticker.id]);
  });
});

describe("GIF provider", () => {
  it("searches deterministically, pages with the next cursor and requires q", () => {
    const first = call("owner", "GET", "/gifs/search?q=cat&limit=24") as GifPage;
    expect(first.provider).toBe("klipy");
    expect(first.results).toHaveLength(24);
    expect(first.next).toBe("24");
    expect(first.results[0]).toMatchObject({ id: expect.stringMatching(/^klipy:/), url: expect.stringMatching(/^https:\/\/.*\.gif$/), preview_url: expect.stringMatching(/^data:image\/svg\+xml/) });
    expect(first.results[0]?.title).toContain("cat");
    expect(call("owner", "GET", "/gifs/search?q=cat&limit=24")).toEqual(first);
    const second = call("owner", "GET", "/gifs/search?q=cat&limit=24&pos=24") as GifPage;
    expect(second.results[0]?.id).not.toBe(first.results[0]?.id);
    const last = call("owner", "GET", "/gifs/search?q=cat&limit=50&pos=24") as GifPage;
    expect(last.results).toHaveLength(36);
    expect(last.next).toBeNull();
    expect(errorOf(() => call("owner", "GET", "/gifs/search"))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "GET", `/gifs/search?q=${"x".repeat(101)}`))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "GET", "/gifs/search?q=a&limit=51"))).toEqual({ status: 400, code: 50035 });
  });

  it("lists trending and categories, and answers empty with provider none", () => {
    expect((call("owner", "GET", "/gifs/trending") as GifPage).results.length).toBeGreaterThan(0);
    const categories = call("owner", "GET", "/gifs/categories") as GifCategories;
    expect(categories.categories.length).toBeGreaterThan(3);
    expect(categories.categories[0]).toMatchObject({ name: expect.any(String), image: expect.stringMatching(/^data:image/) });
    db.gifProvider = "none";
    expect(call("owner", "GET", "/gifs/search?q=cat")).toEqual({ provider: "none", results: [], next: null });
    expect(call("owner", "GET", "/gifs/trending")).toEqual({ provider: "none", results: [], next: null });
    expect(call("owner", "GET", "/gifs/categories")).toEqual({ provider: "none", categories: [] });
  });

  it("stores favourites per user, newest first, moves duplicates to the top and deletes by encoded id", () => {
    const [a, b] = (call("owner", "GET", "/gifs/trending?limit=2") as GifPage).results as [Gif, Gif];
    expect(call("owner", "GET", "/users/@me/gifs/favorites")).toEqual([]);
    expect(call("owner", "PUT", "/users/@me/gifs/favorites", a)).toEqual(a);
    call("owner", "PUT", "/users/@me/gifs/favorites", b);
    expect((call("owner", "GET", "/users/@me/gifs/favorites") as Gif[]).map(g => g.id)).toEqual([b.id, a.id]);
    call("owner", "PUT", "/users/@me/gifs/favorites", a);
    expect((call("owner", "GET", "/users/@me/gifs/favorites") as Gif[]).map(g => g.id)).toEqual([a.id, b.id]);
    expect(call("member", "GET", "/users/@me/gifs/favorites")).toEqual([]);
    expect(a.id).toContain(":");
    expect(call("owner", "DELETE", `/users/@me/gifs/favorites/${encodeURIComponent(a.id)}`)).toBeUndefined();
    expect((call("owner", "GET", "/users/@me/gifs/favorites") as Gif[]).map(g => g.id)).toEqual([b.id]);
    expect(errorOf(() => call("owner", "PUT", "/users/@me/gifs/favorites", { id: "x" }))).toEqual({ status: 400, code: 50035 });
  });

  it("unfurls a message whose content is a mock GIF url into an image embed", () => {
    const gif = (call("owner", "GET", "/gifs/search?q=wow&limit=1") as GifPage).results[0]!;
    const message = say("owner", general, gif.url);
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]).toMatchObject({ type: "image", url: gif.url, thumbnail: { url: expect.stringMatching(/^data:image\/svg\+xml/) } });
    expect(gifEmbeds("hello https://example.com")).toEqual([]);
    expect(say("owner", general, "just text").embeds).toEqual([]);
  });
});

describe("forward", () => {
  it("copies the source into a snapshot message and leaves it untouched when the source changes", () => {
    const sticker = createSticker("owner", guildId, "wave");
    const source = call("owner", "POST", `/channels/${general}/messages`, { content: "original *text*", sticker_ids: [sticker.id] }) as Message;
    const target = addChannel(guildId, { name: "target", type: ChannelType.GuildText });
    events.length = 0;
    const forwarded = call("member", "POST", `/channels/${target.id}/messages`, { message_reference: { type: 1, message_id: source.id, channel_id: general } }) as Message;
    expect(forwarded.content).toBe("");
    expect(forwarded.type).toBe(MessageType.Default);
    expect(forwarded.author.id).toBe(ids.member);
    expect(forwarded.message_reference).toEqual({ type: 1, message_id: source.id, channel_id: general, guild_id: guildId });
    expect(forwarded.message_snapshots).toHaveLength(1);
    expect(forwarded.message_snapshots?.[0]?.message).toMatchObject({ content: "original *text*", type: MessageType.Default, timestamp: source.timestamp, sticker_items: [{ name: "wave" }] });
    expect(eventsOf("MESSAGE_CREATE").at(-1)?.d).toMatchObject({ message_snapshots: [{ message: { content: "original *text*" } }] });

    call("owner", "PATCH", `/channels/${general}/messages/${source.id}`, { content: "edited" });
    call("owner", "DELETE", `/channels/${general}/messages/${source.id}`);
    const history = call("member", "GET", `/channels/${target.id}/messages`) as Message[];
    expect(history[0]?.message_snapshots?.[0]?.message.content).toBe("original *text*");
  });

  it("forwards attachments as copies (new ids) and into DMs", () => {
    const attachment: Attachment = { id: nextId(), filename: "a.png", content_type: "image/png", size: 10, url: "blob:a", width: 1, height: 1 };
    const channel = db.channels.get(general)!;
    const source = addMessage({ channel, author_id: ids.owner!, content: "see", attachments: [attachment] });
    setRelationship(ids.member!, ids.outsider!, RelationshipType.Friend, RelationshipType.Friend);
    const dm = openDM(ids.member!, ids.outsider!);
    const forwarded = call("member", "POST", `/channels/${dm.id}/messages`, { message_reference: { type: 1, message_id: source.id, channel_id: general } }) as Message;
    const copy = forwarded.message_snapshots?.[0]?.message.attachments[0];
    expect(copy).toMatchObject({ filename: "a.png", url: "blob:a" });
    expect(copy?.id).not.toBe(attachment.id);
  });

  it("never reveals a message in a channel the caller cannot read", () => {
    const secret = addChannel(guildId, {
      name: "secret",
      type: ChannelType.GuildText,
      permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }],
    });
    const hidden = addMessage({ channel: secret, author_id: ids.owner!, content: "top secret" });
    const forward = (id: string, channelId: string) => () => call("member", "POST", `/channels/${general}/messages`, { message_reference: { type: 1, message_id: id, channel_id: channelId } });
    // a real message in a hidden channel and a made-up id in it fail identically
    expect(errorOf(forward(hidden.id, secret.id))).toEqual({ status: 404, code: 10008 });
    expect(errorOf(forward("1", secret.id))).toEqual({ status: 404, code: 10008 });
    expect(sortedCount(general)).toBe(0);
    // a missing message in a readable channel
    expect(errorOf(forward("1", general))).toEqual({ status: 404, code: 10008 });
    // without READ_MESSAGE_HISTORY the channel is unreadable too
    const quiet = addChannel(guildId, {
      name: "quiet",
      type: ChannelType.GuildText,
      permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.READ_MESSAGE_HISTORY.toString() }],
    });
    const old = addMessage({ channel: quiet, author_id: ids.owner!, content: "old" });
    expect(errorOf(forward(old.id, quiet.id))).toEqual({ status: 404, code: 10008 });
    // an outsider (not in the guild) cannot forward from it either; friends, so the DM rule (checked first) lets them write
    setRelationship(ids.outsider!, ids.member!, RelationshipType.Friend, RelationshipType.Friend);
    expect(errorOf(() => call("outsider", "POST", `/channels/${openDM(ids.outsider!, ids.member!).id}/messages`, { message_reference: { type: 1, message_id: addMessage({ channel: db.channels.get(general)!, author_id: ids.owner!, content: "pub" }).id, channel_id: general } }))).toEqual({ status: 404, code: 10008 });
  });

  it("applies the target channel's rules: ATTACH_FILES for files, USE_EXTERNAL_STICKERS for stickers of other servers", () => {
    const attachment: Attachment = { id: nextId(), filename: "a.png", content_type: "image/png", size: 10, url: "blob:a", width: 1, height: 1 };
    const withFile = addMessage({ channel: db.channels.get(general)!, author_id: ids.owner!, content: "file", attachments: [attachment] });
    const textOnly = addMessage({ channel: db.channels.get(general)!, author_id: ids.owner!, content: "text" });
    const noFiles = addChannel(guildId, {
      name: "no-files",
      type: ChannelType.GuildText,
      permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.ATTACH_FILES.toString() }],
    });
    const forwardTo = (channelId: string, messageId: string) => () => call("member", "POST", `/channels/${channelId}/messages`, { message_reference: { type: 1, message_id: messageId, channel_id: general } });
    expect(errorOf(forwardTo(noFiles.id, withFile.id))).toEqual({ status: 403, code: 50013 });
    expect(sortedCount(noFiles.id)).toBe(0);
    expect(forwardTo(noFiles.id, textOnly.id)()).toMatchObject({ message_snapshots: [{ message: { content: "text" } }] });

    // a sticker of this server forwarded into another server's channel without USE_EXTERNAL_STICKERS
    const sticker = createSticker("owner", guildId, "wave");
    const stickerMessage = call("owner", "POST", `/channels/${general}/messages`, { sticker_ids: [sticker.id] }) as Message;
    addMember(otherGuildId, "member");
    const otherGeneral = [...db.channels.values()].find(c => c.guild_id === otherGuildId && c.name === "general")!;
    const everyone = db.guilds.get(otherGuildId)!.guild.roles.find(r => r.id === otherGuildId)!;
    everyone.permissions = (BigInt(everyone.permissions) & ~Perm.USE_EXTERNAL_STICKERS).toString();
    expect(errorOf(forwardTo(otherGeneral.id, stickerMessage.id))).toEqual({ status: 403, code: 50013 });
    expect(forwardTo(noFiles.id, stickerMessage.id)()).toMatchObject({ message_snapshots: [{ message: { sticker_items: [{ name: "wave" }] } }] });
  });

  it("requires an empty body, refuses system messages and copies a forward's snapshot, not the original", () => {
    const channel = db.channels.get(general)!;
    const source = addMessage({ channel, author_id: ids.owner!, content: "src" });
    const ref = { type: 1, message_id: source.id, channel_id: general };
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { content: "hi", message_reference: ref }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { attachment_ids: [upload("member")], message_reference: ref }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { sticker_ids: [createSticker("owner", guildId).id], message_reference: ref }))).toEqual({ status: 400, code: 50035 });
    const system = addMessage({ channel, author_id: ids.owner!, content: "", type: MessageType.UserJoin });
    expect(errorOf(() => call("member", "POST", `/channels/${general}/messages`, { message_reference: { ...ref, message_id: system.id } }))).toEqual({ status: 400, code: 50035 });

    const first = call("member", "POST", `/channels/${general}/messages`, { message_reference: ref }) as Message;
    const dm = openDM(ids.member!, ids.owner!);
    const second = call("member", "POST", `/channels/${dm.id}/messages`, { message_reference: { type: 1, message_id: first.id, channel_id: general } }) as Message;
    expect(second.message_reference?.message_id).toBe(first.id);
    expect(second.message_snapshots?.[0]?.message.content).toBe("src");
  });

  it("a plain reply is unaffected", () => {
    const source = say("owner", general, "question");
    const reply = call("member", "POST", `/channels/${general}/messages`, { content: "answer", message_reference: { message_id: source.id } }) as Message;
    expect(reply.type).toBe(MessageType.Reply);
    expect(reply.message_snapshots).toBeUndefined();
    expect(reply.referenced_message?.id).toBe(source.id);
  });
});

const sortedCount = (channelId: string): number => (db.messages.get(channelId) ?? []).length;

describe("bookmarks", () => {
  it("saves, lists newest first and removes, with events to the owner only", () => {
    const one = say("owner", general, "one");
    const two = say("owner", general, "two");
    events.length = 0;
    expect(call("member", "PUT", `/channels/${general}/messages/${one.id}/bookmark`)).toBeUndefined();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    expect(call("member", "PUT", `/channels/${general}/messages/${two.id}/bookmark`)).toBeUndefined();
    vi.useRealTimers();
    const added = eventsOf("BOOKMARK_ADD");
    expect(added).toHaveLength(2);
    expect(added[0]?.users).toEqual([ids.member]);
    expect((added[0]?.d as Bookmark).message.id).toBe(one.id);

    const page = call("member", "GET", "/users/@me/bookmarks") as { items: Bookmark[]; has_more: boolean };
    expect(page.items.map(b => b.message.content)).toEqual(["two", "one"]);
    expect(page.has_more).toBe(false);
    expect((call("member", "GET", "/users/@me/bookmarks?limit=1") as { items: Bookmark[]; has_more: boolean }).has_more).toBe(true);
    expect((call("owner", "GET", "/users/@me/bookmarks") as { items: Bookmark[] }).items).toEqual([]);

    // saving twice does not duplicate or re-emit
    call("member", "PUT", `/channels/${general}/messages/${one.id}/bookmark`);
    expect(eventsOf("BOOKMARK_ADD")).toHaveLength(2);

    call("member", "DELETE", `/channels/${general}/messages/${one.id}/bookmark`);
    expect(eventsOf("BOOKMARK_REMOVE")).toEqual([{ users: [ids.member], t: "BOOKMARK_REMOVE", d: { channel_id: general, message_id: one.id } }]);
    expect((call("member", "GET", "/users/@me/bookmarks") as { items: Bookmark[] }).items.map(b => b.message.content)).toEqual(["two"]);
    // removing something not saved is fine and silent
    expect(call("member", "DELETE", `/channels/${general}/messages/${one.id}/bookmark`)).toBeUndefined();
    expect(eventsOf("BOOKMARK_REMOVE")).toHaveLength(1);
  });

  it("needs read access, hides bookmarks the owner can no longer read and drops them with the message", () => {
    const secret = addChannel(guildId, {
      name: "secret",
      type: ChannelType.GuildText,
      permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }],
    });
    const hidden = addMessage({ channel: secret, author_id: ids.owner!, content: "hidden" });
    expect(errorOf(() => call("member", "PUT", `/channels/${secret.id}/messages/${hidden.id}/bookmark`))).toEqual({ status: 403, code: 50001 });
    expect(errorOf(() => call("member", "PUT", `/channels/${general}/messages/1/bookmark`))).toEqual({ status: 404, code: 10008 });

    const open = say("owner", general, "open");
    call("member", "PUT", `/channels/${general}/messages/${open.id}/bookmark`);
    // the member loses the channel: the bookmark is hidden, not deleted
    const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
    const general_ = db.channels.get(general)!;
    general_.permission_overwrites = [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }];
    expect(everyone).toBeDefined();
    expect((call("member", "GET", "/users/@me/bookmarks") as { items: Bookmark[] }).items).toEqual([]);
    expect(db.bookmarks.get(ids.member!)?.size).toBe(1);
    general_.permission_overwrites = [];
    expect((call("member", "GET", "/users/@me/bookmarks") as { items: Bookmark[] }).items).toHaveLength(1);

    events.length = 0;
    call("owner", "DELETE", `/channels/${general}/messages/${open.id}`);
    expect((call("member", "GET", "/users/@me/bookmarks") as { items: Bookmark[] }).items).toEqual([]);
    expect(eventsOf("BOOKMARK_REMOVE")).toHaveLength(1);
  });

  it("caps at 250 with code 30090", () => {
    const channel = db.channels.get(general)!;
    const list: { id: string }[] = [];
    for (let i = 0; i < 251; i += 1) list.push(addMessage({ channel, author_id: ids.owner!, content: `m${i}`, silent: true }));
    for (const m of list.slice(0, 250)) call("member", "PUT", `/channels/${general}/messages/${m.id}/bookmark`);
    expect(errorOf(() => call("member", "PUT", `/channels/${general}/messages/${list[250]!.id}/bookmark`))).toEqual({ status: 400, code: 30090 });
  });
});

describe("recent mentions", () => {
  it("lists direct, role and @everyone mentions newest first, filters them and forgets dismissed ones", () => {
    db.guilds.get(guildId)!.members.get(ids.member!)!.roles = ["77"];
    const direct = say("owner", general, `hi <@${ids.member}>`);
    say("owner", general, "nothing");
    const role = say("owner", general, "<@&77> read this");
    const everyone = say("owner", general, "@everyone meeting");
    say("member", general, `me <@${ids.member}>`);
    const list = (q = "") => (call("member", "GET", `/users/@me/mentions${q}`) as Message[]).map(m => m.id);
    expect(list()).toEqual([everyone.id, role.id, direct.id]);
    expect(list("?everyone=false&roles=false")).toEqual([direct.id]);
    expect(list(`?before=${everyone.id}&limit=1`)).toEqual([role.id]);
    expect(list(`?guild_id=${otherGuildId}`)).toEqual([]);
    expect(call("member", "DELETE", `/users/@me/mentions/${role.id}`)).toBeUndefined();
    expect(list()).toEqual([everyone.id, direct.id]);
    expect(errorOf(() => call("member", "GET", "/users/@me/mentions?limit=0"))).toEqual({ status: 400, code: 50035 });
    // losing the channel hides them
    db.channels.get(general)!.permission_overwrites = [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }];
    expect(list()).toEqual([]);
  });
});

describe("reminders", () => {
  const HOUR = 3600_000;

  it("creates a reminder, lists it with its message and fires REMINDER_DUE exactly once at remind_at", () => {
    vi.useFakeTimers();
    const message = say("owner", general, "remember me");
    const remindAt = new Date(Date.now() + HOUR).toISOString();
    const created = call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: remindAt }) as Reminder;
    expect(created).toMatchObject({ channel_id: general, message_id: message.id, guild_id: guildId, remind_at: remindAt, delivered_at: null });
    expect(created.message?.content).toBe("remember me");
    expect(eventsOf("REMINDER_CREATE")).toHaveLength(1);
    expect(eventsOf("REMINDER_CREATE")[0]?.users).toEqual([ids.member]);

    vi.advanceTimersByTime(HOUR - 1000);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    const due = eventsOf("REMINDER_DUE");
    expect(due).toHaveLength(1);
    expect(due[0]?.users).toEqual([ids.member]);
    expect((due[0]?.d as Reminder).id).toBe(created.id);
    expect((due[0]?.d as Reminder).delivered_at).not.toBeNull();
    vi.advanceTimersByTime(10 * HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(1);

    // delivered reminders stay listed until dismissed
    const listed = call("member", "GET", "/users/@me/reminders") as Reminder[];
    expect(listed.map(r => r.id)).toEqual([created.id]);
    expect(listed[0]?.delivered_at).not.toBeNull();
    expect(call("owner", "GET", "/users/@me/reminders")).toEqual([]);
    expect(call("member", "DELETE", `/users/@me/reminders/${created.id}`)).toBeUndefined();
    expect(eventsOf("REMINDER_DELETE")).toEqual([{ users: [ids.member], t: "REMINDER_DELETE", d: { id: created.id } }]);
    expect(call("member", "GET", "/users/@me/reminders")).toEqual([]);
  });

  it("moves and rearms the reminder of the same message, and a cancelled one never fires", () => {
    vi.useFakeTimers();
    const message = say("owner", general, "x");
    const first = call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: new Date(Date.now() + HOUR).toISOString() }) as Reminder;
    const moved = call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: new Date(Date.now() + 3 * HOUR).toISOString() }) as Reminder;
    expect(moved.id).toBe(first.id);
    expect(call("member", "GET", "/users/@me/reminders")).toHaveLength(1);
    vi.advanceTimersByTime(2 * HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(0);
    vi.advanceTimersByTime(HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(1);
    // moving a delivered reminder rearms it
    call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: new Date(Date.now() + HOUR).toISOString() });
    expect((call("member", "GET", "/users/@me/reminders") as Reminder[])[0]?.delivered_at).toBeNull();
    const other = say("owner", general, "y");
    const cancelled = call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: other.id, remind_at: new Date(Date.now() + HOUR).toISOString() }) as Reminder;
    call("member", "DELETE", `/users/@me/reminders/${cancelled.id}`);
    vi.advanceTimersByTime(2 * HOUR);
    expect(eventsOf("REMINDER_DUE").filter(e => (e.d as Reminder).id === cancelled.id)).toHaveLength(0);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(2);
  });

  it("waits out delays longer than the timer limit", () => {
    vi.useFakeTimers();
    const message = say("owner", general, "far");
    const days = 40;
    call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: new Date(Date.now() + days * 24 * HOUR).toISOString() });
    vi.advanceTimersByTime((days - 1) * 24 * HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(0);
    vi.advanceTimersByTime(24 * HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(1);
  });

  it("lists by remind_at ascending, validates the time and the message, and caps pending reminders at 50", () => {
    vi.useFakeTimers();
    const a = say("owner", general, "a");
    const b = say("owner", general, "b");
    call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: a.id, remind_at: new Date(Date.now() + 2 * HOUR).toISOString() });
    call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: b.id, remind_at: new Date(Date.now() + HOUR).toISOString() });
    expect((call("member", "GET", "/users/@me/reminders") as Reminder[]).map(r => r.message?.content)).toEqual(["b", "a"]);
    const body = (extra: Record<string, unknown>) => () => call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: a.id, ...extra });
    expect(errorOf(body({ remind_at: new Date(Date.now() - 1000).toISOString() }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(body({ remind_at: "soon" }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(body({ remind_at: new Date(Date.now() + 400 * 24 * HOUR).toISOString() }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: "1", remind_at: new Date(Date.now() + HOUR).toISOString() }))).toEqual({ status: 404, code: 10008 });
    const channel = db.channels.get(general)!;
    for (let i = 0; i < 48; i += 1) {
      const m = addMessage({ channel, author_id: ids.owner!, content: `r${i}`, silent: true });
      call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: m.id, remind_at: new Date(Date.now() + HOUR).toISOString() });
    }
    const extra = addMessage({ channel, author_id: ids.owner!, content: "extra", silent: true });
    expect(errorOf(() => call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: extra.id, remind_at: new Date(Date.now() + HOUR).toISOString() }))).toEqual({ status: 400, code: 30091 });
  });

  it("reports message null when the owner can no longer read it, and deleting the message removes the reminder", () => {
    vi.useFakeTimers();
    const message = say("owner", general, "private later");
    const reminder = call("member", "POST", "/users/@me/reminders", { channel_id: general, message_id: message.id, remind_at: new Date(Date.now() + HOUR).toISOString() }) as Reminder;
    const channel = db.channels.get(general)!;
    channel.permission_overwrites = [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }];
    expect((call("member", "GET", "/users/@me/reminders") as Reminder[])[0]?.message).toBeNull();
    channel.permission_overwrites = [];
    events.length = 0;
    call("owner", "DELETE", `/channels/${general}/messages/${message.id}`);
    expect(call("member", "GET", "/users/@me/reminders")).toEqual([]);
    expect(eventsOf("REMINDER_DELETE")).toEqual([{ users: [ids.member], t: "REMINDER_DELETE", d: { id: reminder.id } }]);
    vi.advanceTimersByTime(2 * HOUR);
    expect(eventsOf("REMINDER_DUE")).toHaveLength(0);
  });
});
