import { describe, expect, it } from "vitest";
import { ChannelType, OverwriteType, type Channel, type Guild } from "../api/types";
import { Perm } from "../api/permissions";
import { pickUploadChannel } from "./uploadChannel";

const guild = { id: "g1", owner_id: "owner", roles: [{ id: "g1", name: "@everyone", color: 0, hoist: false, position: 0, permissions: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.ATTACH_FILES), mentionable: false }] } as unknown as Guild;
const me = { id: "me", roles: [] as string[] };
const channel = (id: string, type: ChannelType, position: number, deny = 0n): Channel =>
  ({ id, guild_id: "g1", type, position, name: id, parent_id: null, permission_overwrites: deny ? [{ id: "g1", type: OverwriteType.Role, allow: "0", deny: String(deny) }] : [] }) as unknown as Channel;

describe("pickUploadChannel", () => {
  it("takes the first text channel where uploads are allowed", () => {
    const channels = [channel("b", ChannelType.GuildText, 2), channel("a", ChannelType.GuildText, 1, Perm.ATTACH_FILES)];
    expect(pickUploadChannel(guild, me, channels)).toBe("b");
  });

  it("skips channels the member cannot see, and prefers text over voice", () => {
    const channels = [channel("v", ChannelType.GuildVoice, 0), channel("hidden", ChannelType.GuildText, 1, Perm.VIEW_CHANNEL), channel("t", ChannelType.GuildAnnouncement, 5)];
    expect(pickUploadChannel(guild, me, channels)).toBe("t");
  });

  it("falls back to a voice channel when no text channel allows it, and to nothing at all", () => {
    expect(pickUploadChannel(guild, me, [channel("t", ChannelType.GuildText, 0, Perm.ATTACH_FILES), channel("v", ChannelType.GuildVoice, 1)])).toBe("v");
    expect(pickUploadChannel(guild, me, [channel("t", ChannelType.GuildText, 0, Perm.ATTACH_FILES)])).toBeUndefined();
    expect(pickUploadChannel(guild, me, [])).toBeUndefined();
  });

  it("ignores other guilds and non-channel kinds", () => {
    const other = { ...channel("x", ChannelType.GuildText, 0), guild_id: "g2" } as Channel;
    expect(pickUploadChannel(guild, me, [other, channel("c", ChannelType.GuildCategory, 0), channel("f", ChannelType.GuildForum, 1)])).toBeUndefined();
  });
});
