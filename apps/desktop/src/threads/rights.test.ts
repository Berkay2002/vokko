import { describe, expect, it } from "vitest";
import { DEFAULT_EVERYONE, Perm } from "../api/permissions";
import { ChannelType, OverwriteType, type Channel, type Guild } from "../api/types";
import { threadRights } from "./rights";

const GUILD = "100";
const guild: Guild = {
  id: GUILD,
  name: "g",
  icon: null,
  owner_id: "owner",
  system_channel_id: null,
  roles: [
    { id: GUILD, name: "@everyone", color: 0, hoist: false, position: 0, permissions: DEFAULT_EVERYONE.toString(), mentionable: false },
    { id: "mod", name: "mod", color: 0, hoist: false, position: 1, permissions: Perm.MANAGE_THREADS.toString(), mentionable: false },
  ],
};
const parent: Channel = { id: "200", type: ChannelType.GuildText, guild_id: GUILD, name: "general", topic: null, position: 0, parent_id: null, last_message_id: null };
const thread = (extra: Partial<Channel> = {}): Channel => ({
  id: "300",
  type: ChannelType.PublicThread,
  guild_id: GUILD,
  name: "t",
  topic: null,
  position: 0,
  parent_id: "200",
  last_message_id: null,
  owner_id: "starter",
  thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: "2026-01-01T00:00:00.000Z", locked: false },
  ...extra,
});
const rights = (who: string, roles: string[], t: Channel, p: Channel = parent) => threadRights(t, guild, { roles }, who, p);

describe("threadRights", () => {
  it("members send; only the owner or MANAGE_THREADS edit, lock needs MANAGE_THREADS", () => {
    expect(rights("plain", [], thread())).toMatchObject({ canSend: true, canEdit: false, canLock: false, canDelete: false, manage: false });
    expect(rights("starter", [], thread())).toMatchObject({ canSend: true, canEdit: true, canLock: false, canDelete: true, isOwner: true });
    expect(rights("m", ["mod"], thread())).toMatchObject({ canEdit: true, canLock: true, canDelete: true, manage: true });
    expect(rights("owner", [], thread())).toMatchObject({ canLock: true, manage: true });
  });

  it("a locked thread only lets MANAGE_THREADS send or edit", () => {
    const locked = thread({ thread_metadata: { ...thread().thread_metadata!, locked: true } });
    expect(rights("starter", [], locked)).toMatchObject({ canSend: false, canEdit: false, canDelete: true });
    expect(rights("m", ["mod"], locked)).toMatchObject({ canSend: true, canEdit: true });
  });

  it("sending follows SEND_MESSAGES_IN_THREADS of the parent, not SEND_MESSAGES", () => {
    const noSend: Channel = { ...parent, permission_overwrites: [{ id: GUILD, type: OverwriteType.Role, allow: "0", deny: Perm.SEND_MESSAGES.toString() }] };
    expect(rights("plain", [], thread(), noSend).canSend).toBe(true);
    const noThreads: Channel = { ...parent, permission_overwrites: [{ id: GUILD, type: OverwriteType.Role, allow: "0", deny: Perm.SEND_MESSAGES_IN_THREADS.toString() }] };
    expect(rights("plain", [], thread(), noThreads).canSend).toBe(false);
  });

  it("adding members: the owner, MANAGE_THREADS, or a member of an invitable private thread", () => {
    expect(rights("plain", [], thread()).canAddMembers).toBe(false);
    expect(rights("starter", [], thread()).canAddMembers).toBe(true);
    const privateThread = thread({ type: ChannelType.PrivateThread, member: { id: "300", user_id: "plain", join_timestamp: "2026-01-01T00:00:00.000Z", flags: 0 } });
    expect(rights("plain", [], privateThread).canAddMembers).toBe(true);
    const closed = { ...privateThread, thread_metadata: { ...privateThread.thread_metadata!, invitable: false } };
    expect(rights("plain", [], closed).canAddMembers).toBe(false);
    expect(rights("plain", [], privateThread).joined).toBe(true);
  });
});
