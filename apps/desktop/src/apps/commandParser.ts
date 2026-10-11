// Slash-command input parsing for the composer: `/name opt:value other:value with spaces`.
// Pure functions (no React, no store) so the picker and the tests share them.

import { ApplicationCommandOptionType, type ApplicationCommand, type ApplicationCommandOption, type ApplicationCommandOptionChoice, type InteractionDataOption } from "../api/types";

/** What the caret is on, which decides what the picker lists. */
export type ActivePart =
  | { kind: "command"; query: string }
  | { kind: "option-name"; query: string; start: number }
  | { kind: "option-value"; option: ApplicationCommandOption; query: string; start: number }
  | null;

export interface TypedOption {
  name: string;
  /** Text after `name:` up to the next option (trimmed). */
  raw: string;
  /** Where `name:` starts and where the value ends in the input. */
  start: number;
  valueStart: number;
  end: number;
}

export interface ParsedInput {
  /** The input starts with `/`. */
  slash: boolean;
  /** What follows the slash up to the first space. */
  name: string;
  /** True once a space follows the name (the command is chosen). */
  nameDone: boolean;
  command: ApplicationCommand | null;
  options: TypedOption[];
  active: ActivePart;
}

/** The command a chat-input name refers to (exact, case-insensitive). */
export function findCommand(commands: readonly ApplicationCommand[], name: string): ApplicationCommand | null {
  const lower = name.toLowerCase();
  return commands.find(c => c.type === 1 && c.name === lower) ?? null;
}

/** Slash commands whose name matches the typed prefix, prefix matches first. */
export function matchCommands(commands: readonly ApplicationCommand[], query: string): ApplicationCommand[] {
  const q = query.toLowerCase();
  const chat = commands.filter(c => c.type === 1);
  const starts = chat.filter(c => c.name.startsWith(q));
  const contains = chat.filter(c => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

/**
 * Splits `/name a:1 b:two words` into options. A new option starts at ` word:` where `word` is one of the command's option
 * names, so values may contain spaces and colons (a URL in a string option stays whole).
 */
export function parseInput(text: string, caret: number, commands: readonly ApplicationCommand[]): ParsedInput {
  const empty: ParsedInput = { slash: false, name: "", nameDone: false, command: null, options: [], active: null };
  if (!text.startsWith("/")) return empty;
  const space = text.search(/\s/);
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  const nameDone = space !== -1;
  if (!nameDone || caret <= name.length + 1) {
    return { ...empty, slash: true, name, nameDone, command: nameDone ? findCommand(commands, name) : null, active: { kind: "command", query: name.slice(0, Math.max(0, caret - 1)) } };
  }
  const command = findCommand(commands, name);
  if (!command) return { ...empty, slash: true, name, nameDone };
  const defs = command.options ?? [];
  const names = new Set(defs.map(o => o.name));
  const options: TypedOption[] = [];
  const pattern = /(^|\s)([^\s:]+):/g;
  const body = text.slice(space);
  const starts: { name: string; start: number; valueStart: number }[] = [];
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const optionName = m[2]!.toLowerCase();
    if (!names.has(optionName)) continue;
    const start = space + m.index + m[1]!.length;
    starts.push({ name: optionName, start, valueStart: start + m[2]!.length + 1 });
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.start : text.length;
    options.push({ name: s.name, raw: text.slice(s.valueStart, end).trim(), start: s.start, valueStart: s.valueStart, end });
  });
  // The caret is inside a value, or on a word that is not an option yet.
  let active: ActivePart = null;
  const current = [...options].reverse().find(o => caret >= o.valueStart && caret <= o.end);
  const def = current ? defs.find(d => d.name === current.name) : undefined;
  const given = new Set(options.map(o => o.name));
  // After a finished value, a word that starts another option's name switches to option names ("text:hi si" → sides).
  const tail = current ? /^(.*\S)\s+([^\s:]+)$/.exec(text.slice(current.valueStart, caret)) : null;
  const switching = tail && defs.some(d => !given.has(d.name) && d.name.startsWith(tail[2]!.toLowerCase()));
  if (current && def && tail && switching) {
    active = { kind: "option-name", query: tail[2]!.toLowerCase(), start: caret - tail[2]!.length };
  } else if (current && def) {
    active = { kind: "option-value", option: def, query: text.slice(current.valueStart, caret).trimStart(), start: current.valueStart };
  } else {
    const before = text.slice(0, caret);
    const word = /(^|\s)([^\s:]*)$/.exec(before);
    const insideValue = options.some(o => caret > o.valueStart && caret <= o.end);
    if (word && !insideValue) active = { kind: "option-name", query: word[2]!.toLowerCase(), start: caret - word[2]!.length };
  }
  return { slash: true, name, nameDone, command, options, active };
}

/** Options not given yet whose name matches `query`, required ones first. */
export function remainingOptions(parsed: ParsedInput, query = ""): ApplicationCommandOption[] {
  const given = new Set(parsed.options.map(o => o.name));
  return (parsed.command?.options ?? []).filter(o => !given.has(o.name) && o.name.startsWith(query)).sort((a, b) => Number(!!b.required) - Number(!!a.required));
}

/** Choices of an option filtered by what is typed (name or value, case-insensitive). */
export function matchChoices(choices: readonly ApplicationCommandOptionChoice[], query: string): ApplicationCommandOptionChoice[] {
  const q = query.trim().toLowerCase();
  return choices.filter(c => !q || c.name.toLowerCase().includes(q) || String(c.value).toLowerCase().includes(q));
}

export interface ValueResolvers {
  /** `@name` typed in a user option → user id (mentions are usually already `<@id>` in the raw text). */
  userByName?(name: string): string | null;
  channelByName?(name: string): string | null;
  roleByName?(name: string): string | null;
}

export type Converted = { ok: true; value: string | number | boolean } | { ok: false; error: string };

/** Turns the typed text of one option into its wire value, checking type, range, length and choices. */
export function convertValue(option: ApplicationCommandOption, raw: string, resolvers: ValueResolvers = {}): Converted {
  const text = raw.trim();
  if (option.choices && option.choices.length > 0) {
    const lower = text.toLowerCase();
    const choice = option.choices.find(c => c.name.toLowerCase() === lower || String(c.value).toLowerCase() === lower);
    if (!choice) return { ok: false, error: `Pick one of: ${option.choices.map(c => c.name).join(", ")}` };
    return { ok: true, value: choice.value };
  }
  switch (option.type) {
    case ApplicationCommandOptionType.String: {
      if (text.length < (option.min_length ?? 1)) return { ok: false, error: option.min_length ? `At least ${option.min_length} characters` : "Cannot be empty" };
      if (text.length > (option.max_length ?? 6000)) return { ok: false, error: `At most ${option.max_length ?? 6000} characters` };
      return { ok: true, value: text };
    }
    case ApplicationCommandOptionType.Integer:
    case ApplicationCommandOptionType.Number: {
      const integer = option.type === ApplicationCommandOptionType.Integer;
      if (!(integer ? /^-?\d+$/ : /^-?(\d+\.?\d*|\.\d+)$/).test(text)) return { ok: false, error: integer ? "Must be a whole number" : "Must be a number" };
      const value = Number(text);
      if (option.min_value !== undefined && value < option.min_value) return { ok: false, error: `Must be at least ${option.min_value}` };
      if (option.max_value !== undefined && value > option.max_value) return { ok: false, error: `Must be at most ${option.max_value}` };
      return { ok: true, value };
    }
    case ApplicationCommandOptionType.Boolean: {
      const lower = text.toLowerCase();
      if (["true", "yes", "on", "1"].includes(lower)) return { ok: true, value: true };
      if (["false", "no", "off", "0"].includes(lower)) return { ok: true, value: false };
      return { ok: false, error: "Must be True or False" };
    }
    case ApplicationCommandOptionType.User: {
      const id = /^<@!?(\d+)>$/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : resolvers.userByName?.(text.replace(/^@/, "")) ?? null);
      return id ? { ok: true, value: id } : { ok: false, error: "Mention a user" };
    }
    case ApplicationCommandOptionType.Channel: {
      const id = /^<#(\d+)>$/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : resolvers.channelByName?.(text.replace(/^#/, "")) ?? null);
      return id ? { ok: true, value: id } : { ok: false, error: "Mention a channel" };
    }
    case ApplicationCommandOptionType.Role: {
      const id = /^<@&(\d+)>$/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : resolvers.roleByName?.(text.replace(/^@/, "")) ?? null);
      return id ? { ok: true, value: id } : { ok: false, error: "Mention a role" };
    }
    default:
      return { ok: false, error: "Unsupported option" };
  }
}

export interface BuiltOptions {
  options: InteractionDataOption[];
  /** option name → problem */
  errors: Record<string, string>;
  missing: string[];
}

/** Every typed option converted, plus what is wrong or missing; `options` is only complete when both are empty. */
export function buildOptions(parsed: ParsedInput, resolvers: ValueResolvers = {}): BuiltOptions {
  const defs = parsed.command?.options ?? [];
  const errors: Record<string, string> = {};
  const options: InteractionDataOption[] = [];
  const seen = new Set<string>();
  for (const typed of parsed.options) {
    const def = defs.find(d => d.name === typed.name);
    if (!def) continue;
    if (seen.has(def.name)) {
      errors[def.name] = "Given more than once";
      continue;
    }
    seen.add(def.name);
    if (typed.raw === "") {
      if (def.required) errors[def.name] = "Cannot be empty";
      continue;
    }
    const converted = convertValue(def, typed.raw, resolvers);
    if (converted.ok) options.push({ name: def.name, type: def.type, value: converted.value });
    else errors[def.name] = converted.error;
  }
  const missing = defs.filter(d => d.required && !seen.has(d.name)).map(d => d.name);
  return { options, errors, missing };
}

/** The text after choosing a command: `/name ` plus the first required option, ready to type into. */
export function commandInsertText(command: ApplicationCommand): string {
  const first = command.options?.find(o => o.required);
  return first ? `/${command.name} ${first.name}:` : `/${command.name} `;
}

/** Replaces the value of the option at `start` (up to `end`) with `value` and a trailing space. */
export function replaceValue(text: string, start: number, end: number, value: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^\s*/, "");
  const inserted = `${value} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
