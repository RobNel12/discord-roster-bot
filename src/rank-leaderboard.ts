import { PermissionFlagsBits, type Guild } from "discord.js";
import type { RosterRepository } from "./database.js";
import { ALL_RANK_ABBREVIATIONS, isManualEnlistedRank, officerRankForSeconds, rankDisplayName, rankForSeconds } from "./ranks.js";
import { resolveRosterAccessConfig, rosterAccess } from "./roster-access.js";
import { buildRosterEmbeds } from "./rosters/format.js";

export async function publishLeaderboard(guild: Guild, repository: RosterRepository): Promise<void> {
  const publication = repository.getLeaderboardPublication(guild.id);
  if (!publication.channelId && !publication.pages.length) return;
  const kept: typeof publication.pages = [];
  const pending = [...publication.pages];
  if (publication.channelId) {
    const channel = await guild.channels.fetch(publication.channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error("Leaderboard channel is unavailable.");
    const entries = rankLeaderboard(guild, repository);
    const embeds = (["officer", "enlisted"] as const).flatMap(track => {
      const trackEntries = entries.filter(entry => entry.track === track);
      const label = track === "officer" ? "Officer" : "Enlisted";
      return buildRosterEmbeds({ title: `${label} rank leaderboard`, color: 0xfe_a5_1d,
        description: "Ordered by rank, then current-track voice time. Live sessions included.",
        emptyText: `No current ${label.toLocaleLowerCase("en-US")} members.`, sections: trackEntries.length ? [{ name: `${label} members — ${trackEntries.length}`, lines: trackEntries.map((entry, index) =>
          `${index + 1}. <@${entry.id}> — **${rankDisplayName(entry.rank)}** · ${Math.floor(entry.seconds / 3600)}h ${Math.floor(entry.seconds % 3600 / 60)}m`,
        ) }] : [],
      });
    });
    for (const embed of embeds) {
      const index = pending.findIndex(page => page.channelId === channel.id);
      const existing = index < 0 ? undefined : pending[index];
      const message = existing ? await channel.messages.fetch(existing.messageId).catch((error: unknown) => {
        if ((error as { code?: number }).code === 10008) return null;
        throw error;
      }) : null;
      const payload = { content: "", embeds: [embed], allowedMentions: { parse: [] as never[] } };
      const updated = message ? await message.edit(payload) : await channel.send(payload);
      if (index >= 0) pending.splice(index, 1);
      kept.push({ channelId: channel.id, messageId: updated.id });
      repository.saveLeaderboardPages(guild.id, [...kept, ...pending]);
    }
  }
  for (const page of pending) {
    try {
      const channel = await guild.channels.fetch(page.channelId);
      if (channel?.isTextBased()) await channel.messages.delete(page.messageId);
    } catch (error) {
      if (![10003, 10008].includes((error as { code?: number }).code ?? 0)) kept.push(page);
    }
  }
  repository.saveLeaderboardPages(guild.id, kept);
}

export function rankLeaderboard(guild: Guild, repository: RosterRepository, track = "all") {
  const config = resolveRosterAccessConfig(guild, repository);
  return [...guild.members.cache.values()].filter(member =>
    !member.user.bot && rosterAccess(member, config) === "member",
  ).map(member => {
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
