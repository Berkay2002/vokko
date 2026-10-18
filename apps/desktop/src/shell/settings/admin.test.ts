import { describe, expect, it } from "vitest";
import { timestampToSnowflake } from "../../api/snowflake";
import { AuditLogEvent, type AuditLogEntry, type Channel, type GuildMember, type Role, type User } from "../../api/types";
import { BAN_HISTORY_OPTIONS, auditDiff, describeAuditEntry, filterMembers, memberSignals, nudgeRole, sortMembers, type AuditLookup } from "./admin";

const user = (id: string, username: string): User => ({ id, username, global_name: null, avatar: null, banner_color: null, bio: null, bot: false }) as User;
const role = (id: string, name: string, position: number): Role => ({ id, name, color: 0, hoist: false, position, permissions: "0", mentionable: false });
const lookup: AuditLookup = {
  users: new Map([
    ["1", user("1", "sam")],
    ["2", user("2", "spammer")],
  ]),
  roles: new Map([["300", role("300", "mods", 2)]]),
  channels: new Map([["50", { id: "50", name: "general" } as Channel]]),
};
const entry = (action: AuditLogEvent, extra: Partial<AuditLogEntry> = {}): AuditLogEntry => ({ id: "9", guild_id: "10", user_id: "1", target_id: "2", action_type: action, reason: null, ...extra });

describe("audit log wording", () => {
  it("summarises entries with names", () => {
    expect(describeAuditEntry(entry(AuditLogEvent.MemberBanAdd), lookup)).toBe("sam banned spammer");
    expect(describeAuditEntry(entry(AuditLogEvent.MemberPrune, { target_id: null, options: { delete_member_days: "7", members_removed: "3" } }), lookup)).toBe("sam pruned 3 members inactive for 7 days");
    expect(describeAuditEntry(entry(AuditLogEvent.ChannelOverwriteUpdate, { target_id: "50", options: { id: "300", type: "0" } }), lookup)).toBe("sam updated channel permissions for mods in #general");
    expect(describeAuditEntry(entry(AuditLogEvent.MemberUpdate, { changes: [{ key: "communication_disabled_until", new_value: "2026-10-12T00:00:00Z" }] }), lookup)).toBe("sam timed out spammer");
    expect(describeAuditEntry(entry(AuditLogEvent.AutoModerationBlockMessage, { user_id: "2", options: { channel_id: "50", auto_moderation_rule_name: "Words" } }), lookup)).toBe(
      "AutoMod blocked a message by spammer in #general (Words)",
    );
    expect(describeAuditEntry(entry(AuditLogEvent.AutoModerationUserCommunicationDisabled, { user_id: "2", options: { channel_id: "50", auto_moderation_rule_name: "Pings" } }), lookup)).toBe(
      "AutoMod timed out spammer for a message in #general (Pings)",
    );
    expect(describeAuditEntry(entry(AuditLogEvent.RoleDelete, { changes: [{ key: "name", old_value: "gone" }] }), lookup)).toBe("sam deleted the role gone");
  });

  it("turns changes into before → after rows", () => {
    const rows = auditDiff(
      entry(AuditLogEvent.RoleUpdate, {
        changes: [
          { key: "name", old_value: "a", new_value: "b" },
          { key: "color", old_value: 0, new_value: 255 },
          { key: "unicode_emoji", new_value: "🛡️" },
        ],
      }),
      lookup,
    );
    expect(rows).toEqual([
      { label: "Name", before: "a", after: "b" },
      { label: "Color", before: "default", after: "#0000ff" },
      { label: "Role icon", before: null, after: "🛡️" },
    ]);
    expect(auditDiff(entry(AuditLogEvent.MemberRoleUpdate, { changes: [{ key: "$add", new_value: [{ id: "300", name: "mods" }] }] }), lookup)).toEqual([{ label: "Added roles", before: null, after: "mods" }]);
  });
});

describe("member table", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const member = (id: string, name: string, joined: string, extra: Partial<GuildMember> = {}): GuildMember => ({ user: user(id, name), nick: null, roles: [], joined_at: joined, ...extra });
  const oldId = timestampToSnowflake(now - 400 * 86_400_000);
  const newId = timestampToSnowflake(now - 86_400_000);
  const members = [member(oldId, "zed", "2026-01-01T00:00:00Z", { roles: ["300"] }), member(newId, "amy", "2026-10-10T00:00:00Z", { communication_disabled_until: "2026-10-12T00:00:00Z" })];

  it("derives signals", () => {
    expect(memberSignals(members[1]!, oldId, now)).toEqual(["Timed out", "New account"]);
    expect(memberSignals(members[0]!, oldId, now)).toEqual(["Owner"]);
  });

  it("sorts by join date, account age and name, and filters by text and role", () => {
    expect(sortMembers(members, "joined", "desc").map(m => m.user.username)).toEqual(["amy", "zed"]);
    expect(sortMembers(members, "created", "asc").map(m => m.user.username)).toEqual(["zed", "amy"]);
    expect(sortMembers(members, "name", "asc").map(m => m.user.username)).toEqual(["amy", "zed"]);
    expect(filterMembers(members, "AM").map(m => m.user.username)).toEqual(["amy"]);
    expect(filterMembers(members, "", "300").map(m => m.user.username)).toEqual(["zed"]);
  });
});

describe("role reorder by keyboard", () => {
  const roles = [role("3", "top", 3), role("2", "mid", 2), role("1", "low", 1)];
  it("swaps positions with the neighbour", () => {
    expect(nudgeRole(roles, "2", "up")).toEqual([
      { id: "2", position: 3 },
      { id: "3", position: 2 },
    ]);
    expect(nudgeRole(roles, "1", "down")).toEqual([]);
  });
});

it("offers Discord's ban history windows", () => {
  expect(BAN_HISTORY_OPTIONS.map(o => Number(o.value))).toEqual([0, 3600, 21600, 43200, 86400, 259200, 604800]);
});
