import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { Perm, parseBits } from "../permissions";
import { MessageFlags, MessageType, type ApplicationCommand, type ApplicationCommandIndex, type ApplicationWithToken, type Interaction, type Message, type Webhook } from "../types";
import { apps } from "./apps";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
let general = "";

const call = (who: string | null, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, who ? (ids[who] ?? null) : null);
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

function grantCommandsToEveryone(): void {
  const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
  everyone.permissions = (parseBits(everyone.permissions) | Perm.USE_APPLICATION_COMMANDS).toString();
}

function setupBot(): { app: ApplicationWithToken; commands: ApplicationCommand[] } {
  const app = call("owner", "POST", "/applications", { name: "Echo" }) as ApplicationWithToken;
  call("owner", "POST", `/oauth2/authorize?client_id=${app.id}`, { guild_id: guildId, permissions: "3072" });
  const commands = call("owner", "PUT", `/applications/${app.id}/commands`, [
    { name: "echo", description: "Repeat", options: [{ type: 3, name: "text", description: "Text", required: true }] },
    { name: "Wave at", type: 2 },
  ]) as ApplicationCommand[];
  return { app, commands };
}

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.followers] as Map<string, unknown>[]) map.clear();
  for (const map of Object.values(apps) as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "mod", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  const guild = db.guilds.get(guildId)!;
  guild.guild.roles.push({ id: "9002", name: "mod", color: 0, hoist: false, position: 2, permissions: Perm.MANAGE_WEBHOOKS.toString(), mentionable: false });
  const joined = new Date().toISOString();
  guild.members.set(ids.mod!, { nick: null, roles: ["9002"], joined_at: joined });
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  events.length = 0;
});

describe("applications and commands", () => {
  it("adds the bot through authorize with a role, and only shows commands to members with USE_APPLICATION_COMMANDS", () => {
    const { app } = setupBot();
    expect(db.guilds.get(guildId)!.members.has(app.id)).toBe(true);
    expect(eventsOf("GUILD_MEMBER_ADD").some(e => (e.d as { user: { id: string } }).user.id === app.id)).toBe(true);
    expect(errorOf(() => call("plain", "POST", `/oauth2/authorize?client_id=${app.id}`, { guild_id: guildId }))).toEqual({ status: 403, code: 50013 });
    const hidden = call("plain", "GET", `/channels/${general}/application-commands`) as ApplicationCommandIndex;
    expect(hidden.application_commands).toEqual([]);
    grantCommandsToEveryone();
    const index = call("plain", "GET", `/channels/${general}/application-commands`) as ApplicationCommandIndex;
    expect(index.application_commands.map(c => c.name).sort()).toEqual(["Wave at", "echo"]);
    expect(index.applications).toEqual([{ id: app.id, name: "Echo", icon: null, bot_id: app.id }]);
    expect(errorOf(() => call("owner", "POST", `/applications/${app.id}/commands`, { name: "Bad Name", description: "x" }))).toEqual({ status: 400, code: 50035 });
  });
});

describe("interactions", () => {
  it("delivers INTERACTION_CREATE to the bot and keeps an ephemeral answer away from everyone else", () => {
    const { app, commands } = setupBot();
    grantCommandsToEveryone();
    const echo = commands.find(c => c.name === "echo")!;
    expect(errorOf(() => call("plain", "POST", "/interactions", { type: 2, application_id: app.id, channel_id: general, data: { id: echo.id, name: "echo", type: 1 } }))).toEqual({ status: 400, code: 50035 });
    call("plain", "POST", "/interactions", { type: 2, application_id: app.id, channel_id: general, nonce: "n", data: { id: echo.id, name: "echo", type: 1, options: [{ name: "text", type: 3, value: "secret" }] } });
    const created = eventsOf("INTERACTION_CREATE")[0]!;
    expect(created.users).toEqual([app.id]);
    const interaction = created.d as Interaction;
    expect(interaction.data.options?.[0]?.value).toBe("secret");
    events.length = 0;
    call(null, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 4, data: { content: "only you", flags: MessageFlags.Ephemeral } });
    const sent = eventsOf("MESSAGE_CREATE");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.users).toEqual([ids.plain]);
    const message = sent[0]!.d as Message;
    expect(message).toMatchObject({ type: MessageType.ChatInputCommand, flags: MessageFlags.Ephemeral, interaction_metadata: { name: "echo", user: { id: ids.plain } } });
    expect(errorOf(() => call(null, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 4, data: { content: "again" } }))).toEqual({ status: 400, code: 40060 });
    expect((call("plain", "GET", `/channels/${general}/messages`) as Message[]).some(m => m.id === message.id)).toBe(true);
    expect((call("other", "GET", `/channels/${general}/messages`) as Message[]).some(m => m.id === message.id)).toBe(false);
    expect(errorOf(() => call("other", "DELETE", `/channels/${general}/messages/${message.id}`))).toEqual({ status: 404, code: 10008 });
    events.length = 0;
    call("plain", "DELETE", `/channels/${general}/messages/${message.id}`);
    expect(eventsOf("MESSAGE_DELETE").map(e => e.users)).toEqual([[ids.plain]]);
    expect((call("plain", "GET", `/channels/${general}/messages`) as Message[]).some(m => m.id === message.id)).toBe(false);
  });

  it("needs a channel the caller may send in, like the server: a category, a forum or a locked thread is refused", () => {
    const { app, commands } = setupBot();
    grantCommandsToEveryone();
    const echo = commands.find(c => c.name === "echo")!;
    const invoke = (who: string, channel_id: string) => () =>
      call(who, "POST", "/interactions", { type: 2, application_id: app.id, channel_id, data: { id: echo.id, name: "echo", type: 1, options: [{ name: "text", type: 3, value: "x" }] } });
    const category = (call("owner", "POST", `/guilds/${guildId}/channels`, { name: "cat", type: 4 }) as { id: string }).id;
    const forum = (call("owner", "POST", `/guilds/${guildId}/channels`, { name: "forum", type: 15 }) as { id: string }).id;
    const thread = (call("owner", "POST", `/channels/${general}/threads`, { name: "t", type: 11 }) as { id: string }).id;
    call("owner", "PATCH", `/channels/${thread}`, { locked: true });
    expect(errorOf(invoke("plain", category))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(invoke("plain", forum))).toEqual({ status: 400, code: 50024 });
    expect(errorOf(invoke("plain", thread))).toEqual({ status: 403, code: 160005 });
    invoke("owner", thread)();
  });

  it("a public answer and a followup go to the channel; an unanswered interaction fails after 3 s", () => {
    vi.useFakeTimers();
    try {
      const { app, commands } = setupBot();
      grantCommandsToEveryone();
      const wave = commands.find(c => c.name === "Wave at")!;
      call("plain", "POST", "/interactions", { type: 2, application_id: app.id, channel_id: general, data: { id: wave.id, name: "Wave at", type: 2, target_id: ids.other } });
      const interaction = eventsOf("INTERACTION_CREATE")[0]!.d as Interaction;
      expect(interaction.data.resolved?.users?.[ids.other!]?.username).toBe("other");
      call(null, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 4, data: { content: "👋" } });
      const answer = eventsOf("MESSAGE_CREATE").map(e => e.d as Message).find(m => m.content === "👋")!;
      expect(answer).toMatchObject({ type: MessageType.ContextMenuCommand, interaction_metadata: { target_user: { id: ids.other } } });
      expect(eventsOf("MESSAGE_CREATE").filter(e => (e.d as Message).id === answer.id).flatMap(e => e.users)).toEqual(expect.arrayContaining([ids.plain!, ids.other!]));
      const followup = call(null, "POST", `/webhooks/${app.id}/${interaction.token}`, { content: "and more" }) as Message;
      expect(followup.application_id).toBe(app.id);
      events.length = 0;
      call("plain", "POST", "/interactions", { type: 2, application_id: app.id, channel_id: general, nonce: "late", data: { id: wave.id, name: "Wave at", type: 2, target_id: ids.other } });
      vi.advanceTimersByTime(3100);
      expect(eventsOf("INTERACTION_FAILURE")).toEqual([{ users: [ids.plain], t: "INTERACTION_FAILURE", d: expect.objectContaining({ nonce: "late" }) }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("message components", () => {
  const go = { type: 2, style: 1, label: "Go", custom_id: "go" };
  const pick = { type: 3, custom_id: "pick", placeholder: "Pick", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] };
  const rows = [{ type: 1, components: [go, { type: 2, style: 5, label: "Docs", url: " https://Example.com/a b" }] }, { type: 1, components: [pick] }];

  /** The bot answers a /echo run with `components`; returns the app, the interaction of the run and the posted message. */
  function postWithComponents(components: unknown): { app: ApplicationWithToken; interaction: Interaction; message: Message } {
    const { app, commands } = setupBot();
    grantCommandsToEveryone();
    const echo = commands.find(c => c.name === "echo")!;
    call("plain", "POST", "/interactions", { type: 2, application_id: app.id, channel_id: general, data: { id: echo.id, name: "echo", type: 1, options: [{ name: "text", type: 3, value: "x" }] } });
    const interaction = eventsOf("INTERACTION_CREATE")[0]!.d as Interaction;
    events.length = 0;
    call(null, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 4, data: { content: "Ready?", components } });
    return { app, interaction, message: eventsOf("MESSAGE_CREATE").map(e => e.d as Message).find(m => m.content === "Ready?")! };
  }

  const click = (app: ApplicationWithToken, message: Message, data: unknown, who = "plain") =>
    call(who, "POST", "/interactions", { type: 3, application_id: app.id, channel_id: general, message_id: message.id, nonce: "c1", data });

  it("validates components like the server and stores link URLs parsed", () => {
    const { message } = postWithComponents(rows);
    expect(message.components?.[0]?.components?.[1]?.url).toBe("https://example.com/a%20b");
    expect(message.components?.[1]?.components?.[0]).toMatchObject({ type: 3, min_values: 1, max_values: 1 });
    const { interaction } = postWithComponents([]);
    const post = (components: unknown) => errorOf(() => call(null, "POST", `/webhooks/${interaction.application_id}/${interaction.token}`, { content: "x", components }));
    const invalid = { status: 400, code: 50035 };
    expect(post([{ type: 1, components: [{ ...go, style: 5, url: "http://example.com" }] }])).toEqual(invalid);
    expect(post([{ type: 1, components: [{ ...go, style: 5, custom_id: undefined, url: "https://" }] }])).toEqual(invalid);
    expect(post([{ type: 1, components: [go, go] }])).toEqual(invalid);
    expect(post([{ type: 1, components: [{ ...go, label: "x".repeat(81) }] }])).toEqual(invalid);
    expect(post([{ type: 1, components: [{ ...go, custom_id: "x".repeat(101) }] }])).toEqual(invalid);
    expect(post(Array.from({ length: 6 }, (_, i) => ({ type: 1, components: [{ ...go, custom_id: `b${i}` }] })))).toEqual(invalid);
    expect(post([{ type: 1, components: Array.from({ length: 6 }, (_, i) => ({ ...go, custom_id: `b${i}` })) }])).toEqual(invalid);
    expect(post([{ type: 1, components: [pick, go] }])).toEqual(invalid);
    expect(post([{ type: 1, components: [{ ...go, emoji: { name: "x".repeat(33) } }] }])).toEqual(invalid);
  });

  it("relays a click to the app and answers with an update (7), an acknowledgement (6) or a message (4)", () => {
    const { app, message } = postWithComponents(rows);
    events.length = 0;
    expect(click(app, message, { custom_id: "go", component_type: 2 })).toMatchObject({ nonce: "c1" });
    const created = eventsOf("INTERACTION_CREATE")[0]!;
    expect(created.users).toEqual([app.id]);
    const interaction = created.d as Interaction;
    expect(interaction).toMatchObject({ type: 3, data: { custom_id: "go", component_type: 2 }, message: { id: message.id } });
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;

    events.length = 0;
    call(null, "POST", callback, { type: 7, data: { content: "Done" } });
    const updated = eventsOf("MESSAGE_UPDATE").map(e => e.d as Message).find(m => m.id === message.id)!;
    expect(updated.content).toBe("Done");
    expect(updated.components).toHaveLength(2);
    expect(eventsOf("INTERACTION_SUCCESS")).toEqual([{ users: [ids.plain], t: "INTERACTION_SUCCESS", d: expect.objectContaining({ id: interaction.id, nonce: "c1" }) }]);
    expect(errorOf(() => call(null, "POST", callback, { type: 6 }))).toEqual({ status: 400, code: 40060 });

    // a select needs exactly one of its options; type 7 may remove the components
    expect(errorOf(() => click(app, message, { custom_id: "pick", component_type: 3, values: ["zzz"] }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => click(app, message, { custom_id: "go", component_type: 2, values: ["a"] }))).toEqual({ status: 400, code: 50035 });
    events.length = 0;
    click(app, message, { custom_id: "pick", component_type: 3, values: ["b"] });
    const picked = eventsOf("INTERACTION_CREATE")[0]!.d as Interaction;
    expect(picked.data.values).toEqual(["b"]);
    events.length = 0;
    call(null, "POST", `/interactions/${picked.id}/${picked.token}/callback`, { type: 7, data: { components: [] } });
    expect((eventsOf("MESSAGE_UPDATE")[0]!.d as Message).components).toEqual([]);
    expect(errorOf(() => click(app, message, { custom_id: "go", component_type: 2 }))).toEqual({ status: 400, code: 50035 });
  });

  it("answers 6 without a change, 4 with a plain message, refuses 6 and 7 for commands, and fails a silent click", () => {
    vi.useFakeTimers();
    try {
      const { app, interaction, message } = postWithComponents(rows);
      expect(errorOf(() => call(null, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 7, data: { content: "no" } }))).toEqual({ status: 400, code: 50035 });
      events.length = 0;
      click(app, message, { custom_id: "go", component_type: 2 });
      const first = eventsOf("INTERACTION_CREATE")[0]!.d as Interaction;
      events.length = 0;
      call(null, "POST", `/interactions/${first.id}/${first.token}/callback`, { type: 6 });
      expect(eventsOf("MESSAGE_UPDATE")).toEqual([]);
      expect(eventsOf("INTERACTION_SUCCESS")).toHaveLength(1);

      click(app, message, { custom_id: "go", component_type: 2 });
      const second = eventsOf("INTERACTION_CREATE").at(-1)!.d as Interaction;
      events.length = 0;
      call(null, "POST", `/interactions/${second.id}/${second.token}/callback`, { type: 4, data: { content: "Thanks" } });
      const reply = eventsOf("MESSAGE_CREATE").map(e => e.d as Message).find(m => m.content === "Thanks")!;
      expect(reply).toMatchObject({ type: MessageType.Default });
      expect(reply.interaction_metadata).toBeUndefined();

      events.length = 0;
      click(app, message, { custom_id: "go", component_type: 2 });
      vi.advanceTimersByTime(3100);
      expect(eventsOf("INTERACTION_FAILURE")).toEqual([{ users: [ids.plain], t: "INTERACTION_FAILURE", d: expect.objectContaining({ nonce: "c1" }) }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses clicks on unknown, disabled or other people's components and messages", () => {
    const { app, message } = postWithComponents([{ type: 1, components: [go, { ...go, custom_id: "off", disabled: true }] }]);
    const invalid = { status: 400, code: 50035 };
    expect(errorOf(() => click(app, message, { custom_id: "nope", component_type: 2 }))).toEqual(invalid);
    expect(errorOf(() => click(app, message, { custom_id: "off", component_type: 2 }))).toEqual(invalid);
    expect(errorOf(() => click(app, message, { custom_id: "go", component_type: 3, values: ["a"] }))).toEqual(invalid);
    expect(errorOf(() => call("plain", "POST", "/interactions", { type: 3, application_id: app.id, channel_id: general, message_id: "404", data: { custom_id: "go", component_type: 2 } }))).toEqual({ status: 404, code: 10008 });
    const plainMessage = call("plain", "POST", `/channels/${general}/messages`, { content: "hi" }) as Message;
    expect(errorOf(() => click(app, plainMessage, { custom_id: "go", component_type: 2 }))).toEqual({ status: 404, code: 10008 });
  });
});

describe("webhooks", () => {
  it("needs MANAGE_WEBHOOKS, executes with an override and its token unlocks nothing else", () => {
    expect(errorOf(() => call("plain", "POST", `/channels/${general}/webhooks`, { name: "Hook" }))).toEqual({ status: 403, code: 50013 });
    const hook = call("mod", "POST", `/channels/${general}/webhooks`, { name: "Alerts" }) as Webhook;
    expect(hook.token).toBeTruthy();
    expect(eventsOf("WEBHOOKS_UPDATE")[0]!.users).toEqual(expect.arrayContaining([ids.owner!, ids.mod!]));
    expect(eventsOf("WEBHOOKS_UPDATE")[0]!.users).not.toContain(ids.plain);
    const message = call(null, "POST", `/webhooks/${hook.id}/${hook.token}?wait=true`, { content: "build passed", username: "CI" }) as Message;
    expect(message).toMatchObject({ webhook_id: hook.id, author: { id: hook.id, username: "CI", bot: true } });
    expect(errorOf(() => call(null, "POST", `/webhooks/${hook.id}/wrong`, { content: "x" }))).toEqual({ status: 401, code: 50027 });
    expect(errorOf(() => call(null, "GET", `/channels/${general}/messages`))).toEqual({ status: 401, code: 0 });
    const userMessage = call("plain", "POST", `/channels/${general}/messages`, { content: "mine" }) as Message;
    expect(errorOf(() => call(null, "PATCH", `/webhooks/${hook.id}/${hook.token}/messages/${userMessage.id}`, { content: "x" }))).toEqual({ status: 404, code: 10008 });
    expect((call(null, "GET", `/webhooks/${hook.id}/${hook.token}`) as Webhook).token).toBeUndefined();
  });

  it("edits a webhook by token: name and avatar removal only, no move", () => {
    const hook = call("mod", "POST", `/channels/${general}/webhooks`, { name: "Alerts" }) as Webhook;
    events.length = 0;
    expect((call(null, "PATCH", `/webhooks/${hook.id}/${hook.token}`, { name: "Deploys" }) as Webhook).name).toBe("Deploys");
    expect(eventsOf("WEBHOOKS_UPDATE")).toHaveLength(1);
    expect(errorOf(() => call(null, "PATCH", `/webhooks/${hook.id}/${hook.token}`, { channel_id: general }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call(null, "PATCH", `/webhooks/${hook.id}/wrong`, { name: "x" }))).toEqual({ status: 401, code: 50027 });
  });

  it("limits embeds and keeps only http(s) URLs", () => {
    const hook = call("mod", "POST", `/channels/${general}/webhooks`, { name: "Alerts" }) as Webhook;
    const url = `/webhooks/${hook.id}/${hook.token}?wait=true`;
    expect(errorOf(() => call(null, "POST", url, { embeds: [{ title: "x".repeat(257) }] }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call(null, "POST", url, { embeds: [{ description: "x".repeat(4000) }, { description: "x".repeat(2001) }] }))).toEqual({ status: 400, code: 50035 });
    const message = call(null, "POST", url, { embeds: [{ type: "image", title: "ok", url: "javascript:alert(1)", image: { url: "file:///etc/passwd" } }] }) as Message;
    expect(message.embeds[0]).toEqual({ type: "rich", title: "ok" });
  });
});

describe("bot roles", () => {
  it("protects the bot's managed role and drops it when the bot is kicked", () => {
    const { app } = setupBot();
    const roleId = apps.integrations.get(`${guildId}:${app.id}`)!.role_id!;
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/members/${ids.plain}`, { roles: [roleId] }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/roles/${roleId}`, { name: "mine" }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "DELETE", `/guilds/${guildId}/roles/${roleId}`))).toEqual({ status: 400, code: 50035 });
    call("owner", "DELETE", `/guilds/${guildId}/members/${app.id}`);
    expect(apps.integrations.has(`${guildId}:${app.id}`)).toBe(false);
    expect(db.guilds.get(guildId)!.guild.roles.some(r => r.id === roleId)).toBe(false);
  });
});

describe("friend requests to bots", () => {
  it("are refused like the server does (403 20001), blocking is allowed", () => {
    const { app } = setupBot();
    expect(errorOf(() => call("plain", "PUT", `/users/@me/relationships/${app.id}`, {}))).toEqual({ status: 403, code: 20001 });
    expect(errorOf(() => call("plain", "POST", "/users/@me/relationships", { username: "Echo" }))).toEqual({ status: 403, code: 20001 });
    expect(() => call("plain", "PUT", `/users/@me/relationships/${app.id}`, { type: 2 })).not.toThrow();
  });
});
