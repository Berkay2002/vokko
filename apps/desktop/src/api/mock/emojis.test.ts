import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { Perm } from "../permissions";
import { ChannelType, type GatewayEvents, type GuildEmoji, type Message } from "../types";
import { db, nextId } from "./db";
import { addChannel, addMessage, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { guildPayload } from "./views";

const ids: Record<string, string> = {};
let guildId = "";
let channelId = "";

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

function pending(owner: string, contentType: string, size = 1000): string {
  const id = nextId();
  db.pending.set(id, { attachment: { id, filename: "e", content_type: contentType, size, url: `blob:${id}`, width: 32, height: 32 }, owner: ids[owner]! });
  return id;
}

const create = (who: string, name: string, type = "image/png", roles?: string[]) =>
  call(who, "POST", `/guilds/${guildId}/emojis`, { name, image_attachment_id: pending(who, type), ...(roles ? { roles } : {}) }) as GuildEmoji;

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.emojis] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "member", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Emoji guild");
  db.guilds.get(guildId)!.members.set(ids.member!, { nick: null, roles: [], joined_at: new Date().toISOString() });
  channelId = addChannel(guildId, { name: "chat", type: ChannelType.GuildText }).id;
  events.length = 0;
});

describe("mock custom emoji routes", () => {
  it("creates, lists, edits and deletes with MANAGE_GUILD_EXPRESSIONS and fans out GUILD_EMOJIS_UPDATE", () => {
    expect(errorOf(() => create("member", "nope"))).toEqual({ status: 403, code: 50013 });
    const emoji = create("owner", "blob_wave");
    expect(emoji).toMatchObject({ name: "blob_wave", animated: false, roles: [], require_colons: true, available: true, user: { username: "owner" } });
    const update = events.find(e => e.t === "GUILD_EMOJIS_UPDATE")!;
    expect(update.users.sort()).toEqual([ids.owner, ids.member].sort());
    expect((update.d as GatewayEvents["GUILD_EMOJIS_UPDATE"]).emojis[0]).not.toHaveProperty("user");

    expect((call("member", "GET", `/guilds/${guildId}/emojis`) as GuildEmoji[]).map(e => e.name)).toEqual(["blob_wave"]);
    expect(errorOf(() => call("outsider", "GET", `/guilds/${guildId}/emojis`))).toEqual({ status: 403, code: 50001 });
    expect(guildPayload(guildId, ids.member!).emojis?.map(e => e.name)).toEqual(["blob_wave"]);

    const renamed = call("owner", "PATCH", `/guilds/${guildId}/emojis/${emoji.id}`, { name: "wave" }) as GuildEmoji;
    expect(renamed.name).toBe("wave");
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/emojis/${emoji.id}`, { name: "w" }))).toEqual({ status: 400, code: 50035 });
    call("owner", "DELETE", `/guilds/${guildId}/emojis/${emoji.id}`);
    expect(errorOf(() => call("owner", "GET", `/guilds/${guildId}/emojis/${emoji.id}`))).toEqual({ status: 404, code: 10014 });
    expect(events.filter(e => e.t === "GUILD_EMOJIS_UPDATE")).toHaveLength(3);
    expect(guildPayload(guildId, ids.member!).emojis).toBeUndefined();
  });

  it("rejects bad files, names and roles and caps each kind at 250", () => {
    expect(errorOf(() => create("owner", "photo", "image/jpeg"))).toEqual({ status: 400, code: 50035 });
    const big = pending("owner", "image/png", 256 * 1024 + 1);
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/emojis`, { name: "big", image_attachment_id: big }))).toEqual({ status: 400, code: 50035 });
    for (const name of ["a", "with-dash", "x".repeat(33)]) expect(errorOf(() => create("owner", name))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => create("owner", "everyone", "image/png", [guildId]))).toEqual({ status: 400, code: 50035 });
    for (let i = 0; i < 250; i += 1) create("owner", `still_${i}`);
    expect(errorOf(() => create("owner", "one_more"))).toEqual({ status: 400, code: 30008 });
    expect(create("owner", "dancing", "image/gif").animated).toBe(true);
  });
});

describe("mock reactions with custom emoji", () => {
  it("needs the emoji to exist, membership of its guild and one of its roles", () => {
    const role = nextId();
    const guild = db.guilds.get(guildId)!;
    guild.guild.roles.push({ id: role, name: "vip", color: 0, hoist: false, position: 1, permissions: "0", mentionable: false });
    const open = create("owner", "party", "image/gif");
    const vip = create("owner", "vip", "image/png", [role]);
    const message = addMessage({ channel: db.channels.get(channelId)!, author_id: ids.owner!, content: "hi" });
    const react = (who: string, emoji: string) => call(who, "PUT", `/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`);

    expect(errorOf(() => react("member", "ghost:42"))).toEqual({ status: 400, code: 10014 });
    expect(errorOf(() => react("member", `vip:${vip.id}`))).toEqual({ status: 403, code: 50013 });
    react("member", `any_name:${open.id}`);
    guild.members.get(ids.member!)!.roles.push(role);
    react("member", `vip:${vip.id}`);
    const added = events.filter(e => e.t === "MESSAGE_REACTION_ADD").map(e => (e.d as GatewayEvents["MESSAGE_REACTION_ADD"]).emoji);
    expect(added).toEqual([{ id: open.id, name: "party", animated: true }, { id: vip.id, name: "vip", animated: false }]);

    // another guild's emoji: fine for a member with USE_EXTERNAL_EMOJIS, refused without it, and for non-members
    const other = createGuildRecord(createAccount({ username: "host" }).user.id, "Elsewhere");
    for (const who of ["member", "outsider"]) db.guilds.get(other)!.members.set(ids[who]!, { nick: null, roles: [], joined_at: new Date().toISOString() });
    const there = addChannel(other, { name: "there", type: ChannelType.GuildText });
    const remote = addMessage({ channel: there, author_id: ids.member!, content: "yo" });
    const reactThere = (who: string) => call(who, "PUT", `/channels/${there.id}/messages/${remote.id}/reactions/${encodeURIComponent(`party:${open.id}`)}/@me`);
    reactThere("member");
    expect(errorOf(() => reactThere("outsider"))).toEqual({ status: 403, code: 50013 });
    const everyone = db.guilds.get(other)!.guild.roles.find(r => r.id === other)!;
    everyone.permissions = (BigInt(everyone.permissions) & ~Perm.USE_EXTERNAL_EMOJIS).toString();
    call("member", "DELETE", `/channels/${there.id}/messages/${remote.id}/reactions/${encodeURIComponent(`x:${open.id}`)}/@me`);
    expect(errorOf(() => reactThere("member"))).toEqual({ status: 403, code: 50013 });

    const [listed] = call("member", "GET", `/channels/${channelId}/messages?limit=1`) as Message[];
    expect(listed!.reactions).toEqual([
      { emoji: { id: open.id, name: "party", animated: true }, count: 1, me: true },
      { emoji: { id: vip.id, name: "vip", animated: false }, count: 1, me: true },
    ]);
  });
});
