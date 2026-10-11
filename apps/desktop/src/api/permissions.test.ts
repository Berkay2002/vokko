import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DEFAULT_EVERYONE, Perm, basePermissions, canEditRole, canModerate, channelPermissions, hasBit, highestPosition, outranks } from "./permissions";
import { OverwriteType, type Role } from "./types";

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
