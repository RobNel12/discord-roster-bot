import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";

import type { RosterRepository } from "./database.js";

const channelPermissionChecks = [
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.SendMessages, "Send Messages"],
  [PermissionFlagsBits.EmbedLinks, "Embed Links"],
  [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
] as const;

export function isServerManager(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

export async function canManageSquads(
  interaction: ChatInputCommandInteraction,
  repository: RosterRepository,
): Promise<boolean> {
  if (isServerManager(interaction)) {
    return true;
  }
  if (!interaction.guildId || !interaction.guild) {
    return false;
  }

  const roleId = repository.getGuildConfig(interaction.guildId).squadLeaderRoleId;
  if (!roleId) {
    return false;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  return member.roles.cache.has(roleId);
}

export async function missingRosterChannelPermissions(
  guild: Guild,
  channel: GuildBasedChannel,
): Promise<string[]> {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return channelPermissionChecks.map(([, name]) => name);
  }

  return channelPermissionChecks
    .filter(([flag]) => !permissions.has(flag))
    .map(([, name]) => name);
}
