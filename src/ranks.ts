export const ENLISTED_RANKS = [
  { abbreviation: "PVT", requiredSeconds: 0 },
  { abbreviation: "PV2", requiredSeconds: 3_600 },
  { abbreviation: "PFC", requiredSeconds: 7_200 },
  { abbreviation: "CPL", requiredSeconds: 14_400 },
  { abbreviation: "SGT", requiredSeconds: 21_600 },
  { abbreviation: "SSG", requiredSeconds: 36_000 },
  { abbreviation: "SFC", requiredSeconds: 57_600 },
  { abbreviation: "MSG", requiredSeconds: 86_400 },
  { abbreviation: "1SG", requiredSeconds: 129_600 },
  { abbreviation: "SGM", requiredSeconds: 180_000 },
] as const;

export const MANUAL_ENLISTED_RANKS = ["CSM", "SMA"] as const;

export const OFFICER_RANKS = [
  { abbreviation: "2LT", requiredSeconds: 0 },
  { abbreviation: "1LT", requiredSeconds: 10_800 },
  { abbreviation: "CPT", requiredSeconds: 32_400 },
  { abbreviation: "MAJ", requiredSeconds: 75_600 },
  { abbreviation: "LTC", requiredSeconds: 129_600 },
  { abbreviation: "COL", requiredSeconds: 180_000 },
  { abbreviation: "BG", requiredSeconds: 230_400 },
  { abbreviation: "MG", requiredSeconds: 309_600 },
  { abbreviation: "LTG", requiredSeconds: 360_000 },
  { abbreviation: "GEN", requiredSeconds: 540_000 },
] as const;

export const ALL_RANK_ABBREVIATIONS = [
  ...ENLISTED_RANKS.map((rank) => rank.abbreviation),
  ...MANUAL_ENLISTED_RANKS,
  ...OFFICER_RANKS.map((rank) => rank.abbreviation),
] as const;

const RANK_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  PVT: "Pvt.",
  PV2: "Pvt. 2nd Class",
  PFC: "Pfc.",
  CPL: "Cpl.",
  SGT: "Sgt.",
  SSG: "Staff Sgt.",
  SFC: "Sgt. 1st Class",
  MSG: "Master Sgt.",
  "1SG": "1st Sgt.",
  SGM: "Sgt. Maj.",
  CSM: "Command Sgt. Maj.",
  SMA: "Sgt. Maj. of the Army",
  "2LT": "2nd Lt.",
  "1LT": "1st Lt.",
  CPT: "Capt.",
  MAJ: "Maj.",
  LTC: "Lt. Col.",
  COL: "Col.",
  BG: "Brig. Gen.",
  MG: "Maj. Gen.",
  LTG: "Lt. Gen.",
  GEN: "Gen.",
};

export function rankDisplayName(rank: string): string {
  return RANK_DISPLAY_NAMES[rank] ?? rank;
}

export function rankForSeconds(seconds: number): string {
  return rankFromTrack(ENLISTED_RANKS, seconds);
}

export function officerRankForSeconds(seconds: number, canReachGeneral: boolean): string {
  return rankFromTrack(canReachGeneral ? OFFICER_RANKS : OFFICER_RANKS.slice(0, 6), seconds);
}

export function requiredSecondsForRank(rank: string): number | null {
  const automatic = [...ENLISTED_RANKS, ...OFFICER_RANKS].find((candidate) => candidate.abbreviation === rank);
  return automatic?.requiredSeconds ?? (isManualEnlistedRank(rank) ? 0 : null);
}

export function isOfficerRank(rank: string): boolean {
  return OFFICER_RANKS.some((candidate) => candidate.abbreviation === rank);
}

export function isGeneralOfficerRank(rank: string): boolean {
  return OFFICER_RANKS.slice(6).some((candidate) => candidate.abbreviation === rank);
}

export function isManualEnlistedRank(rank: string): rank is "CSM" | "SMA" {
  return MANUAL_ENLISTED_RANKS.includes(rank as "CSM" | "SMA");
}

function rankFromTrack(track: ReadonlyArray<{ abbreviation: string; requiredSeconds: number }>, seconds: number): string {
  let rank = track[0]?.abbreviation ?? "PVT";
  for (const candidate of track) {
    if (seconds < candidate.requiredSeconds) break;
    rank = candidate.abbreviation;
  }
  return rank;
}
