import { describe, expect, it } from "vitest";
import { ApplicationCommandType, type Application, type ApplicationCommand } from "../api/types";
import { withBuiltins } from "./builtins";
import { bumpRecent, buildSections, rankRecents, type Recents } from "./panel";

const cmd = (id: string, name: string, application_id: string): ApplicationCommand => ({ id, type: ApplicationCommandType.ChatInput, application_id, guild_id: null, name, description: `${name} command`, default_member_permissions: null, version: "1" });
const app = (id: string, name: string): Application => ({ id, name, description: "", icon: null, owner_id: "9", bot: {} as Application["bot"], bot_public: true, install_params: { permissions: "0" } });

const commands = withBuiltins([cmd("10", "echo", "1"), cmd("11", "roll", "1"), cmd("20", "wave", "2")]);
const apps = [app("2", "Waver"), app("1", "Echo")];

describe("rankRecents", () => {
  it("orders by count, then recency, and caps at five", () => {
    const recents: Recents = { "10": { count: 2, last: 5 }, "11": { count: 2, last: 9 }, "20": { count: 7, last: 1 }, "builtin:me": { count: 1, last: 99 } };
    expect(rankRecents(recents, commands).map(c => c.id)).toEqual(["20", "11", "10", "builtin:me"]);
    const many: Recents = Object.fromEntries(commands.map((c, i) => [c.id, { count: 1, last: i }]));
    expect(rankRecents(many, commands)).toHaveLength(5);
  });
  it("skips commands the channel does not have", () => {
    expect(rankRecents({ "99": { count: 9, last: 1 } }, commands)).toEqual([]);
  });
});

describe("bumpRecent", () => {
  it("counts and stamps without touching the input", () => {
    const first: Recents = {};
    const next = bumpRecent(bumpRecent(first, "10", 1), "10", 2);
    expect(next["10"]).toEqual({ count: 2, last: 2 });
    expect(first).toEqual({});
  });
});

describe("buildSections", () => {
  it("lists Frequently Used, apps in index order, then Built-in", () => {
    const sections = buildSections(commands, apps, "", { "11": { count: 1, last: 1 } });
    expect(sections.map(s => s.id)).toEqual(["recent", "app:2", "app:1", "builtin"]);
    expect(sections[0]!.commands.map(c => c.name)).toEqual(["roll"]);
    expect(sections[2]!.commands.map(c => c.name)).toEqual(["echo", "roll"]); // also stays in its app
    expect(sections[3]!.commands.map(c => c.name)).toEqual(["gif", "me", "msg", "nick", "shrug", "spoiler", "tableflip", "thread", "tts", "unflip"]);
  });
  it("has no Frequently Used section when nothing was used", () => {
    expect(buildSections(commands, apps, "", {}).map(s => s.id)).not.toContain("recent");
  });
  it("shows only sections with matches while filtering, without Frequently Used", () => {
    const sections = buildSections(commands, apps, "ech", { "10": { count: 3, last: 1 } });
    expect(sections.map(s => s.id)).toEqual(["app:1"]);
    expect(sections[0]!.commands.map(c => c.name)).toEqual(["echo"]);
  });
  it("leaves Built-in out with no matching built-in, and lists them with no apps", () => {
    expect(buildSections(commands, apps, "wav", {}).map(s => s.id)).toEqual(["app:2"]);
    expect(buildSections(withBuiltins([]), [], "", {}).map(s => s.id)).toEqual(["builtin"]);
  });
  it("lists a shadowing app command, not the built-in", () => {
    const shadowed = withBuiltins([cmd("30", "shrug", "1")]);
    expect(buildSections(shadowed, apps, "shrug", {}).map(s => s.id)).toEqual(["app:1"]);
  });
});
