import { describe, expect, it } from "vitest";
import { ApplicationCommandType, type ApplicationCommand } from "../api/types";
import { BUILTIN_COMMANDS, builtinContent, builtinsFor, isBuiltin, withBuiltins } from "./builtins";

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
  it("declares a message option, required only for /me and /spoiler", () => {
    const required = BUILTIN_COMMANDS.filter(c => c.options?.[0]?.required).map(c => c.name);
    expect(required.sort()).toEqual(["me", "spoiler"]);
    expect(BUILTIN_COMMANDS.every(c => isBuiltin(c) && c.options?.[0]?.name === "message")).toBe(true);
  });
  it("lets an app command with the same name win", () => {
    expect(builtinsFor([app]).map(c => c.name)).not.toContain("shrug");
    expect(withBuiltins([app]).filter(c => c.name === "shrug")).toEqual([app]);
    expect(builtinsFor([]).length).toBe(BUILTIN_COMMANDS.length);
  });
});
