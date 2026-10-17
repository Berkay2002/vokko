import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { preloadLazyModules } from "../ui/lazyModule";
import { ProfileCardLayers, ProfileEffect, ProfileFrame } from "./ProfileEffect";

describe("profile effect and frame ids from other users", () => {
  it("render nothing for Object.prototype keys instead of crashing the card", async () => {
    await preloadLazyModules(); // the frame and scene art, so the lookups below run against the real tables
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(renderToStaticMarkup(<ProfileFrame id={id} />)).toBe("");
      expect(renderToStaticMarkup(<ProfileEffect id={id} />)).toBe("");
      expect(renderToStaticMarkup(<ProfileCardLayers look={{ effect: id, frame: id }} />)).not.toContain("data-");
    }
  });
});
