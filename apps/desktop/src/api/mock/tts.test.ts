import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { Perm } from "../permissions";
import type { Message } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
let general = "";

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const say = (who: string, body: Record<string, unknown>): Message => call(who, "POST", `/channels/${general}/messages`, body) as Message;

beforeEach(() => {
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.followers] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "alice"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  db.guilds.get(guildId)!.members.set(ids.alice!, { nick: null, roles: [], joined_at: new Date().toISOString() });
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
});

describe("mock tts messages", () => {
  it("defaults to false and is always on the message", () => {
    expect(say("owner", { content: "plain" }).tts).toBe(false);
    expect(say("owner", { content: "off", tts: false }).tts).toBe(false);
  });

  it("keeps tts for a sender with SEND_TTS_MESSAGES (the owner holds every bit)", () => {
    const sent = say("owner", { content: "hello", tts: true });
    expect(sent.tts).toBe(true);
    const listed = call("alice", "GET", `/channels/${general}/messages`) as Message[];
    expect(listed.find(m => m.id === sent.id)?.tts).toBe(true);
  });

  it("drops the flag without the permission but still sends", () => {
    const sent = say("alice", { content: "shout", tts: true });
    expect(sent.tts).toBe(false);
    expect(sent.content).toBe("shout");
    db.channels.get(general)!.permission_overwrites = [{ id: guildId, type: 0, allow: Perm.SEND_TTS_MESSAGES.toString(), deny: "0" }];
    expect(say("alice", { content: "allowed now", tts: true }).tts).toBe(true);
  });
});