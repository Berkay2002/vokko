import { describe, expect, it } from "vitest";
import { DETECTABLE_GAMES, guessDisplayName, matchGame, normalizeExe, unregisteredProcesses, type RunningProcess } from "./games";

const proc = (name: string, startedAt = 1_000, system = false): RunningProcess => ({ name, startedAt, system });

describe("the shipped detectable-games list", () => {
  it("has about fifty entries with a display name and executables", () => {
    expect(DETECTABLE_GAMES.length).toBeGreaterThanOrEqual(50);
    for (const game of DETECTABLE_GAMES) {
      expect(game.name.trim()).not.toBe("");
      expect(game.name.length).toBeLessThanOrEqual(128);
      expect(game.exe.length).toBeGreaterThan(0);
    }
  });

  it("does not list one executable under two games", () => {
    const seen = new Map<string, string>();
    for (const game of DETECTABLE_GAMES) {
      for (const exe of game.exe) {
        const key = normalizeExe(exe);
        expect(seen.get(key), `${exe} is in ${seen.get(key)} and ${game.name}`).toBeUndefined();
        seen.set(key, game.name);
      }
    }
  });
});

describe("normalizeExe", () => {
  it("ignores case, a trailing .exe and any directory", () => {
    expect(normalizeExe("EldenRing.EXE")).toBe("eldenring");
    expect(normalizeExe("eldenring")).toBe("eldenring");
    expect(normalizeExe("C:\\Games\\Elden Ring\\eldenring.exe")).toBe("eldenring");
    expect(normalizeExe("  Stardew Valley.exe ")).toBe("stardew valley");
  });
});

describe("matchGame", () => {
  it("finds a shipped game by executable name, case-insensitively", () => {
    expect(matchGame([proc("svchost.exe"), proc("ELDENRING.exe", 5_000)])).toEqual({ name: "Elden Ring", exe: "ELDENRING.exe", startedAt: 5_000 });
  });

  it("returns null when nothing matches", () => {
    expect(matchGame([proc("explorer.exe"), proc("chrome.exe")])).toBeNull();
    expect(matchGame([])).toBeNull();
  });

  it("uses the games the user added, and lets them rename a shipped one", () => {
    const mine = [{ name: "My Indie Game", exe: ["indie.exe"] }, { name: "Elden Ring (modded)", exe: ["eldenring.exe"] }];
    expect(matchGame([proc("indie.exe")], mine)?.name).toBe("My Indie Game");
    expect(matchGame([proc("eldenring.exe")], mine)?.name).toBe("Elden Ring (modded)");
  });

  it("never matches an OS program", () => {
    expect(matchGame([proc("eldenring.exe", 1, true)])).toBeNull();
  });

  it("keeps the game that started first when several run", () => {
    const found = matchGame([proc("terraria.exe", 9_000), proc("factorio.exe", 2_000), proc("valheim.exe", 5_000)]);
    expect(found?.name).toBe("Factorio");
  });

  it("prefers a known start time over an unknown one", () => {
    expect(matchGame([proc("terraria.exe", 0), proc("factorio.exe", 7_000)])?.name).toBe("Factorio");
  });

  it("ranks a running game above an always-open app, however long the app has been open", () => {
    expect(matchGame([proc("Code.exe", 1_000), proc("obs64.exe", 2_000), proc("terraria.exe", 90_000)])?.name).toBe("Terraria");
    expect(matchGame([proc("terraria.exe", 90_000), proc("Code.exe", 1_000)])?.name).toBe("Terraria");
  });

  it("falls back to the app that started first when no game runs", () => {
    expect(matchGame([proc("obs64.exe", 5_000), proc("Code.exe", 2_000)])?.name).toBe("Visual Studio Code");
  });

  it("treats an app the user registered as a game", () => {
    const mine = [{ name: "My Editor", exe: ["myeditor.exe"] }];
    expect(matchGame([proc("Code.exe", 1_000), proc("myeditor.exe", 9_000)], mine)?.name).toBe("My Editor");
  });
});

describe("unregisteredProcesses", () => {
  it("hides OS programs and everything already known", () => {
    const list = [proc("eldenring.exe"), proc("svchost.exe", 1, true), proc("mygame.exe"), proc("Indie.exe")];
    const mine = [{ name: "Indie", exe: ["indie.exe"] }];
    expect(unregisteredProcesses(list, mine).map(p => p.name)).toEqual(["mygame.exe"]);
  });

  it("hides programs whose path the OS does not reveal, but still matches them as games", () => {
    const hidden: RunningProcess = { name: "mystery.exe", startedAt: 1, system: false, pathKnown: false };
    expect(unregisteredProcesses([hidden])).toEqual([]);
    expect(matchGame([{ name: "eldenring.exe", startedAt: 1, system: false, pathKnown: false }])?.name).toBe("Elden Ring");
  });
});

describe("guessDisplayName", () => {
  it("turns a file name into something readable", () => {
    expect(guessDisplayName("my_cool-game.exe")).toBe("my cool game");
    expect(guessDisplayName("C:\\Games\\Foo.exe")).toBe("Foo");
  });
});
