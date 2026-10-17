import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PosterImage } from "./PosterImage";

it("renders the fallback without a URL and the image with one", () => {
  const fallback = <i>none</i>;
  expect(renderToStaticMarkup(<PosterImage fallback={fallback} />)).toBe("<i>none</i>");
  const html = renderToStaticMarkup(<PosterImage src="https://images.metahub.space/p.jpg" lazy fallback={fallback} />);
  expect(html).toContain('src="https://images.metahub.space/p.jpg"');
  expect(html).toContain('loading="lazy"');
  expect(html).not.toContain("none");
});
