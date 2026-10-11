import { describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, DEFAULT_EVERYONE, Perm, basePermissions, canEditRole, canModerate, canSendIn, channelPermissions, hasBit, highestPosition, outranks, threadPermissions } from "./permissions";
import { ChannelType, OverwriteType, type Channel, type Role } from "./types";

const GUILD = "100";
const role = (id: string, position: number, permissions: bigint): Role => ({ id, name: id, color: 0, hoist: false, position, permissions: permissions.toString(), mentionable: false });
const guild = {
  id: GUILD,
  owner_id: "owner",
  roles: [role(GUILD, 0, DEFAULT_EVERYONE), role("helper", 1, Perm.MANAGE_MESSAGES), role("mod", 2, Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_ROLES), role("admin", 3, Perm.ADMINISTRATOR)],
};
const user = (id: string, roles: string[] = [], until: string | null = null) => ({ id, roles, communication_disabled_until: until });

describe("basePermissions", () => {
  it("gives the owner and administrators everything", () => {
    expect(basePermissions(guild, user("owner"))).toBe(ALL_PERMISSIONS);
    expect(basePermissions(guild, user("a", ["admin"]))).toBe(ALL_PERMISSIONS);
  });

  it("combines @everyone with the member's roles", () => {
    const bits = basePermissions(guild, user("m", ["helper"]));
    expect(hasBit(bits, Perm.MANAGE_MESSAGES)).toBe(true);
    expect(hasBit(bits, Perm.SEND_MESSAGES)).toBe(true);
    expect(hasBit(bits, Perm.KICK_MEMBERS)).toBe(false);
  });
});

describe("channelPermissions", () => {
  const privateChannel = {
    parent_id: null,
    permission_overwrites: [
      { id: GUILD, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() },
      { id: "helper", type: OverwriteType.Role, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" },
      { id: "banned-guy", type: OverwriteType.Member, allow: "0", deny: Perm.SEND_MESSAGES.toString() },
    ],
  };

  it("owner and administrator ignore overwrites", () => {
    expect(channelPermissions(guild, user("owner"), privateChannel)).toBe(ALL_PERMISSIONS);
    expect(hasBit(channelPermissions(guild, user("a", ["admin"]), privateChannel), Perm.VIEW_CHANNEL)).toBe(true);
  });

  it("applies @everyone deny, then role allow, then member overwrite", () => {
    expect(hasBit(channelPermissions(guild, user("plain"), privateChannel), Perm.VIEW_CHANNEL)).toBe(false);
    const helper = channelPermissions(guild, user("h", ["helper"]), privateChannel);
    expect(hasBit(helper, Perm.VIEW_CHANNEL)).toBe(true);
    expect(hasBit(helper, Perm.SEND_MESSAGES)).toBe(true);
    const muted = channelPermissions(guild, user("banned-guy", ["helper"]), privateChannel);
    expect(hasBit(muted, Perm.VIEW_CHANNEL)).toBe(true);
    expect(hasBit(muted, Perm.SEND_MESSAGES)).toBe(false);
  });

  it("ORs role allows and denies together before the member overwrite", () => {
    const channel = {
      parent_id: null,
      permission_overwrites: [
        { id: "helper", type: OverwriteType.Role, allow: Perm.ATTACH_FILES.toString(), deny: Perm.SEND_MESSAGES.toString() },
        { id: "mod", type: OverwriteType.Role, allow: Perm.SEND_MESSAGES.toString(), deny: "0" },
      ],
    };
    // role overwrites combine: allows win over the denies of the same layer
    const bits = channelPermissions(guild, user("x", ["helper", "mod"]), channel);
    expect(hasBit(bits, Perm.SEND_MESSAGES)).toBe(true);
    const restored = channelPermissions(guild, user("x", ["helper"]), { parent_id: null, permission_overwrites: [{ id: "x", type: OverwriteType.Member, allow: Perm.SEND_MESSAGES.toString(), deny: "0" }, ...channel.permission_overwrites] });
    expect(hasBit(restored, Perm.SEND_MESSAGES)).toBe(true);
  });

  it("clamps a timed-out member to VIEW_CHANNEL and READ_MESSAGE_HISTORY", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const until = new Date(now + 60_000).toISOString();
    const bits = channelPermissions(guild, user("t", ["helper"], until), null, now);
    expect(bits).toBe(Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY);
    // expired timeout no longer clamps
    expect(hasBit(channelPermissions(guild, user("t", [], until), null, now + 120_000), Perm.SEND_MESSAGES)).toBe(true);
  });
});

describe("hierarchy", () => {
  const owner = user("owner");
  const admin = user("a", ["admin"]);
  const mod = user("m", ["mod"]);
  const helper = user("h", ["helper"]);
  const plain = user("p");

  it("highestPosition ignores @everyone", () => {
    expect(highestPosition(guild, mod.roles)).toBe(2);
    expect(highestPosition(guild, [GUILD])).toBe(0);
  });

  it("never the owner, owner always, otherwise strictly above", () => {
    expect(outranks(guild, admin, owner)).toBe(false);
    expect(outranks(guild, owner, admin)).toBe(true);
    expect(outranks(guild, mod, helper)).toBe(true);
    expect(outranks(guild, helper, mod)).toBe(false);
    expect(outranks(guild, mod, user("m2", ["mod"]))).toBe(false);
    expect(outranks(guild, helper, plain)).toBe(true);
  });

  it("canModerate needs the permission and the rank", () => {
    expect(canModerate(guild, mod, helper, "kick")).toBe(true);
    expect(canModerate(guild, mod, admin, "ban")).toBe(false);
    expect(canModerate(guild, helper, plain, "kick")).toBe(false);
    expect(canModerate(guild, mod, mod, "kick")).toBe(false);
  });

  it("canEditRole only for roles below the actor's highest", () => {
    expect(canEditRole(guild, mod, guild.roles[1]!)).toBe(true);
    expect(canEditRole(guild, mod, guild.roles[2]!)).toBe(false);
    expect(canEditRole(guild, helper, guild.roles[1]!)).toBe(false);
    expect(canEditRole(guild, owner, guild.roles[3]!)).toBe(true);
  });
});

describe("threadPermissions", () => {
  it("uses the Discord bit values", () => {
    expect([Perm.MANAGE_THREADS, Perm.CREATE_PUBLIC_THREADS, Perm.CREATE_PRIVATE_THREADS, Perm.SEND_MESSAGES_IN_THREADS]).toEqual([1n << 34n, 1n << 35n, 1n << 36n, 1n << 38n]);
    for (const bit of [Perm.CREATE_PUBLIC_THREADS, Perm.CREATE_PRIVATE_THREADS, Perm.SEND_MESSAGES_IN_THREADS]) expect(hasBit(DEFAULT_EVERYONE, bit)).toBe(true);
    expect(hasBit(DEFAULT_EVERYONE, Perm.MANAGE_THREADS)).toBe(false);
  });

  it("SEND_MESSAGES in a thread follows SEND_MESSAGES_IN_THREADS of the parent", () => {
    const parent = DEFAULT_EVERYONE;
    expect(hasBit(threadPermissions(parent), Perm.SEND_MESSAGES)).toBe(true);
    expect(hasBit(threadPermissions(parent & ~Perm.SEND_MESSAGES), Perm.SEND_MESSAGES)).toBe(true); // may write in threads, not in the channel
    expect(hasBit(threadPermissions(parent & ~Perm.SEND_MESSAGES_IN_THREADS), Perm.SEND_MESSAGES)).toBe(false);
    expect(hasBit(threadPermissions(parent & ~Perm.SEND_MESSAGES_IN_THREADS), Perm.VIEW_CHANNEL)).toBe(true);
  });

  it("resolves through the parent's overwrites", () => {
    const channel = { parent_id: null, permission_overwrites: [{ id: GUILD, type: OverwriteType.Role, allow: "0", deny: Perm.SEND_MESSAGES_IN_THREADS.toString() }] };
    expect(hasBit(threadPermissions(channelPermissions(guild, user("m"), channel)), Perm.SEND_MESSAGES)).toBe(false);
    expect(hasBit(threadPermissions(channelPermissions(guild, user("a", ["admin"]), channel)), Perm.SEND_MESSAGES)).toBe(true);
  });
});

describe("canSendIn", () => {
  const text = (overwrites: Channel["permission_overwrites"] = []): Channel => ({ id: "c", type: ChannelType.GuildText, guild_id: GUILD, parent_id: null, permission_overwrites: overwrites } as Channel);
  const thread = (locked = false): Channel => ({ id: "t", type: ChannelType.PublicThread, guild_id: GUILD, parent_id: "c", thread_metadata: { locked } } as Channel);
  const deny = (bit: bigint, id = GUILD) => ({ id, type: OverwriteType.Role, allow: "0", deny: bit.toString() });

  it("is true without a guild or a loaded channel (DMs, the server decides)", () => {
    expect(canSendIn(undefined, user("a"), text())).toBe(true);
    expect(canSendIn(guild, user("a"), undefined)).toBe(true);
  });

  it("follows SEND_MESSAGES of the channel", () => {
    expect(canSendIn(guild, user("plain"), text())).toBe(true);
    expect(canSendIn(guild, user("plain"), text([deny(Perm.SEND_MESSAGES)]))).toBe(false);
  });

  it("lets a role overwrite re-allow it, and owners and administrators always send", () => {
    const readOnly = text([deny(Perm.SEND_MESSAGES), { id: "helper", type: OverwriteType.Role, allow: Perm.SEND_MESSAGES.toString(), deny: "0" }]);
    expect(canSendIn(guild, user("h", ["helper"]), readOnly)).toBe(true);
    expect(canSendIn(guild, user("plain"), readOnly)).toBe(false);
    expect(canSendIn(guild, user("owner"), readOnly)).toBe(true);
    expect(canSendIn(guild, user("a", ["admin"]), readOnly)).toBe(true);
  });

  it("denies a member overwrite and a timeout", () => {
    expect(canSendIn(guild, user("x"), text([{ id: "x", type: OverwriteType.Member, allow: "0", deny: Perm.SEND_MESSAGES.toString() }]))).toBe(false);
    expect(canSendIn(guild, user("x", [], new Date(Date.now() + 60_000).toISOString()), text())).toBe(false);
  });

  it("sends in a thread by SEND_MESSAGES_IN_THREADS of the parent, not SEND_MESSAGES", () => {
    const parentNoSend = text([deny(Perm.SEND_MESSAGES)]);
    expect(canSendIn(guild, user("plain"), thread(), parentNoSend)).toBe(true);
    expect(canSendIn(guild, user("plain"), thread(), text([deny(Perm.SEND_MESSAGES_IN_THREADS)]))).toBe(false);
  });

  it("is permissive for what is not loaded: a thread without its parent, a member beyond the READY cap", () => {
    expect(canSendIn(guild, user("plain"), thread(true), undefined)).toBe(true);
    expect(canSendIn(guild, undefined, text([deny(Perm.SEND_MESSAGES)]))).toBe(true);
  });

  it("lifts a timeout once it has ended", () => {
    vi.useFakeTimers();
    try {
      const until = new Date(Date.now() + 60_000).toISOString();
      expect(canSendIn(guild, user("x", [], until), text())).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(canSendIn(guild, user("x", [], until), text())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs MANAGE_THREADS in a locked thread", () => {
    expect(canSendIn(guild, user("plain"), thread(true), text())).toBe(false);
    const withManage = { ...guild, roles: [...guild.roles, role("tm", 1, Perm.MANAGE_THREADS)] };
    expect(canSendIn(withManage, user("t", ["tm"]), thread(true), text())).toBe(true);
  });
});
