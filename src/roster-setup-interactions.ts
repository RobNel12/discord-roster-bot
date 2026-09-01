import {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type Guild,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import { missingRosterChannelPermissions } from "./permissions.js";
import type { RosterScheduler } from "./scheduler.js";

const CHANNEL_PREFIX = "roster-setup:channel:";
const ROLES_PREFIX = "roster-setup:roles:";

export async function handleRosterSetupInteraction(
  interaction: AnySelectMenuInteraction,
  context: { repository: RosterRepository; scheduler: RosterScheduler },
): Promise<boolean> {
  const isChannelStep = interaction.isChannelSelectMenu() && interaction.customId.startsWith(CHANNEL_PREFIX);
  const isRoleStep = interaction.isRoleSelectMenu() && interaction.customId.startsWith(ROLES_PREFIX);
  if (!isChannelStep && !isRoleStep) return false;

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "Roster setup can only be used inside a server.", flags: MessageFlags.Ephemeral });
    return true;
  }

  const parts = interaction.customId.split(":");
  const ownerId = isChannelStep ? parts[2] : parts[3];
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "Only the manager who started this setup can use these menus.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need the **Manage Server** permission to finish roster setup.", flags: MessageFlags.Ephemeral });
    return true;
  }

  const guild = interaction.guild as Guild;
  if (isChannelStep && interaction.isChannelSelectMenu()) {
    const channelId = interaction.values[0];
    const channel = channelId ? await guild.channels.fetch(channelId) : null;
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      await interaction.reply({ content: "Choose a server text or announcement channel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const missing = await missingRosterChannelPermissions(guild, channel);
    if (missing.length > 0) {
      await interaction.reply({ content: `The bot is missing these permissions in <#${channel.id}>: ${missing.join(", ")}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`${ROLES_PREFIX}${channel.id}:${interaction.user.id}`)
      .setPlaceholder("Choose up to 25 roles")
      .setMinValues(1)
      .setMaxValues(25);
    await interaction.update({
      content: `**Role roster setup — Step 2 of 2**\nChannel: <#${channel.id}>\nSelect every role to include. You can choose up to 25 roles at once.`,
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect)],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (isRoleStep && interaction.isRoleSelectMenu()) {
    const channelId = parts[2];
    if (!channelId) return true;
    await guild.roles.fetch();
    const roleIds = interaction.values
      .filter((roleId) => roleId !== guild.id && guild.roles.cache.has(roleId))
      .sort((a, b) => (guild.roles.cache.get(b)?.position ?? 0) - (guild.roles.cache.get(a)?.position ?? 0));
    context.repository.setRoleRosterChannel(guild.id, channelId);
    context.repository.replaceTrackedRoles(guild.id, roleIds);
    await interaction.update({
      content: `Setup complete. The role roster is publishing in <#${channelId}> with ${roleIds.length} tracked role${roleIds.length === 1 ? "" : "s"}.`,
      components: [],
      allowedMentions: { parse: [] },
    });
    try {
      await context.scheduler.runNow(guild.id, "role");
    } catch (error) {
      console.error(`[roster] Setup was saved but publication failed in guild ${guild.id}:`, error);
      await interaction.editReply({
        content: `Setup was saved for <#${channelId}> with ${roleIds.length} tracked role${roleIds.length === 1 ? "" : "s"}, but the roster message could not be updated. Check the bot's channel permissions, then use \`/roster refresh\`.`,
      });
    }
    return true;
  }
  return false;
}
