import { describe, expect, it } from "vitest";
import { ChannelType, OverwriteType, type Channel } from "../api/types";
import { channelMoves, stepTarget } from "./reorder";

const ch = (id: string, type: ChannelType, position: number, parent_id: string | null = null, overwrites: Channel["permission_overwrites"] = []): Channel => ({
  id,
  type,
  guild_id: "g",
  name: id,
  topic: null,
  position,
  parent_id,
  last_message_id: null,
  permission_overwrites: overwrites,
});

const deny = [{ id: "g", type: OverwriteType.Role, allow: "0", deny: "1024" }];
const channels = [
  ch("catA", ChannelType.GuildCategory, 0),
  ch("catB", ChannelType.GuildCategory, 1, null, deny),
  ch("a1", ChannelType.GuildText, 0, "catA"),
  ch("a2", ChannelType.GuildText, 1, "catA"),
  ch("a3", ChannelType.GuildText, 2, "catA"),
  ch("av", ChannelType.GuildVoice, 0, "catA"),
  ch("b1", ChannelType.GuildText, 0, "catB", deny),
];

describe("channelMoves", () => {
  it("reorders inside a category", () => {
    expect(channelMoves(channels, "a3", { kind: "before", targetId: "a1" })).toEqual([
      { id: "a3", position: 0 },
      { id: "a1", position: 1 },
      { id: "a2", position: 2 },
    ]);
  });

  it("returns nothing for a no-op drop", () => {
    expect(channelMoves(channels, "a1", { kind: "before", targetId: "a2" })).toEqual([]);
    expect(channelMoves(channels, "a1", { kind: "after", targetId: "a1" })).toEqual([]);
  });

  it("moves a channel into another category and syncs when it was synced", () => {
    expect(channelMoves(channels, "a2", { kind: "after", targetId: "b1" })).toEqual([{ id: "a2", position: 1, parent_id: "catB", lock_permissions: true }]);
  });

  it("does not sync a channel whose overwrites differ from its old category", () => {
    const custom = channels.map(c => (c.id === "a1" ? { ...c, permission_overwrites: deny } : c));
    expect(channelMoves(custom, "a1", { kind: "into", categoryId: "catB" })).toEqual([
      { id: "a1", position: 0, parent_id: "catB" },
      { id: "b1", position: 1 },
    ]);
  });

  it("keeps text above voice: text dropped on a voice row ends the text run", () => {
    expect(channelMoves(channels, "a1", { kind: "before", targetId: "av" })).toEqual([
      { id: "a2", position: 0 },
      { id: "a3", position: 1 },
      { id: "a1", position: 2 },
    ]);
  });

  it("reorders categories, and a category dropped on a channel goes next to its category", () => {
    const moves = [{ id: "catB", position: 0 }, { id: "catA", position: 1 }];
    expect(channelMoves(channels, "catB", { kind: "before", targetId: "catA" })).toEqual(moves);
    expect(channelMoves(channels, "catB", { kind: "before", targetId: "a2" })).toEqual(moves);
  });

  it("moves a channel out of every category", () => {
    const withLoose = [...channels, ch("loose", ChannelType.GuildText, 0)];
    expect(channelMoves(withLoose, "a1", { kind: "after", targetId: "loose" })).toEqual([{ id: "a1", position: 1, parent_id: null }]);
  });

  it("does not ask for a sync the viewer cannot do (no MANAGE_ROLES in the channel)", () => {
    expect(channelMoves(channels, "a2", { kind: "after", targetId: "b1" }, () => false)).toEqual([{ id: "a2", position: 1, parent_id: "catB" }]);
  });

  it("keeps stage channels in the text run, like the sidebar", () => {
    const withStage = [...channels, ch("st", ChannelType.GuildStage, 3, "catA")];
    expect(channelMoves(withStage, "st", { kind: "before", targetId: "a1" })).toEqual([
      { id: "st", position: 0 },
      { id: "a1", position: 1 },
      { id: "a2", position: 2 },
      { id: "a3", position: 3 },
    ]);
  });
});

describe("stepTarget", () => {
  it("steps among siblings of the same run and stops at the ends", () => {
    expect(stepTarget(channels, "a2", "up")).toEqual({ kind: "before", targetId: "a1" });
    expect(stepTarget(channels, "a2", "down")).toEqual({ kind: "after", targetId: "a3" });
    expect(stepTarget(channels, "a1", "up")).toBeNull();
    expect(stepTarget(channels, "a3", "down")).toBeNull(); // the voice run below is not a sibling
    expect(stepTarget(channels, "av", "up")).toBeNull();
  });

  it("steps categories among categories, and the result is a real move", () => {
    const target = stepTarget(channels, "catB", "up");
    expect(target).toEqual({ kind: "before", targetId: "catA" });
    expect(channelMoves(channels, "catB", target!)).toEqual([{ id: "catB", position: 0 }, { id: "catA", position: 1 }]);
  });
});
