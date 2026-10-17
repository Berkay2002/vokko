import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameManifest } from "../api/types";
import { voiceReducer, initialVoiceModel } from "../voice/reducer";
import {
  ALLOW_WEB,
  checkRoomUrl,
  roomFrameUrl,
  checkSend,
  frameAllow,
  FrameHost,
  frameOrigin,
  frameUrl,
  isHello,
  leaderOf,
  parsePortMessage,
  relayBytes,
  sandboxFor,
  SANDBOX_BUILTIN,
  SANDBOX_THIRD_PARTY,
  SANDBOX_WEB,
  type GameToHost,
} from "./frameHost";

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
    // The app's or the API's host on another port or with a trailing dot is still theirs.
    expect(sandboxFor(third("https://vokko.example.:8443/x/"), [APP, API])).toBeNull();
    expect(sandboxFor(third("https://vokko.example:444/x/"), [APP, API])).toBeNull();
    expect(sandboxFor(third("http://127.0.0.1:5000/"), [APP, API])).toBeNull();
    // A local dev game server on another host is fine in dev and mock builds only.
    expect(sandboxFor(third("http://localhost:5000/"), [APP, API], true)).toBe(SANDBOX_THIRD_PARTY);
    expect(sandboxFor(third("http://localhost:5000/"), [APP, API], false)).toBeNull();
  });

  it("never adds the flags the design forbids", () => {
    for (const s of [SANDBOX_BUILTIN, SANDBOX_THIRD_PARTY]) expect(s).not.toMatch(/top-navigation|popups|modals|forms|downloads|storage-access/);
    expect(SANDBOX_WEB).not.toMatch(/top-navigation|modals|downloads|storage-access/);
  });
});

describe("website games", () => {
  const web = (url: string, id = "123"): GameManifest => ({ ...third(url), id, kind: "web" });

  it("get forms, popups that leave the sandbox, fullscreen and the like, on their own origin only", () => {
    expect(sandboxFor(web("https://skribbl.io/"), [APP, API])).toBe(SANDBOX_WEB);
    expect(SANDBOX_WEB.split(" ").sort()).toEqual(["allow-forms", "allow-pointer-lock", "allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin", "allow-scripts"]);
    expect(frameAllow(web("https://skribbl.io/"))).toBe(ALLOW_WEB);
    expect(ALLOW_WEB).toBe("fullscreen; clipboard-write; autoplay; gamepad");
    expect(frameAllow(third("https://play.example/"))).toBe("");
    expect(frameAllow(sketch)).toBe("");
    // The own-origin and https rules still hold.
    expect(sandboxFor(web(`${API}/x/`), [APP, API])).toBeNull();
    expect(sandboxFor(web("http://skribbl.io/"), [APP, API])).toBeNull();
  });

  it("built-ins come from the client's own list: the server cannot turn Sketch into a website game or move a site", () => {
    expect(sandboxFor({ ...sketch, kind: "web" }, [APP, API])).toBe(SANDBOX_BUILTIN);
    expect(frameAllow({ ...sketch, kind: "web" })).toBe("");
    const krunker = web("https://evil.example/", "builtin:krunker");
    expect(frameUrl(krunker, APP)).toBe("https://krunker.io/");
    expect(frameOrigin(krunker)).toBe("https://krunker.io");
    expect(sandboxFor({ ...krunker, kind: "sdk" }, [APP, API])).toBe(SANDBOX_WEB);
  });

  it("room links stay on the game's host", () => {
    expect(checkRoomUrl("https://krunker.io/", "https://krunker.io/?game=FRA:abc12")).toBe("https://krunker.io/?game=FRA:abc12");
    expect(checkRoomUrl("https://krunker.io/", " https://www.krunker.io/r ")).toBe("https://www.krunker.io/r");
    expect(checkRoomUrl("https://shellshock.io/", "https://shellshock.io/#AbC1")).toBe("https://shellshock.io/#AbC1");
    expect(checkRoomUrl("https://krunker.io/", "https://KRUNKER.io./x")).toBe("https://krunker.io./x");
    for (const bad of ["http://krunker.io/", "https://u@krunker.io/", "https://u:p@krunker.io/", "https://evilkrunker.io/", "https://krunker.io.evil.example/", "javascript:alert(1)", "/?game=1", ""]) {
      expect(checkRoomUrl("https://krunker.io/", bad), bad).toBeNull();
    }
    expect(checkRoomUrl("https://krunker.io/", `https://krunker.io/?${"x".repeat(512 - 20)}`)).not.toBeNull();
    expect(checkRoomUrl("https://krunker.io/", `https://krunker.io/?${"x".repeat(513 - 20)}`)).toBeNull();
  });

  it("loads a room link only on the client's game host and never on the app's hosts", () => {
    const krunker: GameManifest = { id: "builtin:krunker", name: "Krunker", url: "https://krunker.io/", min_players: 2, max_players: 16, aspect: "16:9", kind: "web" };
    expect(roomFrameUrl(krunker, "https://krunker.io/?game=FRA:abc12", [APP, API])).toBe("https://krunker.io/?game=FRA:abc12");
    expect(roomFrameUrl({ ...krunker, url: "https://evil.example/" }, "https://evil.example/", [APP, API])).toBeNull();
    const parent: GameManifest = { ...third("https://example.com/"), kind: "web" };
    expect(roomFrameUrl(parent, "https://play.example.com/r", ["https://app.example.com"])).toBe("https://play.example.com/r");
    expect(roomFrameUrl(parent, "https://app.example.com/", ["https://app.example.com"])).toBeNull();
    expect(roomFrameUrl(parent, "https://example.com/", ["https://app.example.com"])).toBeNull();
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
    expect(parsePortMessage({ type: "escape" })).toEqual({ type: "escape" });
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
