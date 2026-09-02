import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from "discord.js";

import type { RosterRepository } from "../database.js";
import { buildSquadControlRows } from "../squad-components.js";
import { isManualEnlistedRank, officerRankForSeconds, rankDisplayName, rankForSeconds } from "../ranks.js";
import { buildRosterEmbeds, escapeRosterText, type RosterSection } from "./format.js";
import { MemberDirectory } from "./member-directory.js";
import { MissingRosterChannelError, RosterPublisher } from "./publisher.js";

const memberNameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

export class RosterService {
  private readonly members: Pick<MemberDirectory, "getCompleteMembers">;
  private readonly publisher: Pick<RosterPublisher, "publish" | "retryQueuedCleanup">;
  private readonly rolePageIndexes = new Map<string, number>();

  constructor(
    private readonly client: Client,
    private readonly repository: RosterRepository,
    dependencies: {
      members?: Pick<MemberDirectory, "getCompleteMembers">;
      publisher?: Pick<RosterPublisher, "publish" | "retryQueuedCleanup">;
    } = {},
  ) {
    this.members = dependencies.members ?? new MemberDirectory();
    this.publisher = dependencies.publisher ?? new RosterPublisher(repository);
  }

  async syncRoleRoster(guildId: string, reconcileMembers = false): Promise<void> {
    const guild = this.getGuild(guildId);
    const config = this.repository.getGuildConfig(guildId);
    if (!config.roleRosterChannelId) {
      await this.publisher.retryQueuedCleanup(guild, "role");
      return;
    }

    const members = await this.members.getCompleteMembers(guild, reconcileMembers);
    const trackedRoles = this.repository.listTrackedRoles(guildId);
    const configuredPages = this.repository.listRoleRosterPages(guildId);
    const pages = configuredPages.length > 0
      ? configuredPages.map((page) => ({ id: page.id, name: page.name }))
      : [{ id: null, name: "Overview" }];
    const embeds = pages.map((page) => {
      const sections: RosterSection[] = [];
      const pageRoles = trackedRoles.filter((role) => role.pageId === page.id || (page.id === null && role.pageId === null));
      for (const trackedRole of pageRoles) {
      const role = guild.roles.cache.get(trackedRole.roleId);
      if (!role) {
        this.repository.removeTrackedRole(guildId, trackedRole.roleId);
        continue;
      }

      const roleMembers = [...members.values()]
        .filter(
          (member) =>
            member.roles.cache.has(role.id) && (config.includeBots || !member.user.bot),
        )
        .sort(compareMembers);

      sections.push({
        name: `${trackedRole.highPriority ? "⭐ " : ""}${role.name} — ${roleMembers.length}`,
        lines: roleMembers.map((member) => memberLine(member)),
      });
      }
      const hasPriority = sections.some((section) => section.name.startsWith("⭐"));
      return buildRosterEmbeds({
        title: `Role roster — ${page.name}`,
        ...(hasPriority ? { description: "⭐ High-priority role" } : {}),
        emptyText: "No roles are assigned to this page.",
        sections,
        color: 0x57_f2_87,
      })[0]!;
    });
    const currentIndex = Math.min(this.rolePageIndexes.get(guildId) ?? 0, Math.max(0, embeds.length - 1));
    this.rolePageIndexes.set(guildId, currentIndex);
    try {
      await this.publisher.publish(
        guild,
        config.roleRosterChannelId,
        "role",
        [embeds[currentIndex]!],
      );
      await this.ensureRolePageReactions(guild);
    } catch (error) {
      if (error instanceof MissingRosterChannelError) {
        const cleared = this.repository.clearRoleRosterChannelIfMatches(
          guildId,
          config.roleRosterChannelId,
        );
        if (cleared) {
          this.repository.removePublishedMessagesForChannel(
            guildId,
            config.roleRosterChannelId,
          );
          console.warn(`[roster] Cleared missing role roster channel in guild ${guildId}.`);
        }
        return;
      }
      throw error;
    }
  }

  async turnRoleRosterPage(guildId: string, direction: -1 | 1): Promise<void> {
    const pageCount = Math.max(1, this.repository.listRoleRosterPages(guildId).length);
    const current = this.rolePageIndexes.get(guildId) ?? 0;
    this.rolePageIndexes.set(guildId, (current + direction + pageCount) % pageCount);
    await this.syncRoleRoster(guildId);
  }

  private async ensureRolePageReactions(guild: Guild): Promise<void> {
    if (this.repository.listRoleRosterPages(guild.id).length < 2) return;
    const publication = this.repository.listPublishedMessages(guild.id, "role")[0];
    if (!publication) return;
    const channel = await guild.channels.fetch(publication.channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(publication.messageId);
    await message.react("⬅️");
    await message.react("➡️");
  }

  async syncSquadRoster(guildId: string, reconcileMembers = false): Promise<void> {
    const guild = this.getGuild(guildId);
    const config = this.repository.getGuildConfig(guildId);
    if (!config.squadRosterChannelId) {
      await this.publisher.retryQueuedCleanup(guild, "squad");
      return;
    }

    const members = await this.members.getCompleteMembers(guild, reconcileMembers);
    const eligibleMembers = [...members.values()]
      .filter((member) => config.includeBots || !member.user.bot)
      .sort(compareMembers);
    const squads = this.repository.listSquads(guildId);
    const squadIds = new Set(squads.map((squad) => squad.id));
    const assignments = new Map<number, GuildMember[]>();
    const loadoutAssignments = new Map(
      this.repository.listSquadLoadoutAssignments(guildId).map((assignment) => [assignment.userId, assignment.roleName]),
    );
    const assignedUserIds = new Set<string>();
    const membershipByUser = new Map<string, number>();

    for (const membership of this.repository.listMemberships(guildId)) {
      const member = members.get(membership.userId);
      if (!member) {
        this.repository.unassignMember(guildId, membership.userId);
        continue;
      }
      if (!squadIds.has(membership.squadId)) {
        continue;
      }
      membershipByUser.set(membership.userId, membership.squadId);

      const squadMembers = assignments.get(membership.squadId) ?? [];
      if (config.includeBots || !member.user.bot) {
        squadMembers.push(member);
        assignedUserIds.add(member.id);
      }
      assignments.set(membership.squadId, squadMembers);
    }

    const sections: RosterSection[] = [];
    if (config.squadLeaderRoleId) {
      const squadById = new Map(squads.map((squad) => [squad.id, squad]));
      const leaders = eligibleMembers.filter((member) => member.roles.cache.has(config.squadLeaderRoleId!));
      sections.push({
        name: `Squad Leaders — ${leaders.length}`,
        lines: leaders.map((member) => {
          const squad = squadById.get(membershipByUser.get(member.id) ?? -1);
          return `${memberLine(member, this.memberRank(guild, member, config.squadLeaderRoleId))}${squad ? ` — ${escapeRosterText(squad.name)}` : " — Unassigned"}`;
        }),
      });
    }
    sections.push(...squads.map((squad) => {
      const squadMembers = (assignments.get(squad.id) ?? []).sort(compareMembers);
      return {
        name: `${squad.name} — ${squadMembers.length}`,
        lines: squadMembers.map((member) => memberLine(member, this.memberRank(guild, member, config.squadLeaderRoleId), loadoutAssignments.get(member.id))),
      };
    }));
    const unassigned = eligibleMembers.filter((member) => !assignedUserIds.has(member.id));
    sections.push({
      name: `Unassigned — ${unassigned.length}`,
      lines: unassigned.map((member) => memberLine(member)),
    });

    // Reload after the member fetch so a server manager's newer setting is never
    // cleared from an older render snapshot.
    let leaderRoleId = this.repository.getGuildConfig(guildId).squadLeaderRoleId;
    if (leaderRoleId && !guild.roles.cache.has(leaderRoleId)) {
      this.repository.clearSquadLeaderRoleIfMatches(guildId, leaderRoleId);
      leaderRoleId = null;
    }
    const managerText = leaderRoleId
      ? `Squad managers: <@&${leaderRoleId}> and members with Manage Server`
      : "Squad managers: members with Manage Server";
    const selfServiceText =
      "Self-service: choose a squad below to join or move; use the leave button to become Unassigned.";
    const embeds = buildRosterEmbeds({
      title: "Squad roster",
      description: `${managerText}\n${selfServiceText}`,
      emptyText: "No squad information is available.",
      sections,
      color: 0xfe_a5_1d,
    });
    try {
      await this.publisher.publish(
        guild,
        config.squadRosterChannelId,
        "squad",
        embeds,
        buildSquadControlRows(squads),
      );
    } catch (error) {
      if (error instanceof MissingRosterChannelError) {
        const cleared = this.repository.clearSquadRosterChannelIfMatches(
          guildId,
          config.squadRosterChannelId,
        );
        if (cleared) {
          this.repository.removePublishedMessagesForChannel(
            guildId,
            config.squadRosterChannelId,
          );
          console.warn(`[roster] Cleared missing squad roster channel in guild ${guildId}.`);
        }
        return;
      }
      throw error;
    }
  }

  async syncBoth(guildId: string, reconcileMembers = false): Promise<void> {
    const guild = this.getGuild(guildId);
    const config = this.repository.getGuildConfig(guildId);
    if (config.roleRosterChannelId || config.squadRosterChannelId) {
      await this.members.getCompleteMembers(guild, reconcileMembers);
    }
    const failures: unknown[] = [];
    try {
      await this.syncRoleRoster(guildId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.syncSquadRoster(guildId);
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `One or more rosters failed to refresh for guild ${guildId}.`);
    }
  }

  private getGuild(guildId: string): Guild {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error(`The bot is not connected to guild ${guildId}.`);
    }
    return guild;
  }

  private memberRank(guild: Guild, member: GuildMember, leaderRoleId: string | null): string {
    const canReachGeneral = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild);
    const isOfficer = canReachGeneral || Boolean(leaderRoleId && member.roles.cache.has(leaderRoleId));
    const track = isOfficer ? "officer" : "enlisted";
    const seconds = this.repository.ensureMemberRankTrack(guild.id, member.id, track);
    const state = this.repository.getMemberRankState(guild.id, member.id);
    if (!isOfficer && state.manualRank && isManualEnlistedRank(state.manualRank)) return state.manualRank;
    return isOfficer ? officerRankForSeconds(seconds, canReachGeneral) : rankForSeconds(seconds);
  }
}

function compareMembers(left: GuildMember, right: GuildMember): number {
  const byName = memberNameCollator.compare(left.displayName, right.displayName);
  return byName || left.id.localeCompare(right.id);
}

function memberLine(member: GuildMember, rank?: string, loadoutRole?: string): string {
  const details = [rank ? rankDisplayName(rank) : null, loadoutRole ? escapeRosterText(loadoutRole) : null]
    .filter((detail): detail is string => Boolean(detail));
  return `• <@${member.id}>${details.length ? ` — ${details.map((detail) => `**${detail}**`).join(" · ")}` : ""}`;
}
