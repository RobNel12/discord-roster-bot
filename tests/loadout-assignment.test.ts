import { describe, expect, it } from "vitest";

import { assignLoadout, buildPercentageSlots } from "../src/loadout-assignment.js";
import { loadoutPreferencesFromRoleNames } from "../src/squad-interactions.js";

describe("loadout assignment", () => {
  it("waits for a full percentage slot before allocating secondary roles", () => {
    const roles = [{ name: "Medic", percentage: 10 }, { name: "Recon", percentage: 10, fillPriority: "secondary" as const }];
    for (const size of [1, 5, 9]) {
      const slots = buildPercentageSlots(roles, size);
      expect(slots).toHaveLength(size);
      expect(slots).toContain("Medic");
      expect(slots).not.toContain("Recon");
    }
    expect(buildPercentageSlots(roles, 10).filter(role => role === "Recon")).toHaveLength(1);
    expect(buildPercentageSlots(roles, 20).filter(role => role === "Recon")).toHaveLength(2);
  });

  it("reserves primary minimum slots ahead of secondary allocations", () => {
    const roles = [
      { name: "Recon", percentage: 50, fillPriority: "secondary" as const },
      { name: "Medic", percentage: 10 }, { name: "Engineer", percentage: 10 },
    ];
    expect(buildPercentageSlots(roles, 2)).toEqual(["Medic", "Engineer"]);
  });
  it("keeps reassigned volunteers out of the leftover pool", () => {
    const assignments = assignLoadout(["Medic", "Engineer", "Rifleman"], [
      { id: "flexible", firstChoices: new Set(["medic", "engineer"]), secondChoices: new Set() },
      { id: "medic", firstChoices: new Set(["medic"]), secondChoices: new Set() },
      { id: "other", firstChoices: new Set(), secondChoices: new Set() },
    ], () => 0.99);
    expect(assignments).toEqual([
      { candidateId: "medic", roleName: "Medic" },
      { candidateId: "flexible", roleName: "Engineer" },
      { candidateId: "other", roleName: "Rifleman" },
    ]);
  });
  it("parses Discord preference roles despite case or extra spacing", () => {
    const preferences = loadoutPreferencesFromRoleNames(["1st   Medic ", "2ND Pilot", "Unrelated"]);
    expect([...preferences.first]).toEqual(["medic"]);
    expect([...preferences.second]).toEqual(["pilot"]);
  });

  it("assigns the only member Medic from a 10% first-choice configuration", () => {
    const preferences = loadoutPreferencesFromRoleNames(["1st Medic"]);
    const slots = buildPercentageSlots([{ name: "Medic", percentage: 10 }], 1);
    expect(assignLoadout(slots, [{
      id: "member",
      firstChoices: preferences.first,
      secondChoices: preferences.second,
    }])).toEqual([{ candidateId: "member", roleName: "Medic" }]);
  });

  it("rounds percentage allocations down and gives every leftover slot to Rifleman", () => {
    expect(buildPercentageSlots([
      { name: "Medic", percentage: 20 },
      { name: "Grenadier", percentage: 20 },
    ], 6)).toEqual(["Medic", "Grenadier", "Rifleman", "Rifleman", "Rifleman", "Rifleman"]);
  });

  it("adds rounding leftovers to a configured Rifleman allocation", () => {
    expect(buildPercentageSlots([
      { name: "Medic", percentage: 33 },
      { name: "Rifleman", percentage: 67 },
    ], 6)).toEqual(["Medic", "Rifleman", "Rifleman", "Rifleman", "Rifleman", "Rifleman"]);
  });

  it("gives a positive configured percentage one slot instead of rounding it to zero", () => {
    expect(buildPercentageSlots([
      { name: "Pilot", percentage: 10 },
    ], 6)).toEqual(["Pilot", "Rifleman", "Rifleman", "Rifleman", "Rifleman", "Rifleman"]);
  });

  it("lets a second choice take a minimum percentage slot when the first choice is not configured", () => {
    const slots = buildPercentageSlots([{ name: "Pilot", percentage: 10 }], 6);
    const assignments = assignLoadout(slots, [
      { id: "member", firstChoices: new Set(), secondChoices: new Set(["pilot"]) },
    ]);
    expect(assignments).toEqual([{ candidateId: "member", roleName: "Pilot" }]);
  });

  it("prefers first choices, then second choices, regardless of input order", () => {
    const assignments = assignLoadout(["Medic", "Rifleman"], [
      { id: "alice", firstChoices: new Set(["medic"]), secondChoices: new Set() },
      { id: "bob", firstChoices: new Set(), secondChoices: new Set(["medic"]) },
    ]);
    expect(assignments).toEqual(expect.arrayContaining([
      { candidateId: "alice", roleName: "Medic" },
      { candidateId: "bob", roleName: "Rifleman" },
    ]));
  });

  it("fills no more slots than there are members", () => {
    expect(assignLoadout(["Medic", "Rifleman"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set() },
    ])).toHaveLength(1);
  });

  it("does not force an unpreferred specialist role onto a member", () => {
    expect(assignLoadout(["Engineer"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set() },
    ])).toEqual([{ candidateId: "alice", roleName: "Rifleman" }]);
  });

  it("fills a specialist requirement from a second-choice volunteer", () => {
    expect(assignLoadout(["Engineer"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set(["engineer"]) },
    ])).toEqual([{ candidateId: "alice", roleName: "Engineer" }]);
  });

  it("gives either same-tier volunteer a chance using the shuffled order", () => {
    const candidates: import("../src/loadout-assignment.js").LoadoutCandidate[] = [
      { id: "active-generalist", firstChoices: new Set(["engineer"]), secondChoices: new Set() },
      { id: "experienced-engineer", firstChoices: new Set(["engineer"]), secondChoices: new Set() },
    ];
    expect(assignLoadout(["Engineer"], candidates, () => 0)).toEqual([{ candidateId: "experienced-engineer", roleName: "Engineer" }]);
    expect(assignLoadout(["Engineer"], candidates, () => 0.99)).toEqual([{ candidateId: "active-generalist", roleName: "Engineer" }]);
  });

  it("uses second choices only as fallbacks after first choices are protected", () => {
    const assignments = assignLoadout(["Medic", "Rifleman", "Rifleman"], [
      { id: "first-medic", firstChoices: new Set(["medic"]), secondChoices: new Set() },
      { id: "fallback-medic", firstChoices: new Set(), secondChoices: new Set(["medic"]) },
      { id: "rifleman", firstChoices: new Set(["rifleman"]), secondChoices: new Set() },
    ]);
    expect(assignments).toEqual(expect.arrayContaining([
      { candidateId: "first-medic", roleName: "Medic" },
      { candidateId: "fallback-medic", roleName: "Rifleman" },
      { candidateId: "rifleman", roleName: "Rifleman" },
    ]));
  });
});
