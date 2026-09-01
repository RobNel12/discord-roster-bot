import {
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import type { RosterScheduler } from "./scheduler.js";
import {
  isSquadJoinCustomId,
  SQUAD_LEAVE_CUSTOM_ID,
} from "./squad-components.js";
import { escapeRosterText } from "./rosters/format.js";

type SquadComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

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
  if (!isJoin && !isLeave) {
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
