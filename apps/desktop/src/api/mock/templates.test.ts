import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { ApiRequestError } from "../errors";
import { ChannelType, OverwriteType, type Channel, type Guild, type GuildTemplate } from "../types";
import { templateCode } from "../../templates/api";
import { db } from "./db";
import { addChannel, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";

const call = <T = unknown>(who: string, method: string, path: string, body?: unknown): T => handleRoute(method, path, body ?? null, ids[who] ?? null) as T;
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};

beforeEach(() => {
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "stranger"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Source");
});

describe("mock server templates", () => {
  it("snapshots, tracks dirtiness, syncs and makes guilds with fresh ids", () => {
    const guild = db.guilds.get(guildId)!.guild;
    guild.roles.push({ id: "900", name: "mods", color: 255, hoist: true, position: 1, permissions: "8", mentionable: false });
    const staff = addChannel(guildId, { name: "staff", type: ChannelType.GuildText, permission_overwrites: [
      { id: "900", type: OverwriteType.Role, allow: "1024", deny: "0" },
      { id: ids.owner!, type: OverwriteType.Member, allow: "1024", deny: "0" },
    ] });

    expect(errorOf(() => call("stranger", "POST", `/guilds/${guildId}/templates`, { name: "x" }))).toEqual({ status: 403, code: 50001 });
    const template = call<GuildTemplate>("owner", "POST", `/guilds/${guildId}/templates`, { name: "Club" });
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/templates`, { name: "Again" })).code).toBe(30031);
    expect(template.is_dirty).toBe(false);
    const snapStaff = template.serialized_source_guild.channels.find(c => c.name === "staff")!;
    expect(snapStaff.permission_overwrites).toEqual([{ id: 1, type: OverwriteType.Role, allow: "1024", deny: "0" }]);

    staff.topic = "changed";
    expect(call<GuildTemplate>("stranger", "GET", `/guilds/templates/${template.code}`).is_dirty).toBe(true);
    expect(call<GuildTemplate>("owner", "PUT", `/guilds/${guildId}/templates/${template.code}`).is_dirty).toBe(false);

    const made = call<Guild>("stranger", "POST", `/guilds/templates/${template.code}`, { name: "Copy" });
    expect(made.id).not.toBe(guildId);
    expect(made.owner_id).toBe(ids.stranger);
    const mods = made.roles.find(r => r.name === "mods")!;
    expect(mods.id).not.toBe("900");
    const copied = [...db.channels.values()].find((c): c is Channel & { guild_id: string } => c.guild_id === made.id && c.name === "staff")!;
    expect(copied.topic).toBe("changed");
    expect(copied.permission_overwrites).toEqual([{ id: mods.id, type: OverwriteType.Role, allow: "1024", deny: "0" }]);
    expect(call<GuildTemplate>("owner", "GET", `/guilds/templates/${template.code}`).usage_count).toBe(1);

    call("owner", "DELETE", `/guilds/${guildId}/templates/${template.code}`);
    expect(errorOf(() => call("owner", "GET", `/guilds/templates/${template.code}`))).toEqual({ status: 404, code: 10057 });
  });

  it("reads the code out of links", () => {
    expect(templateCode("https://vokko.example.com/template/hgM48av5Q69A/")).toBe("hgM48av5Q69A");
    expect(templateCode(" vokko://template/abc?x=1 ")).toBe("abc");
    expect(templateCode("abc")).toBe("abc");
  });
});
