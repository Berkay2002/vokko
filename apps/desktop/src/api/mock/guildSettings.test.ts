import { describe, expect, it, vi } from "vitest";

const emitted: unknown[] = [];
vi.mock("./socket", () => ({ emit: (_to: string[], name: string, data: unknown) => emitted.push([name, data]) }));

import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { readyFor } from "./views";

describe("mock user guild settings", () => {
  it("merges overrides, emits the update, rejects bad input and shows in READY", () => {
    const me = createAccount({ username: "ugs-me" }).user.id;
    const other = createAccount({ username: "ugs-other" }).user.id;
    const guildId = createGuildRecord(me, "Notify guild");
    const general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
    const call = (who: string, method: string, path: string, body?: unknown) => handleRoute(method, path, body ?? null, who, null);
    const path = `/users/@me/guilds/${guildId}/settings`;

    expect(call(me, "GET", path)).toMatchObject({ guild_id: guildId, message_notifications: 3, channel_overrides: [] });
    const saved = call(me, "PATCH", path, { muted: true, mute_config: null, channel_overrides: { [general]: { message_notifications: 1, flags: 2048 } } });
    expect(saved).toMatchObject({ muted: true, channel_overrides: [{ channel_id: general, message_notifications: 1, flags: 2048, muted: false }] });
    expect(emitted.at(-1)).toEqual(["USER_GUILD_SETTINGS_UPDATE", saved]);
    expect(call(me, "PATCH", path, { channel_overrides: { [general]: { message_notifications: 3, flags: 0 } } })).toMatchObject({ channel_overrides: [] });
    expect(call(me, "PATCH", "/users/@me/guilds/@me/settings", { suppress_roles: true })).toMatchObject({ guild_id: null });
    expect(() => call(other, "PATCH", path, { muted: true })).toThrow();
    expect(() => call(me, "PATCH", path, { message_notifications: 7 })).toThrow();
    expect(readyFor(me, "s").user_guild_settings?.map(e => e.guild_id).sort()).toEqual([guildId, null].sort());
  });
});
