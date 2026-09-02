import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import type { RosterScheduler } from "./scheduler.js";
import { assignLoadout, buildPercentageSlots } from "./loadout-assignment.js";
import {
  isSquadJoinCustomId,
  SQUAD_ASSIGN_LOADOUT_CUSTOM_ID,
  SQUAD_CALL_CUSTOM_ID,
  SQUAD_CLEAR_LOADOUT_CUSTOM_ID,
  SQUAD_LEAVE_CUSTOM_ID,
} from "./squad-components.js";
import { escapeRosterText } from "./rosters/format.js";

type SquadComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;
const CALL_COOLDOWN_MS = 60_000;
const lastSquadCalls = new Map<string, number>();

export interface SquadInteractionContext {
  repository: RosterRepository;
  scheduler: RosterScheduler;
}

export async function handleSquadComponentInteraction(
  interaction: SquadComponentInteraction,
  { repository, scheduler }: SquadInteractionContext,
): Promise<boolean> {
  const isJoin =
    interaction.isStringSelectMenu() && isSquadJoinCustomId(interaction.customId);
  const isLeave = interaction.isButton() && interaction.customId === SQUAD_LEAVE_CUSTOM_ID;
  const isCall = interaction.isButton() && interaction.customId === SQUAD_CALL_CUSTOM_ID;
  const isAssignLoadout = interaction.isButton() && interaction.customId === SQUAD_ASSIGN_LOADOUT_CUSTOM_ID;
  const isClearLoadout = interaction.isButton() && interaction.customId === SQUAD_CLEAR_LOADOUT_CUSTOM_ID;
  if (!isJoin && !isLeave && !isCall && !isAssignLoadout && !isClearLoadout) {
    return false;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "Squad controls can only be used inside a server.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild as Guild;
  const guildId = guild.id;

  try {
    const config = repository.getGuildConfig(guildId);
    const publishedMessage = repository.getPublishedMessageById(
      guildId,
      interaction.message.id,
    );
    const botUserId = interaction.client.user?.id;
    if (
      config.squadRosterChannelId !== interaction.channelId ||
      !publishedMessage ||
      publishedMessage.rosterType !== "squad" ||
      publishedMessage.channelId !== interaction.channelId ||
      !botUserId ||
      interaction.message.author.id !== botUserId
    ) {
      await editReply(
        interaction,
        "This squad panel is no longer active. Use the controls in the current squad roster channel.",
      );
      return true;
    }

    const member = await guild.members.fetch(interaction.user.id);
    if (member.user.bot && !config.includeBots) {
      await editReply(interaction, "Bots are excluded from this server's rosters.");
      return true;
    }

    if (isClearLoadout) {
      const isManager = member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
      if (!isManager) {
        await editReply(interaction, "Only squad managers can clear loadout assignments.");
        return true;
      }
      const membership = repository.getMembership(guildId, member.id);
      const squad = membership ? repository.getSquad(guildId, membership.squadId) : null;
      if (!squad) {
        await editReply(interaction, "You must be assigned to a squad before clearing its loadout assignments.");
        return true;
      }
      const cleared = repository.clearSquadLoadoutAssignments(guildId, squad.id);
      scheduler.schedule(guildId, "squad");
      await editReply(interaction, `Cleared ${cleared} loadout assignment${cleared === 1 ? "" : "s"} from **${escapeRosterText(squad.name)}**.`);
      return true;
    }

    if (isAssignLoadout) {
      const isManager = member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
      if (!isManager) {
        await editReply(interaction, "Only squad managers can assign loadouts.");
        return true;
      }
      const membership = repository.getMembership(guildId, member.id);
      const squad = membership ? repository.getSquad(guildId, membership.squadId) : null;
      if (!squad) {
        await editReply(interaction, "You must be assigned to a squad before assigning its loadouts.");
        return true;
      }
      const configured = repository.listSquadLoadoutRoles(guildId, squad.id);
      if (configured.length === 0) {
        await editReply(interaction, `Configure at least one loadout role for **${escapeRosterText(squad.name)}** first.`);
        return true;
      }
      const voiceRecord = repository.listTemporaryVoiceChannels(guildId)
        .find((record) => record.channelId === member.voice.channelId && record.squadId === squad.id);
      const voiceChannel = voiceRecord ? await guild.channels.fetch(voiceRecord.channelId) : null;
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await editReply(interaction, "Join your squad's temporary voice channel before assigning loadouts.");
        return true;
      }
      const voiceMembers = [...voiceChannel.members.values()].filter((candidate) => !candidate.user.bot);
      const refreshedMembers = await Promise.all(voiceMembers.map(async (candidate) =>
        guild.members.fetch({ user: candidate.id, force: true }).catch(() => candidate),
      ));
      const candidates = refreshedMembers.map((candidate) => {
        const parsedPreferences = loadoutPreferencesFromRoleNames(
          [...candidate.roles.cache.values()].map((role) => role.name),
        );
        return {
          id: candidate.id,
          firstChoices: new Set(configured.filter((role) =>
            Boolean(role.firstPreferenceRoleId && candidate.roles.cache.has(role.firstPreferenceRoleId)) ||
            parsedPreferences.first.has(role.normalizedName),
          ).map((role) => role.normalizedName)),
          secondChoices: new Set(configured.filter((role) =>
            Boolean(role.secondPreferenceRoleId && candidate.roles.cache.has(role.secondPreferenceRoleId)) ||
            parsedPreferences.second.has(role.normalizedName),
          ).map((role) => role.normalizedName)),
          roleActivitySeconds: new Map(configured.map((role) => [
            role.normalizedName,
            repository.getLoadoutRoleActivitySeconds(guildId, candidate.id, role.name),
          ])),
          activitySeconds: repository.getVoiceActivitySeconds(guildId, candidate.id),
        };
      });
      const slots = buildPercentageSlots(configured, candidates.length);
      const assignments = assignLoadout(slots, candidates);
      repository.replaceSquadLoadoutAssignments(guildId, squad.id, assignments.map((assignment) => ({
        userId: assignment.candidateId,
        roleName: assignment.roleName,
      })));
      scheduler.schedule(guildId, "squad");
      const failedDms: Array<{ id: string; roleName: string; instructions: string | null }> = [];
      for (const assignment of assignments) {
        const assignee = voiceChannel.members.get(assignment.candidateId);
        const role = configured.find((candidate) => candidate.normalizedName === assignment.roleName.toLocaleLowerCase("en-US"));
        if (!assignee) continue;
        const content = `**${escapeRosterText(squad.name)} loadout assignment**\nYou have been assigned **${escapeRosterText(assignment.roleName)}**.${role?.instructions ? `\n${escapeRosterText(role.instructions)}` : ""}`;
        try { await assignee.send({ content, allowedMentions: { parse: [] } }); }
        catch { failedDms.push({ id: assignee.id, roleName: assignment.roleName, instructions: role?.instructions ?? null }); }
      }
      if (failedDms.length && config.squadCallChannelId) {
        const fallbackChannel = await guild.channels.fetch(config.squadCallChannelId).catch(() => null);
        if (fallbackChannel && (fallbackChannel.type === ChannelType.GuildText || fallbackChannel.type === ChannelType.GuildAnnouncement)) {
          await fallbackChannel.send({
            content: `**${escapeRosterText(squad.name)} loadout assignments**\n${failedDms.map((failed) => `<@${failed.id}> — **${escapeRosterText(failed.roleName)}**${failed.instructions ? `: ${escapeRosterText(failed.instructions)}` : ""}`).join("\n")}`,
            allowedMentions: { parse: [], users: failedDms.map((failed) => failed.id) },
          });
        }
      }
      const summary = assignments.map((assignment) => `• <@${assignment.candidateId}> — **${escapeRosterText(assignment.roleName)}**`).join("\n");
      await interaction.editReply({
        content: `**${escapeRosterText(squad.name)} assignments (${assignments.length}/${slots.length})**\n${summary || "No eligible members were in voice."}${failedDms.length ? `\n\nCould not DM: ${failedDms.map((failed) => `<@${failed.id}>`).join(" ")}. A fallback was attempted in the squad-call channel.` : ""}`,
        allowedMentions: { parse: [] },
      });
      return true;
    }

    if (isCall) {
      const isManager =
        member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
      if (!isManager) {
        await editReply(interaction, "Only squad managers can call a squad.");
        return true;
      }
      const membership = repository.getMembership(guildId, member.id);
      const squad = membership ? repository.getSquad(guildId, membership.squadId) : null;
      if (!squad) {
        await editReply(interaction, "You must be assigned to a squad before calling its members.");
        return true;
      }
      if (!config.squadCallChannelId) {
        await editReply(interaction, "A server manager must configure a squad call channel with `/squad set-call-channel` first.");
        return true;
      }
      const callChannel = await guild.channels.fetch(config.squadCallChannelId);
      if (!callChannel || (callChannel.type !== ChannelType.GuildText && callChannel.type !== ChannelType.GuildAnnouncement)) {
        repository.clearSquadCallChannelIfMatches(guildId, config.squadCallChannelId);
        await editReply(interaction, "The configured squad call channel is unavailable. Ask a server manager to set it again.");
        return true;
      }
      const cooldownKey = `${guildId}:${squad.id}`;
      const remaining = CALL_COOLDOWN_MS - (Date.now() - (lastSquadCalls.get(cooldownKey) ?? 0));
      if (remaining > 0) {
        await editReply(interaction, `That squad was called recently. Try again in ${Math.ceil(remaining / 1_000)} seconds.`);
        return true;
      }
      const memberIds = repository.listMemberships(guildId)
        .filter((candidate) => candidate.squadId === squad.id)
        .map((candidate) => candidate.userId);
      lastSquadCalls.set(cooldownKey, Date.now());
      const batches: string[][] = [];
      for (let index = 0; index < memberIds.length; index += 50) {
        batches.push(memberIds.slice(index, index + 50));
      }
      const firstBatch = batches[0]!;
      await callChannel.send({
        content: `**${escapeRosterText(squad.name)}, form up!** <@${member.id}> is calling the squad.\n${firstBatch.map((id) => `<@${id}>`).join(" ")}`,
        allowedMentions: { parse: [], users: firstBatch },
      });
      for (const batch of batches.slice(1)) {
        await callChannel.send({
          content: batch.map((id) => `<@${id}>`).join(" "),
          allowedMentions: { parse: [], users: batch },
        });
      }
      await editReply(interaction, `Called **${escapeRosterText(squad.name)}** in <#${callChannel.id}>.`);
      return true;
    }

    if (isLeave) {
      repository.endVoiceActivity(guildId, member.id);
      const removed = repository.unassignMember(guildId, member.id);
      if (!removed) {
        await editReply(interaction, "You are already Unassigned.");
        return true;
      }

      scheduler.schedule(guildId, "squad");
      await editReply(interaction, "You left your squad and are now Unassigned.");
      return true;
    }

    if (!interaction.isStringSelectMenu()) {
      await editReply(interaction, "That squad control is not valid.");
      return true;
    }

    const selectedValue = interaction.values[0];
    const squadId = selectedValue ? parseSquadId(selectedValue) : null;
    const squad = squadId ? repository.getSquad(guildId, squadId) : null;
    if (!squad) {
      await editReply(
        interaction,
        "That squad no longer exists. The roster controls will update shortly.",
      );
      scheduler.schedule(guildId, "squad");
      return true;
    }

    const currentMembership = repository.getMembership(guildId, member.id);
    if (currentMembership?.squadId === squad.id) {
      await editReply(
        interaction,
        `You are already assigned to **${escapeRosterText(squad.name)}**.`,
      );
      return true;
    }

    repository.endVoiceActivity(guildId, member.id);
    repository.assignMember(guildId, member.id, squad.id, member.id);
    scheduler.schedule(guildId, "squad");
    await editReply(
      interaction,
      `You joined **${escapeRosterText(squad.name)}**. Any previous squad assignment was replaced.`,
    );
    return true;
  } catch (error) {
    console.error(`[squad] Self-service interaction failed in guild ${guildId}:`, error);
    await editReply(
      interaction,
      "Your squad assignment could not be changed. Please try again or ask a squad manager for help.",
    );
    return true;
  }
}

export function loadoutPreferencesFromRoleNames(roleNames: readonly string[]): { first: Set<string>; second: Set<string> } {
  const first = new Set<string>();
  const second = new Set<string>();
  for (const roleName of roleNames) {
    const match = roleName.trim().match(/^(1st|2nd)\s+(.+?)\s*$/iu);
    const preferenceName = match?.[2]?.trim().toLocaleLowerCase("en-US");
    if (!preferenceName) continue;
    (match?.[1]?.toLocaleLowerCase("en-US") === "1st" ? first : second).add(preferenceName);
  }
  return { first, second };
}

async function editReply(
  interaction: SquadComponentInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({
    content,
    allowedMentions: { parse: [] },
  });
}

function parseSquadId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
