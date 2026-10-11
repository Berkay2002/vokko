import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutEvent } from "../desktop";

vi.mock("../desktop", () => ({
  isDesktop: () => false,
  registerShortcut: async () => undefined,
  unregisterShortcut: async () => undefined,
  onShortcut: async () => () => undefined,
}));

import { acceleratorFromEvent, bindPtt, hasModifier, matchesDown, matchesUp, probeShortcut, usePttGlobal, type ShortcutAdapter } from "./ptt";

const key = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("push-to-talk accelerators", () => {
  it("formats key presses in the desktop adapter's accelerator format", () => {
    expect(acceleratorFromEvent(key("KeyK", "k", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
    expect(acceleratorFromEvent(key("F13", "F13"))).toBe("F13");
    expect(acceleratorFromEvent(key("Backquote", "`"))).toBe("`");
    expect(acceleratorFromEvent(key("Digit4", "4", { altKey: true }))).toBe("Alt+4");
    expect(acceleratorFromEvent(key("ShiftLeft", "Shift", { shiftKey: true }))).toBeNull();
  });

  it("keydown needs the exact modifiers, keyup only the main key", () => {
    expect(matchesDown("Ctrl+K", key("KeyK", "k", { ctrlKey: true }))).toBe(true);
    expect(matchesDown("Ctrl+K", key("KeyK", "k"))).toBe(false);
    expect(matchesDown("Ctrl+K", key("KeyK", "k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesUp("Ctrl+K", key("KeyK", "k"))).toBe(true);
    expect(matchesUp("Ctrl+K", key("KeyJ", "j"))).toBe(false);
  });

  it("knows whether a binding has a modifier (bare keys are ignored while typing)", () => {
    expect(hasModifier("`")).toBe(false);
    expect(hasModifier("Alt+F13")).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Desktop shortcut adapter whose register calls resolve when the test says so. */
function fakeAdapter(opts: { onShortcutFails?: boolean } = {}) {
  const log: string[] = [];
  const registered = new Map<string, string>();
  const pending: { id: string; done: ReturnType<typeof deferred<void>> }[] = [];
  const listeners = new Set<(event: ShortcutEvent) => void>();
  const adapter: ShortcutAdapter = {
    isDesktop: () => true,
    registerShortcut(id, accelerator) {
      log.push(`register ${id}`);
      const done = deferred<void>();
      pending.push({ id, done });
      return done.promise.then(() => {
        if ([...registered.values()].includes(accelerator)) throw new Error("taken");
        registered.set(id, accelerator);
      });
    },
    async unregisterShortcut(id) {
      log.push(`unregister ${id}`);
      registered.delete(id);
    },
    async onShortcut(handler) {
      if (opts.onShortcutFails) throw new Error("no event channel");
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const fire = (id: string, state: ShortcutEvent["state"]) => listeners.forEach(fn => fn({ id, state }));
  return { adapter, log, registered, pending, listeners, fire };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("push-to-talk global binding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a stale registration finishing late cannot clobber the newer binding", async () => {
    vi.stubGlobal("window", new EventTarget());
    const fake = fakeAdapter();
    const first: boolean[] = [];
    const second: boolean[] = [];
    const unbind1 = bindPtt("F13", on => first.push(on), fake.adapter);
    await settle();
    unbind1(); // rebind before the first registration finished
    const unbind2 = bindPtt("F13", on => second.push(on), fake.adapter);
    await settle();
    // Old registration completes: it is released before the new one registers the same accelerator.
    fake.pending[0]!.done.resolve();
    await settle();
    fake.pending[1]!.done.resolve();
    await settle();
    const [id1, id2] = fake.log.filter(l => l.startsWith("register")).map(l => l.split(" ")[1]!);
    expect(id1).not.toBe(id2);
    expect(fake.log).toEqual([`register ${id1}`, `unregister ${id1}`, `register ${id2}`]);
    expect([...fake.registered.entries()]).toEqual([[id2, "F13"]]);
    expect(fake.listeners.size).toBe(1);
    fake.fire(id1!, "pressed"); // the old id does nothing
    fake.fire(id2!, "pressed");
    fake.fire(id2!, "released");
    expect(first).toEqual([]);
    expect(second).toEqual([true, false]);
    unbind2();
    await settle();
    expect(fake.registered.size).toBe(0);
    expect(fake.listeners.size).toBe(0);
  });

  it("an old binding's unregister never removes a newer binding's registration", async () => {
    vi.stubGlobal("window", new EventTarget());
    const fake = fakeAdapter();
    const unbind1 = bindPtt("F13", () => undefined, fake.adapter);
    await settle();
    fake.pending[0]!.done.resolve();
    await settle();
    const unbind2 = bindPtt("F14", () => undefined, fake.adapter);
    unbind1();
    await settle();
    fake.pending[1]!.done.resolve();
    await settle();
    expect([...fake.registered.values()]).toEqual(["F14"]);
    unbind2();
    await settle();
    expect(fake.registered.size).toBe(0);
  });

  it("unregisters again when the shortcut event channel fails after registering, and falls back to the window", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const fake = fakeAdapter({ onShortcutFails: true });
    const states: boolean[] = [];
    bindPtt("F13", on => states.push(on), fake.adapter);
    await settle();
    fake.pending[0]!.done.resolve();
    await settle();
    const id = fake.log[0]!.split(" ")[1];
    expect(fake.log).toEqual([`register ${id}`, `unregister ${id}`]);
    expect(fake.registered.size).toBe(0);
    const keyEvent = (type: string) => Object.assign(new Event(type), { code: "F13", key: "F13", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false });
    win.dispatchEvent(keyEvent("keydown"));
    win.dispatchEvent(keyEvent("keyup"));
    expect(states).toEqual([true, false]);
  });
});

describe("when the OS refuses the global shortcut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    usePttGlobal.setState({ refused: null });
  });

  it("says so, keeps listening in the window, and clears the note on unbind", async () => {
    vi.stubGlobal("window", new EventTarget());
    const fake = fakeAdapter();
    fake.registered.set("other-app", "F13");
    const unbind = bindPtt("F13", () => undefined, fake.adapter);
    await settle();
    fake.pending[0]!.done.resolve();
    await settle();
    expect(usePttGlobal.getState().refused).toMatch(/did not allow this shortcut \(taken\).*only work while Vokko is focused/);
    unbind();
    await settle();
    expect(usePttGlobal.getState().refused).toBeNull();
  });

  it("probeShortcut reports a refusal and releases a free accelerator again", async () => {
    const fake = fakeAdapter();
    const refused = probeShortcut("F14", fake.adapter);
    await settle();
    fake.pending[0]!.done.resolve();
    expect(await refused).toBeNull();
    expect(fake.registered.size).toBe(0);
    fake.registered.set("other-app", "F14");
    const taken = probeShortcut("F14", fake.adapter);
    await settle();
    fake.pending[1]!.done.resolve();
    expect(await taken).toMatch(/taken/);
  });
});
