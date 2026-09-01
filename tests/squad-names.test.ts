import { describe, expect, it } from "vitest";

import { SquadNameError, validateSquadName } from "../src/squad-names.js";

describe("validateSquadName", () => {
  it("trims and collapses whitespace", () => {
    expect(validateSquadName("  Alpha   Team  ")).toEqual({
      name: "Alpha Team",
      normalizedName: "alpha team",
    });
  });

  it("normalizes equivalent Unicode before comparing", () => {
    expect(validateSquadName("ＡＬＰＨＡ").normalizedName).toBe("alpha");
  });

  it("rejects empty, long, and control-character names", () => {
    expect(() => validateSquadName("   ")).toThrow(SquadNameError);
    expect(() => validateSquadName("x".repeat(51))).toThrow(SquadNameError);
    expect(() => validateSquadName("Alpha\u0000")).toThrow(SquadNameError);
  });
});
