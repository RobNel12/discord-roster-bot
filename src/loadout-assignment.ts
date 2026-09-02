export interface LoadoutCandidate {
  id: string;
  firstChoices: ReadonlySet<string>;
  secondChoices: ReadonlySet<string>;
  roleActivitySeconds?: ReadonlyMap<string, number>;
  activitySeconds: number;
}

export interface LoadoutAssignment {
  candidateId: string;
  roleName: string;
}

export interface PercentageRole {
  name: string;
  percentage: number;
}

export function buildPercentageSlots(roles: readonly PercentageRole[], memberCount: number): string[] {
  if (!Number.isSafeInteger(memberCount) || memberCount <= 0) return [];
  const allocations = roles.map((role, index) => ({
    ...role,
    index,
    count: Math.floor(memberCount * role.percentage / 100),
  }));
  let allocated = allocations.reduce((sum, role) => sum + role.count, 0);
  for (const role of [...allocations]
    .filter((candidate) => candidate.percentage > 0 && candidate.count === 0)
    .sort((left, right) => right.percentage - left.percentage || left.index - right.index)) {
    if (allocated >= memberCount) break;
    role.count = 1;
    allocated += 1;
  }
  const slots = allocations.flatMap((role) => Array.from({ length: role.count }, () => role.name));
  if (slots.length > memberCount) return slots.slice(0, memberCount);
  return [...slots, ...Array.from({ length: memberCount - slots.length }, () => "Rifleman")];
}

export function assignLoadout(roleNames: readonly string[], candidates: readonly LoadoutCandidate[]): LoadoutAssignment[] {
  const ordered = [...candidates].sort((a, b) => b.activitySeconds - a.activitySeconds || a.id.localeCompare(b.id));
  const slotOwners = new Map<number, string>();
  const candidateSlots = new Map<string, number>();
  const roleOverrides = new Map<number, string>();

  matchPreferenceTier(ordered, roleNames, slotOwners, candidateSlots, "firstChoices", new Set());
  matchPreferenceTier(ordered, roleNames, slotOwners, candidateSlots, "secondChoices", new Set(slotOwners.keys()));

  const openSlots = roleNames.map((_, index) => index).filter((slot) => !slotOwners.has(slot));
  const unmatched = ordered.filter((candidate) => !candidateSlots.has(candidate.id));
  for (let index = 0; index < Math.min(openSlots.length, unmatched.length); index++) {
    const slot = openSlots[index]!;
    const candidate = unmatched[index]!;
    slotOwners.set(slot, candidate.id);
    candidateSlots.set(candidate.id, slot);
    roleOverrides.set(slot, "Rifleman");
  }

  return [...slotOwners.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slot, candidateId]) => ({ candidateId, roleName: roleOverrides.get(slot) ?? roleNames[slot]! }));
}

function matchPreferenceTier(
  candidates: readonly LoadoutCandidate[],
  roleNames: readonly string[],
  slotOwners: Map<number, string>,
  candidateSlots: Map<string, number>,
  tier: "firstChoices" | "secondChoices",
  lockedSlots: ReadonlySet<number>,
): void {
  const tierActivity = (candidate: LoadoutCandidate): number => Math.max(0, ...[...candidate[tier]].map((role) => candidate.roleActivitySeconds?.get(role) ?? 0));
  const orderedCandidates = [...candidates].sort((left, right) =>
    tierActivity(right) - tierActivity(left) || right.activitySeconds - left.activitySeconds || left.id.localeCompare(right.id),
  );
  const candidateById = new Map(orderedCandidates.map((candidate) => [candidate.id, candidate]));
  const tryMatch = (candidate: LoadoutCandidate, visited: Set<number>): boolean => {
    const slots = roleNames.map((_, slot) => slot).sort((left, right) => {
      const leftRole = roleNames[left]!.toLocaleLowerCase("en-US");
      const rightRole = roleNames[right]!.toLocaleLowerCase("en-US");
      return (candidate.roleActivitySeconds?.get(rightRole) ?? 0) - (candidate.roleActivitySeconds?.get(leftRole) ?? 0) || left - right;
    });
    for (const slot of slots) {
      if (visited.has(slot) || !candidate[tier].has(roleNames[slot]!.toLocaleLowerCase("en-US"))) continue;
      visited.add(slot);
      const ownerId = slotOwners.get(slot);
      if (!ownerId || (!lockedSlots.has(slot) && candidateById.get(ownerId) && tryMatch(candidateById.get(ownerId)!, visited))) {
        if (ownerId) candidateSlots.delete(ownerId);
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
