import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Static rendering reads a zustand store's initial state, so the page gets a fixed one.
const state = vi.hoisted(() => ({
  share: true,
  detected: null,
  running: [],
  icons: {},
  registered: [{ name: "Google Chrome", exe: ["chrome.exe"], icon: "iVBORw0KGgo=" }, { name: "Claude", exe: ["claude.exe"] }],
}));
vi.mock("../../activity", async importOriginal => ({
  ...(await importOriginal<typeof import("../../activity")>()),
  useActivity: (select: (s: typeof state) => unknown) => select(state),
}));

import { RegisteredGamesPage } from "./RegisteredGamesPage";

describe("RegisteredGamesPage", () => {
  it("talks about apps, not games, and lists added apps with their icons", () => {
    const html = renderToStaticMarkup(<RegisteredGamesPage />);
    for (const text of ["App Detection", "Added Apps", "No app detected", "Google Chrome", "Claude", "Not seeing your app? Add it!"]) expect(html).toContain(text);
    expect(html).not.toContain("Game Detection");
    expect(html).not.toContain("Added Games");
    expect(html).toContain("data:image/png;base64,iVBORw0KGgo=");
  });
});
