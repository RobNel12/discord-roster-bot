import { describe, expect, it } from "vitest";

import { ENLISTED_RANKS, officerRankForSeconds, rankDisplayName, rankForSeconds, requiredSecondsForRank } from "../src/ranks.js";

describe("voice activity ranks", () => {
  it("progresses through abbreviated enlisted ranks at persisted thresholds", () => {
    expect(rankForSeconds(0)).toBe("PVT");
    expect(rankForSeconds(3_599)).toBe("PVT");
    expect(rankForSeconds(3_600)).toBe("PV2");
    expect(rankForSeconds(7_200)).toBe("PFC");
    expect(rankForSeconds(Number.MAX_SAFE_INTEGER)).toBe("SGM");
    expect(ENLISTED_RANKS.map((rank) => rank.abbreviation)).toEqual([
      "PVT", "PV2", "PFC", "SPC", "SGT", "SSG", "SFC", "MSG", "1SG", "SGM",
    ]);
  });

  it("caps squad managers at COL while server managers can reach GEN", () => {
    expect(officerRankForSeconds(0, false)).toBe("2LT");
    expect(officerRankForSeconds(Number.MAX_SAFE_INTEGER, false)).toBe("COL");
    expect(officerRankForSeconds(Number.MAX_SAFE_INTEGER, true)).toBe("GEN");
  });

  it("maps admin rank choices back to their counter thresholds", () => {
    expect(requiredSecondsForRank("SSG")).toBe(36_000);
    expect(requiredSecondsForRank("SGM")).toBe(180_000);
    expect(requiredSecondsForRank("1LT")).toBe(10_800);
    expect(requiredSecondsForRank("CPT")).toBe(32_400);
    expect(requiredSecondsForRank("MAJ")).toBe(75_600);
    expect(requiredSecondsForRank("LTC")).toBe(129_600);
    expect(requiredSecondsForRank("COL")).toBe(180_000);
    expect(requiredSecondsForRank("BG")).toBe(230_400);
    expect(requiredSecondsForRank("MG")).toBe(309_600);
    expect(requiredSecondsForRank("LTG")).toBe(360_000);
    expect(requiredSecondsForRank("GEN")).toBe(540_000);
    expect(requiredSecondsForRank("CSM")).toBe(0);
    expect(requiredSecondsForRank("invalid")).toBeNull();
  });

  it("renders rank codes as readable military abbreviations", () => {
    expect(rankDisplayName("SGM")).toBe("Sgt. Maj.");
    expect(rankDisplayName("LTC")).toBe("Lt. Col.");
    expect(rankDisplayName("BG")).toBe("Brig. Gen.");
  });
});
