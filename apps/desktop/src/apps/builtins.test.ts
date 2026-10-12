import { describe, expect, it } from "vitest";
import { ApplicationCommandType, type ApplicationCommand } from "../api/types";
import { BUILTIN_COMMANDS, builtinContent, builtinsFor, isActionBuiltin, isBuiltin, takesFreeText, withBuiltins } from "./builtins";

const app: ApplicationCommand = { id: "10", type: ApplicationCommandType.ChatInput, application_id: "1", guild_id: null, name: "shrug", description: "Mine", default_member_permissions: null, version: "1" };

describe("built-in commands", () => {
  it("transforms the message", () => {
    expect(builtinContent("shrug", "hi")).toBe("hi ¯\\\\\\_(ツ)\\_/¯"); // escaped for markdown, which shows ¯\_(ツ)_/¯
    expect(builtinContent("tableflip", "no")).toBe("no (╯°□°)╯︵ ┻━┻");
    expect(builtinContent("unflip", "ok")).toBe("ok ┬─┬ノ( º _ ºノ)");
    expect(builtinContent("me", "waves")).toBe("_waves_");
    expect(builtinContent("spoiler", "plot")).toBe("||plot||");
  });
  it("sends only the face when the optional message is empty", () => {
    expect(builtinContent("shrug", "  ")).toBe("¯\\\\\\_(ツ)\\_/¯");
  });
  it("needs a message for /me and /spoiler", () => {
    expect(builtinContent("me", " ")).toBeNull();
    expect(builtinContent("spoiler", "")).toBeNull();
    expect(builtinContent("nope", "x")).toBeNull();
  });
  it("declares a message option on the text commands, required only for /me and /spoiler", () => {
    const text = BUILTIN_COMMANDS.filter(c => !isActionBuiltin(c.name));
    expect(text.map(c => c.name)).toEqual(["me", "shrug", "spoiler", "tableflip", "unflip"]);
    expect(text.filter(c => c.options?.[0]?.required).map(c => c.name)).toEqual(["me", "spoiler"]);
    expect(text.every(c => isBuiltin(c) && c.options?.[0]?.name === "message")).toBe(true);
  });
  it("has the action commands with their options", () => {
    const by = Object.fromEntries(BUILTIN_COMMANDS.map(c => [c.name, c.options ?? []]));
    expect(by.gif!.map(o => o.name)).toEqual(["query"]);
    expect(by.msg!.map(o => [o.name, o.required])).toEqual([["user", true], ["message", true]]);
    expect(by.nick!.map(o => [o.name, !!o.required])).toEqual([["new_nick", false]]);
    expect(by.thread!.map(o => [o.name, o.required])).toEqual([["name", true], ["message", true]]);
    expect(["gif", "msg", "nick", "thread"].every(isActionBuiltin)).toBe(true);
    expect(builtinContent("nick", "x")).toBeNull();
  });
  it("hides /nick in DMs or without CHANGE_NICKNAME and /thread without the right to create threads", () => {
    const names = (c: { nick: boolean; threads: boolean }) => builtinsFor([], c).map(x => x.name);
    expect(names({ nick: false, threads: false })).not.toContain("nick");
    expect(names({ nick: false, threads: false })).not.toContain("thread");
    expect(names({ nick: true, threads: false })).toContain("nick");
    expect(names({ nick: true, threads: false })).not.toContain("thread");
    expect(names({ nick: true, threads: true })).toContain("thread");
    expect(names({ nick: false, threads: false })).toEqual(expect.arrayContaining(["gif", "msg", "me"]));
  });
  it("takes free text only with a single option", () => {
    const by = Object.fromEntries(BUILTIN_COMMANDS.map(c => [c.name, takesFreeText(c)]));
    expect(by).toMatchObject({ shrug: true, nick: true, gif: true, msg: false, thread: false });
  });
  it("lets an app command with the same name win", () => {
    expect(builtinsFor([app]).map(c => c.name)).not.toContain("shrug");
    expect(withBuiltins([app]).filter(c => c.name === "shrug")).toEqual([app]);
    expect(builtinsFor([]).length).toBe(BUILTIN_COMMANDS.length);
  });
});
