import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../api/store";
import { ChannelType, type Channel, type ReadState } from "../api/types";
import { BINDINGS, keyCaps, matches, matchIndex } from "./bindings";
import { handleKeyDown, registerShortcut, runShortcut } from "./dispatch";
import { allChannelOrder, channelOrder, mentioned, step, unread } from "./navigation";
import { fuzzyScore, parseQuery, rank } from "./switcher";

type Mods = Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing">>;
const key = (k: string, mods: Mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const event = (k: string, mods: Mods = {}) => {
  const e = { repeat: false, isComposing: false, ...key(k, mods), keyCode: 0, target: null, defaultPrevented: false, preventDefault: vi.fn() };
  e.preventDefault.mockImplementation(() => (e.defaultPrevented = true));
  return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
};
const env = (modal = false) => ({ mac: false, modalOpen: () => modal });

describe("binding table", () => {
  it("has unique ids and no key used twice", () => {
    const ids = BINDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = BINDINGS.flatMap(b => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Mod is Cmd on macOS and Ctrl elsewhere", () => {
    expect(matches("Mod+K", key("k", { metaKey: true }), true)).toBe(true);
    expect(matches("Mod+K", key("k", { ctrlKey: true }), true)).toBe(false);
    expect(matches("Mod+K", key("k", { ctrlKey: true }), false)).toBe(true);
    expect(matches("Mod+K", key("k", { metaKey: true }), false)).toBe(false);
    expect(matches("Mod+K", key("K", { ctrlKey: true }), false)).toBe(true);
  });

  it("modifiers match exactly", () => {
    const server = BINDINGS.find(b => b.id === "server")!;
    const mention = BINDINGS.find(b => b.id === "mentionChannel")!;
    const e = key("ArrowDown", { ctrlKey: true, altKey: true, shiftKey: true });
    expect(matchIndex(server, e, false)).toBe(-1);
    expect(matchIndex(mention, e, false)).toBe(1);
    expect(matches("Escape", key("Escape", { shiftKey: true }), false)).toBe(false);
    expect(matches("Shift+Escape", key("Escape", { shiftKey: true }), false)).toBe(true);
  });

  it("labels caps per OS", () => {
    expect(keyCaps("Mod+Shift+Alt+ArrowUp", true)).toEqual(["⌘", "⇧", "⌥", "↑"]);
    expect(keyCaps("Mod+Shift+Alt+ArrowUp", false)).toEqual(["Ctrl", "Shift", "Alt", "↑"]);
    expect(keyCaps("Shift+PageUp", false)).toEqual(["Shift", "Page Up"]);
  });
});

describe("dispatcher guards", () => {
  it("runs the newest handler that accepts, and falls through on false", () => {
    const calls: string[] = [];
    const off1 = registerShortcut("gif", () => void calls.push("old"));
    const off2 = registerShortcut("gif", () => (calls.push("new-declines"), false));
    expect(runShortcut("gif")).toBe(true);
    expect(calls).toEqual(["new-declines", "old"]);
    off1();
    off2();
    expect(runShortcut("gif")).toBe(false);
  });

  it("passes the matched index and prevents the default", () => {
    const seen: number[] = [];
    const off = registerShortcut("channel", i => void seen.push(i));
    const e = event("ArrowDown", { altKey: true });
    handleKeyDown(e, env());
    expect(seen).toEqual([1]);
    expect(e.preventDefault).toHaveBeenCalled();
    off();
  });

  it("ignores IME composition, handled events, open modals and repeats of toggles", () => {
    const run = vi.fn();
    const offs = [registerShortcut("members", run), registerShortcut("quickSwitcher", run), registerShortcut("channel", run)];
    handleKeyDown(event("u", { ctrlKey: true, isComposing: true }), env());
    const handled = event("u", { ctrlKey: true });
    handled.preventDefault();
    handleKeyDown(handled, env());
    handleKeyDown(event("u", { ctrlKey: true }), env(true));
    const repeat = event("u", { ctrlKey: true, repeat: true });
    handleKeyDown(repeat, env());
    expect(run).not.toHaveBeenCalled();
    // The held key still must not reach the browser's own Ctrl+U.
    expect(repeat.preventDefault).toHaveBeenCalled();
    handleKeyDown(event("k", { ctrlKey: true }), env(true));
    handleKeyDown(event("ArrowUp", { altKey: true, repeat: true }), env());
    expect(run).toHaveBeenCalledTimes(2);
    offs.forEach(off => off());
  });

  it("leaves unhandled keys alone", () => {
    const e = event("p", { ctrlKey: true });
    handleKeyDown(e, env());
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("quick switcher", () => {
  it("parses prefixes", () => {
    expect(parseQuery("@Ali")).toEqual({ scope: "users", text: "ali" });
    expect(parseQuery(" #gen ")).toEqual({ scope: "text", text: "gen" });
    expect(parseQuery("!lounge")).toEqual({ scope: "voice", text: "lounge" });
    expect(parseQuery("*lab")).toEqual({ scope: "servers", text: "lab" });
    expect(parseQuery("$x").scope).toBe("unavailable");
    expect(parseQuery("a#b")).toEqual({ scope: "all", text: "a#b" });
  });

  it("scores exact > prefix > word start > substring > fuzzy", () => {
    const s = (t: string) => fuzzyScore("gen", t);
    expect(s("gen")).toBeGreaterThan(s("general"));
    expect(s("general")).toBeGreaterThan(s("off-general"));
    expect(s("off-general")).toBeGreaterThan(s("regen"));
    expect(s("regen")).toBeGreaterThan(s("green-lane"));
    expect(s("green-lane")).toBeGreaterThan(0);
    expect(s("lounge")).toBe(0);
  });

  it("boosts recent, mentioned and unread results among similar matches", () => {
    const items = [{ label: "general-a" }, { label: "general-b", unread: true }, { label: "general-c", mentions: 2 }, { label: "general-d", recent: 0 }];
    expect(rank(items, "gen").map(r => r.label)).toEqual(["general-d", "general-c", "general-b", "general-a"]);
    // A boost does not lift a loose fuzzy match over a real prefix match.
    expect(rank([{ label: "g-e-n", recent: 0, mentions: 3, unread: true }, { label: "gentle" }], "gen")[0]!.label).toBe("gentle");
  });

  it("matches the secondary text only as a substring", () => {
    expect(rank([{ label: "random", sub: "Gaming Lab" }], "lab")).toHaveLength(1);
    expect(rank([{ label: "random", sub: "Gaming Enthusiasts" }], "gen")).toHaveLength(0);
  });
});

describe("navigation order", () => {
  const ch = (id: string, guild_id: string | null, position: number, patch: Partial<Channel> = {}) =>
    ({ id, guild_id, position, type: ChannelType.GuildText, parent_id: null, last_message_id: "9", name: id, ...patch }) as Channel;
  const read = (channel_id: string, last_message_id: string, mention_count = 0): ReadState => ({ channel_id, last_message_id, mention_count });
  const state = {
    channels: {
      dm1: ch("dm1", null, 0, { type: ChannelType.DM }),
      a: ch("a", "g1", 0),
      b: ch("b", "g1", 1),
      v: ch("v", "g1", 2, { type: ChannelType.GuildVoice }),
      c: ch("c", "g1", 3),
      x: ch("x", "g2", 0),
    },
    privateChannels: ["dm1"],
    guildOrder: ["g1", "g2"],
    readStates: { dm1: read("dm1", "9"), a: read("a", "9"), b: read("b", "1"), c: read("c", "9"), x: read("x", "1", 2) },
  } as unknown as AppState;

  it("walks text channels in sidebar order, skipping voice", () => {
    expect(channelOrder(state, "g1").map(p => p.channelId)).toEqual(["a", "b", "c"]);
    expect(step(channelOrder(state, "g1"), "b", 1)?.channelId).toBe("c");
    expect(step(channelOrder(state, "g1"), "a", -1)).toBeUndefined();
  });

  it("finds the next unread channel and the next mention across servers", () => {
    expect(step(channelOrder(state, "g1"), "c", -1, unread(state))?.channelId).toBe("b");
    expect(step(channelOrder(state, "g1"), "a", -1, unread(state))).toBeUndefined();
    expect(step(allChannelOrder(state), "a", 1, mentioned(state))).toEqual({ guildId: "g2", channelId: "x" });
  });
});
