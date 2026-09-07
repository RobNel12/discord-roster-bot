export interface LoadoutCandidate {
  id: string;
  firstChoices: ReadonlySet<string>;
  secondChoices: ReadonlySet<string>;
}

export interface LoadoutAssignment {
  candidateId: string;
  roleName: string;
}

export interface PercentageRole {
  name: string;
  percentage: number;
  fillPriority?: "primary" | "secondary";
  minimumSlots?: number | null;
  maximumSlots?: number | null;
}

export function buildPercentageSlots(roles: readonly PercentageRole[], memberCount: number): string[] {
  return buildLoadoutPlan(roles, memberCount).slots;
}

export interface FillPhase { end: number; equalPreferences: boolean }

export function buildLoadoutPlan(roles: readonly PercentageRole[], memberCount: number, random: () => number = Math.random): { slots: string[]; minimumSlotCount: number; phases: FillPhase[] } {
  if (!Number.isSafeInteger(memberCount) || memberCount <= 0) return { slots: [], minimumSlotCount: 0, phases: [] };
  const ordered = roles.map((role, index) => ({ ...role, index, count: 0 })).sort((a, b) =>
    Number(a.fillPriority === "secondary") - Number(b.fillPriority === "secondary") || b.percentage - a.percentage || a.index - b.index,
  );
  const slots: string[] = [];
  let minimumSlotCount = 0;
  const phases: FillPhase[] = [];
  for (const secondary of [false, true]) {
    const group = ordered.filter(role => (role.fillPriority === "secondary") === secondary);
    if (secondary) shuffle(group, random);
    for (const role of group) {
      const minimum = role.minimumSlots ?? (secondary || role.percentage <= 0 ? 0 : 1);
      role.count = Math.min(minimum, role.maximumSlots ?? memberCount, memberCount - slots.length);
      slots.push(...Array.from({ length: role.count }, () => role.name));
      minimumSlotCount += role.count;
    }
    phases.push({ end: slots.length, equalPreferences: secondary });
    for (const role of group) {
      const target = Math.min(Math.floor(memberCount * role.percentage / 100), role.maximumSlots ?? memberCount);
      const extra = Math.min(Math.max(0, target - role.count), memberCount - slots.length);
      slots.push(...Array.from({ length: extra }, () => role.name));
    }
    phases.push({ end: slots.length, equalPreferences: secondary });
  }
  slots.push(...Array.from({ length: memberCount - slots.length }, () => "Rifleman"));
  phases.push({ end: slots.length, equalPreferences: true });
  return { slots, minimumSlotCount, phases };
}

export function assignLoadout(roleNames: readonly string[], candidates: readonly LoadoutCandidate[], random: () => number = Math.random, minimumSlotCount = 0, riflemanMaximum = Infinity, phases?: readonly FillPhase[]): LoadoutAssignment[] {
  const ordered = [...candidates];
  shuffle(ordered, random);
  const slotOwners = new Map<number, string>();
  const candidateSlots = new Map<string, number>();
  const roleOverrides = new Map<number, string>();

  if (phases) {
    let start = 0;
    for (const phase of phases) {
      const phaseRoles = roleNames.slice(0, phase.end);
      const locked = new Set(Array.from({ length: start }, (_, index) => index));
      if (phase.equalPreferences) {
        const equallyEligible = ordered.map(candidate => ({ ...candidate, firstChoices: new Set([...candidate.firstChoices, ...candidate.secondChoices]) }));
        matchPreferenceTier(equallyEligible, phaseRoles, slotOwners, candidateSlots, "firstChoices", locked);
      } else {
        matchPreferenceTier(ordered, phaseRoles, slotOwners, candidateSlots, "firstChoices", locked);
        matchPreferenceTier(ordered, phaseRoles, slotOwners, candidateSlots, "secondChoices", new Set([...locked, ...slotOwners.keys()]));
      }
      start = phase.end;
    }
  } else {
  if (minimumSlotCount > 0) {
    const minimumRoles = roleNames.slice(0, minimumSlotCount);
    matchPreferenceTier(ordered, minimumRoles, slotOwners, candidateSlots, "firstChoices", new Set());
    matchPreferenceTier(ordered, minimumRoles, slotOwners, candidateSlots, "secondChoices", new Set(slotOwners.keys()));
  }
  matchPreferenceTier(ordered, roleNames, slotOwners, candidateSlots, "firstChoices", new Set(slotOwners.keys()));
  matchPreferenceTier(ordered, roleNames, slotOwners, candidateSlots, "secondChoices", new Set(slotOwners.keys()));
  }

  const openSlots = roleNames.map((_, index) => index).filter((slot) => !slotOwners.has(slot));
  const unmatched = ordered.filter((candidate) => !candidateSlots.has(candidate.id));
  for (let index = 0; index < Math.min(openSlots.length, unmatched.length); index++) {
    const slot = openSlots[index]!;
    const candidate = unmatched[index]!;
    slotOwners.set(slot, candidate.id);
    candidateSlots.set(candidate.id, slot);
    roleOverrides.set(slot, "Rifleman");
  }

  let riflemen = 0;
  return [...slotOwners.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slot, candidateId]) => {
      let roleName = roleOverrides.get(slot) ?? roleNames[slot]!;
      if (roleName.toLocaleLowerCase("en-US") === "rifleman" && ++riflemen > riflemanMaximum) roleName = "Unassigned loadout";
      return { candidateId, roleName };
    });
}

function matchPreferenceTier(
  candidates: readonly LoadoutCandidate[],
  roleNames: readonly string[],
  slotOwners: Map<number, string>,
  candidateSlots: Map<string, number>,
  tier: "firstChoices" | "secondChoices",
  lockedSlots: ReadonlySet<number>,
): void {
  const orderedCandidates = candidates;
  const candidateById = new Map(orderedCandidates.map((candidate) => [candidate.id, candidate]));
  const tryMatch = (candidate: LoadoutCandidate, visited: Set<number>): boolean => {
    const slots = roleNames.map((_, slot) => slot);
    for (const slot of slots) {
      if (visited.has(slot) || (lockedSlots.has(slot) && !slotOwners.has(slot)) || !candidate[tier].has(roleNames[slot]!.toLocaleLowerCase("en-US"))) continue;
      visited.add(slot);
      const ownerId = slotOwners.get(slot);
      if (!ownerId || (!lockedSlots.has(slot) && candidateById.get(ownerId) && tryMatch(candidateById.get(ownerId)!, visited))) {
        // A displaced owner has already been moved to another slot by tryMatch.
        // Keep that assignment recorded so they cannot receive a second loadout.
        slotOwners.set(slot, candidate.id);
        candidateSlots.set(candidate.id, slot);
        return true;
      }
    }
    return false;
  };
  for (const candidate of orderedCandidates) {
    if (!candidateSlots.has(candidate.id)) tryMatch(candidate, new Set());
  }
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
}
