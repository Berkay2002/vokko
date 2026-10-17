import { describe, expect, it } from "vitest";
import type { StremioSearchItem } from "../api/types";
import { bestStream, currentView, initialPanel, panelReducer, seasonsOf, type PanelAction, type PanelState } from "./panelState";

const run = (actions: PanelAction[], from: PanelState = initialPanel) => actions.reduce(panelReducer, from);
const show: StremioSearchItem = { id: "tt0903747", type: "series", name: "Breaking Bad" };
const link = { code: "K7QX", link: "https://link.stremio.com/K7QX", expires_at: "2026-10-17T12:00:00Z" };

describe("Stremio panel account flow", () => {
  it("starts loading and learns whether the account is linked", () => {
    expect(initialPanel.account).toBe("loading");
    expect(run([{ type: "account", linked: true }]).account).toBe("linked");
    expect(run([{ type: "account", linked: false }]).account).toBe("unlinked");
    expect(run([{ type: "unavailable" }]).account).toBe("unavailable");
  });

  it("links with a code, falls back to email and back, and links", () => {
    let s = run([{ type: "account", linked: false }, { type: "linkStarted", link }]);
    expect(s).toMatchObject({ account: "linking", link });
    s = run([{ type: "showEmail" }], s);
    expect(s.account).toBe("email");
    expect(run([{ type: "showLink" }], s).account).toBe("linking");
    expect(run([{ type: "linked" }], s)).toMatchObject({ account: "linked", link: null, problem: null });
  });

  it("returns a failed code step to the card and keeps the email form open", () => {
    const linking = run([{ type: "account", linked: false }, { type: "linkStarted", link }]);
    expect(run([{ type: "linkFailed", message: "expired" }], linking)).toMatchObject({ account: "unlinked", link: null, problem: "expired" });
    const email = run([{ type: "showEmail" }], linking);
    expect(run([{ type: "linkFailed", message: "bad password" }], email)).toMatchObject({ account: "email", problem: "bad password" });
    expect(run([{ type: "showLink" }], run([{ type: "account", linked: false }])).account).toBe("unlinked");
  });

  it("unlinking forgets everything the panel showed", () => {
    const s = run([{ type: "account", linked: true }, { type: "query", query: "heat" }, { type: "openTitle", item: show }, { type: "unlinked" }]);
    expect(s).toEqual({ ...initialPanel, account: "unlinked" });
  });
});

describe("Stremio panel navigation", () => {
  it("opens a title, then an episode's streams, and Back pops one step at a time", () => {
    let s = run([{ type: "account", linked: true }, { type: "openTitle", item: show }]);
    expect(currentView(s)).toEqual({ name: "title", item: show });
    s = run([{ type: "openStreams", videoId: "tt0903747:1:2", label: "S1E2" }], s);
    expect(currentView(s)).toMatchObject({ name: "streams", videoId: "tt0903747:1:2", item: show });
    s = run([{ type: "back" }], s);
    expect(currentView(s).name).toBe("title");
    s = run([{ type: "back" }], s);
    expect(currentView(s).name).toBe("home");
    expect(run([{ type: "back" }], s)).toBe(s);
  });

  it("has nothing to open streams for from the home view, and a new query goes back home", () => {
    expect(run([{ type: "openStreams", videoId: "tt1", label: "x" }])).toBe(initialPanel);
    const s = run([{ type: "openTitle", item: show }, { type: "query", query: "heat" }]);
    expect(s).toMatchObject({ query: "heat", trail: [{ name: "home" }] });
  });
});

describe("Stremio panel helpers", () => {
  it("pre-selects the first playable stream", () => {
    expect(bestStream([{ playable: false, n: 1 }, { playable: true, n: 2 }, { playable: true, n: 3 }])?.n).toBe(2);
    expect(bestStream([{ playable: false }])).toBeUndefined();
  });

  it("lists seasons ascending with specials last", () => {
    expect(seasonsOf([{ season: 2 }, { season: 0 }, { season: 1 }, { season: 2 }])).toEqual([1, 2, 0]);
  });
});
