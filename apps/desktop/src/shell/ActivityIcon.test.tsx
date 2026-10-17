import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appIconUrl } from "../activity/format";
import { registerMockAppIcon } from "../api/appIcons";
import type { Activity } from "../api/types";
import { ActivityIcon } from "./ActivityIcon";

const HASH = "cd".repeat(32);
const DATA = "data:image/png;base64,iVBORw0KGgo=";
const game = (large_image?: string): Activity => ({ name: "Google Chrome", type: 0, ...(large_image ? { assets: { large_image } } : {}) });

describe("appIconUrl", () => {
  it("accepts only a Playing activity with a well-formed app: hash the mock holds", () => {
    registerMockAppIcon(HASH, DATA);
    expect(appIconUrl(game(`app:${HASH}`))).toBe(DATA);
    expect(appIconUrl(game(`app:${HASH.toUpperCase()}`))).toBeNull();
    expect(appIconUrl(game(`app:${HASH}/../x`))).toBeNull();
    expect(appIconUrl(game("https://evil.example/x.png"))).toBeNull();
    expect(appIconUrl(game(`spotify:${"ab".repeat(20)}`))).toBeNull();
    expect(appIconUrl({ ...game(`app:${HASH}`), type: 2 })).toBeNull();
    expect(appIconUrl(game())).toBeNull();
  });
});

describe("ActivityIcon", () => {
  it("shows the app icon, and the pad without one or for an unknown hash", () => {
    registerMockAppIcon(HASH, DATA);
    expect(renderToStaticMarkup(<ActivityIcon activity={game(`app:${HASH}`)} size={20} />)).toContain('data-testid="activity-app-icon"');
    for (const activity of [game(), game(`app:${"ee".repeat(32)}`), null]) {
      const html = renderToStaticMarkup(<ActivityIcon activity={activity} size={20} />);
      expect(html).not.toContain("activity-app-icon");
      expect(html).toContain("<svg");
    }
  });

  it("shows a local data: icon", () => {
    expect(renderToStaticMarkup(<ActivityIcon src={DATA} size={20} fill />)).toContain(`src="${DATA}"`);
  });
});
