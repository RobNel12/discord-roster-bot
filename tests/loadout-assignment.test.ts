import { describe, expect, it } from "vitest";

import { assignLoadout, buildPercentageSlots } from "../src/loadout-assignment.js";
import { loadoutPreferencesFromRoleNames } from "../src/squad-interactions.js";

describe("loadout assignment", () => {
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
      activitySeconds: 0,
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
      { id: "member", firstChoices: new Set(), secondChoices: new Set(["pilot"]), activitySeconds: 0 },
    ]);
    expect(assignments).toEqual([{ candidateId: "member", roleName: "Pilot" }]);
  });

  it("prefers first choices, then second choices, regardless of input order", () => {
    const assignments = assignLoadout(["Medic", "Rifleman"], [
      { id: "alice", firstChoices: new Set(["medic"]), secondChoices: new Set(), activitySeconds: 0 },
      { id: "bob", firstChoices: new Set(), secondChoices: new Set(["medic"]), activitySeconds: 99_999 },
    ]);
    expect(assignments).toEqual(expect.arrayContaining([
      { candidateId: "alice", roleName: "Medic" },
      { candidateId: "bob", roleName: "Rifleman" },
    ]));
  });

  it("fills no more slots than there are members", () => {
    expect(assignLoadout(["Medic", "Rifleman"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set(), activitySeconds: 0 },
    ])).toHaveLength(1);
  });

  it("does not force an unpreferred specialist role onto a member", () => {
    expect(assignLoadout(["Engineer"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set(), activitySeconds: 0 },
    ])).toEqual([{ candidateId: "alice", roleName: "Rifleman" }]);
  });

  it("fills a specialist requirement from a second-choice volunteer", () => {
    expect(assignLoadout(["Engineer"], [
      { id: "alice", firstChoices: new Set(), secondChoices: new Set(["engineer"]), activitySeconds: 0 },
    ])).toEqual([{ candidateId: "alice", roleName: "Engineer" }]);
  });

  it("prioritizes the volunteer with more tracked time in that specific role", () => {
    expect(assignLoadout(["Engineer"], [
      { id: "active-generalist", firstChoices: new Set(["engineer"]), secondChoices: new Set(), roleActivitySeconds: new Map([["engineer", 60]]), activitySeconds: 10_000 },
      { id: "experienced-engineer", firstChoices: new Set(["engineer"]), secondChoices: new Set(), roleActivitySeconds: new Map([["engineer", 3_600]]), activitySeconds: 100 },
    ])).toEqual([{ candidateId: "experienced-engineer", roleName: "Engineer" }]);
  });

  it("uses second choices only as fallbacks after first choices are protected", () => {
    const assignments = assignLoadout(["Medic", "Rifleman", "Rifleman"], [
      { id: "first-medic", firstChoices: new Set(["medic"]), secondChoices: new Set(), activitySeconds: 1 },
      { id: "fallback-medic", firstChoices: new Set(), secondChoices: new Set(["medic"]), activitySeconds: 10_000 },
      { id: "rifleman", firstChoices: new Set(["rifleman"]), secondChoices: new Set(), activitySeconds: 2 },
    ]);
    expect(assignments).toEqual(expect.arrayContaining([
      { candidateId: "first-medic", roleName: "Medic" },
      { candidateId: "fallback-medic", roleName: "Rifleman" },
      { candidateId: "rifleman", roleName: "Rifleman" },
    ]));
  });
});
