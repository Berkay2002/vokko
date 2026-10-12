import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const startThread = vi.fn();
const send = vi.fn();
const go = vi.fn();
const openThread = vi.fn();
const upsertChannel = vi.fn();

vi.mock("../api/rest", () => ({
  request: (...args: unknown[]) => request(...args),
  startThread: (...args: unknown[]) => startThread(...args),
  ApiRequestError: class extends Error {},
}));
vi.mock("../api/store", () => ({ appStore: { getState: () => ({ me: { id: "1", username: "me" }, upsertChannel }) } }));
vi.mock("../chat/messageStore", () => ({ messageStore: { send: (...args: unknown[]) => send(...args) } }));
vi.mock("../shell/nav", () => ({ go: (...args: unknown[]) => go(...args), dmPath: (id: string) => `/channels/@me/${id}` }));
vi.mock("../threads/threadUi", () => ({ openThread: (...args: unknown[]) => openThread(...args) }));

import { latestOnly, runMsg, runNick, runThread, searchGifs } from "./builtinActions";

const env = { channelId: "c1", guildId: "g1" };

beforeEach(() => vi.clearAllMocks());

describe("/nick", () => {
  it("patches the own member and reports the new nickname", async () => {
    request.mockResolvedValue({});
    await expect(runNick(env, { new_nick: " Bob " })).resolves.toBe("Your nickname on this server has been changed to Bob.");
    expect(request).toHaveBeenCalledWith("PATCH", "/guilds/g1/members/@me", { nick: "Bob" });
  });
  it("resets the nickname with an empty value", async () => {
    request.mockResolvedValue({});
    await expect(runNick(env, { new_nick: "" })).resolves.toBe("Your nickname on this server has been reset.");
    expect(request).toHaveBeenCalledWith("PATCH", "/guilds/g1/members/@me", { nick: null });
  });
  it("needs a server and surfaces the route's error", async () => {
    await expect(runNick({ channelId: "d", guildId: null }, { new_nick: "x" })).rejects.toThrow("only exist in servers");
    request.mockRejectedValue(new Error("Missing Permissions"));
    await expect(runNick(env, { new_nick: "x" })).rejects.toThrow("Missing Permissions");
  });
});

describe("/msg", () => {
  it("opens the DM, sends the message there and navigates to it", async () => {
    request.mockResolvedValueOnce({ id: "dm9" }).mockResolvedValue({});
    await runMsg(env, { user: "42", message: " hello " });
    expect(request).toHaveBeenCalledWith("POST", "/users/@me/channels", { recipient_id: "42" });
    expect(upsertChannel).toHaveBeenCalledWith({ id: "dm9" });
    expect(request).toHaveBeenCalledWith("POST", "/channels/dm9/messages", { content: "hello" });
    expect(go).toHaveBeenCalledWith("/channels/@me/dm9");
  });
  it("sends nothing when the DM cannot be opened", async () => {
    request.mockRejectedValue(new Error("Cannot send messages to this user"));
    await expect(runMsg(env, { user: "42", message: "hi" })).rejects.toThrow("Cannot send");
    expect(request).not.toHaveBeenCalledWith("POST", expect.stringContaining("/messages"), expect.anything());
  });
});

describe("/thread", () => {
  it("starts a thread without a starter message, posts in it and opens the panel", async () => {
    startThread.mockResolvedValue({ id: "t1" }); request.mockResolvedValue({});
    await runThread(env, { name: " Plans ", message: "first" });
    expect(startThread).toHaveBeenCalledWith("c1", { name: "Plans" });
    expect(openThread).toHaveBeenCalledWith({ id: "t1" });
    expect(request).toHaveBeenCalledWith("POST", "/channels/t1/messages", { content: "first" });
  });
  it("opens the thread anyway and reports when the post fails", async () => {
    startThread.mockResolvedValue({ id: "t1" });
    request.mockRejectedValue(new Error("Missing Permissions"));
    await expect(runThread(env, { name: "x", message: "y" })).rejects.toThrow("thread was created, but the message was not sent: Missing Permissions");
    expect(openThread).toHaveBeenCalledWith({ id: "t1" });
  });
  it("posts nothing when the thread cannot be created", async () => {
    startThread.mockRejectedValue(new Error("Missing Permissions"));
    await expect(runThread(env, { name: "x", message: "y" })).rejects.toThrow("Missing Permissions");
    expect(request).not.toHaveBeenCalledWith("POST", expect.stringContaining("/messages"), expect.anything());
  });
});

describe("latestOnly", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };
  it("drops an older answer that arrives after a newer one", async () => {
    const latest = latestOnly();
    const cat = deferred<string>();
    const cats = deferred<string>();
    const first = latest(cat.promise);
    const second = latest(cats.promise);
    cats.resolve("cats");
    cat.resolve("cat");
    await expect(second).resolves.toBe("cats");
    await expect(first).resolves.toBeNull();
  });
  it("ignores an older failure but reports the latest one", async () => {
    const latest = latestOnly();
    const a = deferred<string>();
    const b = deferred<string>();
    const first = latest(a.promise);
    const second = latest(b.promise);
    a.reject(new Error("old"));
    b.reject(new Error("new"));
    await expect(first).resolves.toBeNull();
    await expect(second).rejects.toThrow("new");
  });
});

describe("/nick limit", () => {
  it("rejects a nickname over 32 characters", async () => {
    await expect(runNick(env, { new_nick: "x".repeat(33) })).rejects.toThrow("32 characters");
  });
});

describe("/gif", () => {
  it("searches the GIF route and returns the results", async () => {
    request.mockResolvedValue({ provider: "mock", results: [{ id: "a", title: "cat", url: "https://x/cat.gif" }], next: null });
    const list = await searchGifs("cats");
    expect(request).toHaveBeenCalledWith("GET", "/gifs/search?q=cats&limit=12");
    expect(list.map(g => g.url)).toEqual(["https://x/cat.gif"]);
  });
});
