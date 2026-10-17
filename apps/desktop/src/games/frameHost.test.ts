import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameManifest } from "../api/types";
import { voiceReducer, initialVoiceModel } from "../voice/reducer";
import { checkSend, FrameHost, frameOrigin, frameUrl, isHello, leaderOf, parsePortMessage, relayBytes, sandboxFor, SANDBOX_BUILTIN, SANDBOX_THIRD_PARTY, type GameToHost } from "./frameHost";

const APP = "http://127.0.0.1:1453";
const API = "https://vokko.example";
const third = (url: string): GameManifest => ({ id: "123", name: "Codenames", url, min_players: 2, max_players: 8, aspect: "16:9" });
const sketch: GameManifest = { id: "builtin:sketch", name: "Sketch", url: "https://ignored.example/", min_players: 2, max_players: 12, aspect: "16:9" };
const frame = {} as Window;
const hello = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: "https://play.example", source: frame, data, ...over }) as unknown as MessageEvent;

describe("sandbox choice", () => {
  it("never gives a built-in allow-same-origin, and loads it from the app bundle", () => {
    expect(sandboxFor(sketch, [APP, API])).toBe(SANDBOX_BUILTIN);
    expect(SANDBOX_BUILTIN).not.toContain("allow-same-origin");
    expect(frameOrigin(sketch)).toBe("null");
    expect(frameUrl(sketch, APP)).toBe(`${APP}/games/sketch/index.html`);
  });

  it("gives a third-party https game its own origin", () => {
    expect(sandboxFor(third("https://play.example/vokko/"), [APP, API])).toBe(SANDBOX_THIRD_PARTY);
    expect(frameOrigin(third("https://play.example/vokko/"))).toBe("https://play.example");
  });

  it("refuses allow-same-origin on the app's or the API's origin, and non-https or credentialed URLs", () => {
    expect(sandboxFor(third(`${API}/games/x/`), [APP, API])).toBeNull();
    expect(sandboxFor(third(`${APP}/evil.html`), [APP, API])).toBeNull();
    expect(sandboxFor(third("http://play.example/"), [APP, API])).toBeNull();
    expect(sandboxFor(third("https://user:pw@play.example/"), [APP, API])).toBeNull();
    expect(sandboxFor(third("javascript:alert(1)"), [APP, API])).toBeNull();
    expect(sandboxFor(third("not a url"), [APP, API])).toBeNull();
    // A local dev game server on another port is a different origin.
    expect(sandboxFor(third("http://localhost:5000/"), [APP, API])).toBe(SANDBOX_THIRD_PARTY);
  });

  it("never adds the flags the design forbids", () => {
    for (const s of [SANDBOX_BUILTIN, SANDBOX_THIRD_PARTY]) expect(s).not.toMatch(/top-navigation|popups|modals|forms|downloads|storage-access/);
  });
});

describe("isHello", () => {
  const ok = { vokko: "hello", v: 1 };
  it("accepts the hello from the frame's window and origin", () => {
    expect(isHello(hello(ok), frame, "https://play.example")).toBe(true);
    expect(isHello(hello(ok, { origin: "null" }), frame, "null")).toBe(true);
  });
  it("drops wrong source, wrong origin, wrong shape", () => {
    expect(isHello(hello(ok, { source: {} }), frame, "https://play.example")).toBe(false);
    expect(isHello(hello(ok, { origin: "https://evil.example" }), frame, "https://play.example")).toBe(false);
    expect(isHello(hello(ok, { origin: "null" }), frame, "https://play.example")).toBe(false);
    expect(isHello(hello(ok), null, "https://play.example")).toBe(false);
    expect(isHello(hello(ok), frame, "")).toBe(false);
    expect(isHello(hello({ vokko: "hello", v: 2 }), frame, "https://play.example")).toBe(false);
    expect(isHello(hello("hello"), frame, "https://play.example")).toBe(false);
  });
});

describe("parsePortMessage", () => {
  it("parses the three game messages", () => {
    expect(parsePortMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parsePortMessage({ type: "close", extra: 1 })).toEqual({ type: "close" });
    expect(parsePortMessage({ type: "send", data: { a: 1 } })).toEqual({ type: "send", data: { a: 1 } });
    expect(parsePortMessage({ type: "send", data: null, to: "abc" })).toEqual({ type: "send", data: null, to: "abc" });
  });
  it("drops unknown types and bad shapes", () => {
    expect(parsePortMessage({ type: "token" })).toBeNull();
    expect(parsePortMessage({ type: "send" })).toBeNull();
    expect(parsePortMessage({ type: "send", data: 1, to: 5 })).toBeNull();
    expect(parsePortMessage("ready")).toBeNull();
    expect(parsePortMessage(null)).toBeNull();
  });
});

describe("relay checks", () => {
  const players = [{ app_id: "aaa" }, { app_id: "bbb" }];
  it("measures bytes and refuses what the server would", () => {
    expect(relayBytes({ ping: 1 })).toBe(10);
    expect(relayBytes("é")).toBe(4);
    expect(relayBytes(undefined)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(checkSend(cyclic, undefined, players)).toBe("invalid");
    expect(checkSend("x".repeat(4094), undefined, players)).toBeNull(); // 4096 bytes with the quotes
    expect(checkSend("x".repeat(4095), undefined, players)).toBe("too_large");
    expect(checkSend({ ping: 1 }, "zzz", players)).toBe("invalid");
    expect(checkSend({ ping: 1 }, "bbb", players)).toBeNull();
  });
});

describe("leaderOf", () => {
  it("is the starter while they are in the call, else the smallest app id", () => {
    const players = [
      { user_id: "1", app_id: "m" },
      { user_id: "2", app_id: "c" },
      { user_id: "3", app_id: "x" },
    ];
    expect(leaderOf(players, "3")).toBe("x");
    expect(leaderOf(players, "9")).toBe("c");
    expect(leaderOf([], "9")).toBe("");
  });
});

describe("FrameHost", () => {
  const target = new EventTarget();
  beforeEach(() => {
    vi.stubGlobal("window", target);
  });
  afterEach(() => vi.unstubAllGlobals());

  const send = (data: unknown, origin: string, source: unknown) => target.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  it("hands one port to the frame after its hello, routes port messages, and says close on detach", async () => {
    const contentWindow = { postMessage: vi.fn() };
    const got: GameToHost[] = [];
    const init = vi.fn(() => ({ type: "players" as const, players: [], leader: "" }));
    const host = new FrameHost({ contentWindow } as unknown as HTMLIFrameElement, sketch, { init, onMessage: m => got.push(m) });
    const detach = host.attach();

    // Not the frame's window, or a wrong origin: ignored.
    send({ vokko: "hello", v: 1 }, "null", {});
    send({ vokko: "hello", v: 1 }, APP, contentWindow);
    expect(contentWindow.postMessage).not.toHaveBeenCalled();

    send({ vokko: "hello", v: 1 }, "null", contentWindow);
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
    const [message, targetOrigin, transfer] = contentWindow.postMessage.mock.calls[0] as [unknown, string, MessagePort[]];
    expect(message).toEqual({ vokko: "init", v: 1 });
    expect(targetOrigin).toBe("*");
    expect(init).toHaveBeenCalledTimes(1);
    // A second hello is ignored until a new frame (new host).
    send({ vokko: "hello", v: 1 }, "null", contentWindow);
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);

    const port = transfer[0]!;
    const fromHost: unknown[] = [];
    port.onmessage = e => fromHost.push(e.data);
    port.postMessage({ type: "ready" });
    port.postMessage({ type: "steal-token" });
    port.postMessage({ type: "send", data: { ping: 1 } });
    await tick();
    expect(got).toEqual([{ type: "ready" }, { type: "send", data: { ping: 1 } }]);
    expect(fromHost).toEqual([{ type: "players", players: [], leader: "" }]);

    detach();
    await tick();
    expect(fromHost.at(-1)).toEqual({ type: "close" });
    port.close();
  });

  it("addresses a third-party frame by its exact origin", () => {
    const contentWindow = { postMessage: vi.fn() };
    const host = new FrameHost({ contentWindow } as unknown as HTMLIFrameElement, third("https://play.example/x/"), { init: () => ({ type: "close" }), onMessage: () => undefined });
    const detach = host.attach();
    send({ vokko: "hello", v: 1 }, "null", contentWindow);
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
    send({ vokko: "hello", v: 1 }, "https://play.example", contentWindow);
    expect(contentWindow.postMessage.mock.calls[0]?.[1]).toBe("https://play.example");
    detach();
  });
});

describe("voice reducer GAME_UPDATE", () => {
  const session = { session_id: "0123456789abcdef", game: sketch, started_by: "1", started_at_ms: 1 };
  it("keeps the session per channel, seeds from READY / GUILD_CREATE, and drops it on end and channel delete", () => {
    let m = voiceReducer(initialVoiceModel, { type: "ready", meId: "1", voiceEnabled: true, guilds: [{ id: "g", games: [{ channel_id: "10", state: session }] }] });
    expect(m.games["10"]).toEqual(session);
    m = voiceReducer(m, { type: "guildCreate", guild: { id: "g2", games: [{ channel_id: "20", state: session }] } });
    expect(Object.keys(m.games).sort()).toEqual(["10", "20"]);
    m = voiceReducer(m, { type: "game", channelId: "10", state: null });
    expect(m.games["10"]).toBeUndefined();
    expect(voiceReducer(m, { type: "game", channelId: "10", state: null })).toBe(m);
    m = voiceReducer(m, { type: "channelDelete", channelId: "20" });
    expect(m.games).toEqual({});
  });
});
