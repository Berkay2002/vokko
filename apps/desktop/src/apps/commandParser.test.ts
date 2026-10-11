import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType as T, ApplicationCommandType, type ApplicationCommand } from "../api/types";
import { buildOptions, commandInsertText, convertValue, matchChoices, matchCommands, parseInput, remainingOptions, replaceValue } from "./commandParser";

const base = { application_id: "1", guild_id: null, default_member_permissions: null, version: "1" };
const commands: ApplicationCommand[] = [
  { ...base, id: "10", type: ApplicationCommandType.ChatInput, name: "echo", description: "Repeat text", options: [{ type: T.String, name: "text", description: "What to say", required: true, max_length: 20 }] },
  {
    ...base,
    id: "11",
    type: ApplicationCommandType.ChatInput,
    name: "roll",
    description: "Roll a die",
    options: [
      { type: T.Integer, name: "sides", description: "Sides", min_value: 2, max_value: 100 },
      { type: T.String, name: "mode", description: "Mode", choices: [{ name: "Fast", value: "fast" }, { name: "Slow", value: "slow" }] },
      { type: T.Boolean, name: "secret", description: "Secret" },
      { type: T.User, name: "for", description: "Who" },
    ],
  },
  { ...base, id: "12", type: ApplicationCommandType.User, name: "Wave at", description: "" },
  { ...base, id: "13", type: ApplicationCommandType.ChatInput, name: "echo-loud", description: "Shout", options: [] },
];

const at = (text: string) => parseInput(text, text.length, commands);

describe("parseInput", () => {
  it("is not a command without the slash", () => {
    expect(at("hello /echo").slash).toBe(false);
  });

  it("lists commands while the name is typed", () => {
    const parsed = at("/ec");
    expect(parsed.active).toEqual({ kind: "command", query: "ec" });
    expect(matchCommands(commands, "ec").map(c => c.name)).toEqual(["echo", "echo-loud"]);
    expect(matchCommands(commands, "die").map(c => c.name)).toEqual(["roll"]);
    expect(matchCommands(commands, "").map(c => c.name)).not.toContain("Wave at");
  });

  it("finds the command once a space follows and offers its options", () => {
    const parsed = at("/roll ");
    expect(parsed.command?.name).toBe("roll");
    expect(parsed.active).toEqual({ kind: "option-name", query: "", start: 6 });
    expect(remainingOptions(parsed).map(o => o.name)).toEqual(["sides", "mode", "secret", "for"]);
    expect(remainingOptions(at("/roll se"), "se").map(o => o.name)).toEqual(["secret"]);
  });

  it("splits values on known option names only, so values keep spaces and colons", () => {
    const parsed = at("/echo text:see https://x.io/a:b now");
    expect(parsed.options).toEqual([{ name: "text", raw: "see https://x.io/a:b now", start: 6, valueStart: 11, end: 35 }]);
    const roll = at("/roll sides:20 mode:fast");
    expect(roll.options.map(o => [o.name, o.raw])).toEqual([["sides", "20"], ["mode", "fast"]]);
    expect(roll.active).toMatchObject({ kind: "option-value", query: "fast" });
  });

  it("knows which option value the caret is in", () => {
    const text = "/roll sides:2 mode:f";
    const parsed = parseInput(text, 13, commands);
    expect(parsed.active).toMatchObject({ kind: "option-value", query: "2" });
    expect(parsed.active?.kind === "option-value" && parsed.active.option.name).toBe("sides");
  });

  it("switches to option names when a word after a value starts another option", () => {
    expect(at("/roll mode:fast si").active).toEqual({ kind: "option-name", query: "si", start: 16 });
    expect(at("/echo text:hello wor").active).toMatchObject({ kind: "option-value", query: "hello wor" });
  });

  it("an unknown command has no options", () => {
    const parsed = at("/nope a:1");
    expect(parsed.command).toBeNull();
    expect(parsed.active).toBeNull();
  });
});

describe("convertValue", () => {
  const roll = commands[1]!.options!;
  const [sides, mode, secret, who] = roll as [NonNullable<typeof roll>[number], NonNullable<typeof roll>[number], NonNullable<typeof roll>[number], NonNullable<typeof roll>[number]];

  it("checks integers and their range", () => {
    expect(convertValue(sides, "20")).toEqual({ ok: true, value: 20 });
    expect(convertValue(sides, "1")).toEqual({ ok: false, error: "Must be at least 2" });
    expect(convertValue(sides, "2.5")).toEqual({ ok: false, error: "Must be a whole number" });
    expect(convertValue(sides, "999")).toEqual({ ok: false, error: "Must be at most 100" });
  });

  it("maps choices by name or value", () => {
    expect(convertValue(mode, "Fast")).toEqual({ ok: true, value: "fast" });
    expect(convertValue(mode, "slow")).toEqual({ ok: true, value: "slow" });
    expect(convertValue(mode, "medium").ok).toBe(false);
    expect(matchChoices(mode.choices!, "sl").map(c => c.value)).toEqual(["slow"]);
  });

  it("reads booleans and mentions", () => {
    expect(convertValue(secret, "yes")).toEqual({ ok: true, value: true });
    expect(convertValue(secret, "False")).toEqual({ ok: true, value: false });
    expect(convertValue(secret, "maybe").ok).toBe(false);
    expect(convertValue(who, "<@!42>")).toEqual({ ok: true, value: "42" });
    expect(convertValue(who, "@alice", { userByName: name => (name === "alice" ? "7" : null) })).toEqual({ ok: true, value: "7" });
    expect(convertValue(who, "@ghost", { userByName: () => null }).ok).toBe(false);
  });

  it("enforces string length", () => {
    const text = commands[0]!.options![0]!;
    expect(convertValue(text, "x".repeat(21))).toEqual({ ok: false, error: "At most 20 characters" });
    expect(convertValue(text, "  hi  ")).toEqual({ ok: true, value: "hi" });
  });
});

describe("buildOptions", () => {
  it("collects values, errors and missing required options", () => {
    expect(buildOptions(at("/echo text:hello world"))).toEqual({ options: [{ name: "text", type: T.String, value: "hello world" }], errors: {}, missing: [] });
    expect(buildOptions(at("/echo "))).toEqual({ options: [], errors: {}, missing: ["text"] });
    expect(buildOptions(at("/echo text:"))).toEqual({ options: [], errors: { text: "Cannot be empty" }, missing: [] });
    const roll = buildOptions(at("/roll sides:1 mode:fast"));
    expect(roll.errors).toEqual({ sides: "Must be at least 2" });
    expect(roll.options).toEqual([{ name: "mode", type: T.String, value: "fast" }]);
  });
});

describe("editing helpers", () => {
  it("inserts the first required option after choosing a command", () => {
    expect(commandInsertText(commands[0]!)).toBe("/echo text:");
    expect(commandInsertText(commands[1]!)).toBe("/roll ");
  });

  it("replaces an option value and puts the caret after it", () => {
    const text = "/roll mode:f sides:3";
    expect(replaceValue(text, 11, 12, "Fast")).toEqual({ text: "/roll mode:Fast sides:3", caret: 16 });
  });
});
