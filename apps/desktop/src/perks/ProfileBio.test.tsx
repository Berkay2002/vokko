import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../chat/markdown";
import { bioContext } from "./ProfileBio";

describe("profile bio links", () => {
  it("go through the Leaving Vokko confirmation instead of opening directly", () => {
    const opened: string[] = [];
    const ctx = bioContext(href => opened.push(href));
    expect(ctx.onLink).toBeDefined();
    ctx.onLink?.("https://evil.example/gift");
    expect(opened).toEqual(["https://evil.example/gift"]);
    // a masked link still shows where it goes
    const html = renderToStaticMarkup(<Markdown content="[discord.com/gifts](https://evil.example/gift)" ctx={ctx} />);
    expect(html).toContain('title="https://evil.example/gift"');
  });
});
