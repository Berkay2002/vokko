import { describe, expect, it } from "vitest";
import type { GuildLayout } from "../api/types";
import { EMPTY_SETTINGS, dropZone, editFolder, entriesToSettings, flatGuildIds, moveFolder, moveGuild, railEntries, rollUp, ungroupFolder, type RailEntry } from "./railOrder";

const joined = ["1", "2", "3", "4", "5"];
const shape = (entries: RailEntry[]) => entries.map(e => (e.kind === "guild" ? e.guildId : `${e.folder.id}[${e.folder.guild_ids.join(",")}]`));

describe("railEntries", () => {
  it("keeps join order without settings", () => {
    expect(shape(railEntries(joined, EMPTY_SETTINGS))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("follows guild_positions, then appends the rest in join order and drops stale ids", () => {
    const settings: GuildLayout = { guild_folders: [], guild_positions: ["4", "99", "2", "4"] };
    expect(shape(railEntries(joined, settings))).toEqual(["4", "2", "1", "3", "5"]);
  });

  it("places a folder at its first server and lists servers in folder order", () => {
    const settings: GuildLayout = {
      guild_folders: [{ id: "f", name: "games", color: 1, guild_ids: ["5", "2", "77"] }],
      guild_positions: ["3", "2", "5", "1"],
    };
    expect(shape(railEntries(joined, settings))).toEqual(["3", "f[5,2]", "1", "4"]);
  });

  it("drops folders whose servers are all gone and never shows a server twice", () => {
    const settings: GuildLayout = {
      guild_folders: [
        { id: "a", name: null, color: null, guild_ids: ["88"] },
        { id: "b", name: null, color: null, guild_ids: ["1", "2"] },
        { id: "c", name: null, color: null, guild_ids: ["2", "3"] },
      ],
      guild_positions: [],
    };
    const entries = railEntries(joined, settings);
    expect(shape(entries)).toEqual(["b[1,2]", "c[3]", "4", "5"]);
    expect(flatGuildIds(entries)).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("drag and drop edits", () => {
  const base = railEntries(joined, EMPTY_SETTINGS);

  it("dropping a server on another makes a folder in the target's place", () => {
    const entries = moveGuild(base, "4", { kind: "combine", guildId: "2", newFolderId: "f" });
    expect(shape(entries)).toEqual(["1", "f[2,4]", "3", "5"]);
    expect(entriesToSettings(entries)).toEqual({ guild_folders: [{ id: "f", name: null, color: null, guild_ids: ["2", "4"] }], guild_positions: ["1", "2", "4", "3", "5"] });
    // and the stored settings give the same rail back
    expect(shape(railEntries(joined, entriesToSettings(entries)))).toEqual(shape(entries));
  });

  it("adds to a folder, reorders inside it and drags out of it", () => {
    let entries = moveGuild(base, "4", { kind: "combine", guildId: "2", newFolderId: "f" });
    entries = moveGuild(entries, "5", { kind: "into", folderId: "f" });
    expect(shape(entries)).toEqual(["1", "f[2,4,5]", "3"]);
    entries = moveGuild(entries, "5", { kind: "before", guildId: "2" });
    expect(shape(entries)).toEqual(["1", "f[5,2,4]", "3"]);
    entries = moveGuild(entries, "1", { kind: "combine", guildId: "4", newFolderId: "x" });
    expect(shape(entries)).toEqual(["f[5,2,4,1]", "3"]);
    entries = moveGuild(entries, "2", { kind: "after", guildId: "3" });
    expect(shape(entries)).toEqual(["f[5,4,1]", "3", "2"]);
  });

  it("removes a folder once its last server leaves it", () => {
    let entries = moveGuild(base, "2", { kind: "combine", guildId: "1", newFolderId: "f" });
    entries = moveGuild(entries, "1", { kind: "end" });
    entries = moveGuild(entries, "2", { kind: "before", guildId: "3" });
    expect(shape(entries)).toEqual(["2", "3", "4", "5", "1"]);
    expect(entriesToSettings(entries).guild_folders).toEqual([]);
  });

  it("reorders top-level servers and ignores a drop on itself", () => {
    expect(shape(moveGuild(base, "1", { kind: "after", guildId: "3" }))).toEqual(["2", "3", "1", "4", "5"]);
    expect(shape(moveGuild(base, "5", { kind: "before", guildId: "1" }))).toEqual(["5", "1", "2", "3", "4"]);
    expect(shape(moveGuild(base, "3", { kind: "combine", guildId: "3", newFolderId: "f" }))).toEqual(shape(base));
  });

  it("moves, edits and ungroups whole folders", () => {
    let entries = moveGuild(base, "3", { kind: "combine", guildId: "2", newFolderId: "f" });
    entries = moveFolder(entries, "f", { kind: "after", guildId: "5" });
    expect(shape(entries)).toEqual(["1", "4", "5", "f[2,3]"]);
    entries = moveFolder(entries, "f", { kind: "before", guildId: "1" });
    expect(shape(entries)).toEqual(["f[2,3]", "1", "4", "5"]);
    entries = editFolder(entries, "f", { name: "Work", color: 0xff0000 });
    expect(entriesToSettings(entries).guild_folders[0]).toMatchObject({ name: "Work", color: 0xff0000 });
    expect(shape(ungroupFolder(entries, "f"))).toEqual(["2", "3", "1", "4", "5"]);
  });
});

describe("badges and drop zones", () => {
  it("rolls unread and mentions up to the folder, ignoring muted unread", () => {
    expect(
      rollUp([
        { unread: false, mentions: 2, muted: false },
        { unread: true, mentions: 1, muted: true },
      ]),
    ).toEqual({ unread: false, mentions: 3 });
    expect(rollUp([{ unread: true, mentions: 0, muted: false }]).unread).toBe(true);
  });

  it("splits a tile into before / middle / after", () => {
    expect([dropZone(2, 48), dropZone(24, 48), dropZone(46, 48)]).toEqual(["before", "middle", "after"]);
  });
});
