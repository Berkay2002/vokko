import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TermsLink } from "./RegisterPage";

describe("TermsLink", () => {
  it("links only http(s) terms URLs", () => {
    expect(renderToStaticMarkup(<TermsLink url="https://example.test/terms" />)).toContain('href="https://example.test/terms"');
    expect(renderToStaticMarkup(<TermsLink url="javascript:alert(1)" />)).toBe("");
    expect(renderToStaticMarkup(<TermsLink url={null} />)).toBe("");
  });
});
