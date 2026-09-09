import { PermissionFlagsBits, type Guild } from "discord.js";
import type { RosterRepository } from "./database.js";
import { ALL_RANK_ABBREVIATIONS, isManualEnlistedRank, officerRankForSeconds, rankForSeconds } from "./ranks.js";

export function rankLeaderboard(guild: Guild, repository: RosterRepository, track = "all") {
  const config = repository.getGuildConfig(guild.id);
  return [...guild.members.cache.values()].filter(member => !member.user.bot).map(member => {
    const general = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild);
    const officer = general || Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
    const rankTrack = officer ? "officer" : "enlisted";
    repository.ensureMemberRankTrack(guild.id, member.id, rankTrack);
    const seconds = repository.getVoiceActivitySeconds(guild.id, member.id);
    const state = repository.getMemberRankState(guild.id, member.id);
    const rank = officer ? officerRankForSeconds(seconds, general)
      : state.manualRank && isManualEnlistedRank(state.manualRank) ? state.manualRank : rankForSeconds(seconds);
    return { id: member.id, rank, seconds, track: rankTrack };
  }).filter(entry => track === "all" || entry.track === track).sort((a, b) =>
    ALL_RANK_ABBREVIATIONS.indexOf(b.rank as typeof ALL_RANK_ABBREVIATIONS[number]) - ALL_RANK_ABBREVIATIONS.indexOf(a.rank as typeof ALL_RANK_ABBREVIATIONS[number]) ||
    b.seconds - a.seconds || a.id.localeCompare(b.id),
  );
}
