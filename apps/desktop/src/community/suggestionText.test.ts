import { describe, expect, it } from "vitest";
import { commonText } from "./suggestionText";

describe("commonText", () => {
  it("lists what two people share", () => {
    expect(commonText(0, [])).toBe("Might know each other");
    expect(commonText(1, [])).toBe("1 mutual friend");
    expect(commonText(3, ["Pixel Pals"])).toBe("3 mutual friends · Both in Pixel Pals");
    expect(commonText(0, ["A", "B"])).toBe("2 mutual servers");
  });
});
