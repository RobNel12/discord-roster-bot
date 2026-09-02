import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags,
  ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, type Interaction,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import { escapeRosterText } from "./rosters/format.js";
import { SQUAD_CONFIG_LOADOUT_CUSTOM_ID } from "./squad-components.js";

const PREFIX = "loadoutcfg:";
interface Session {
  ownerId: string;
  guildId: string;
  squadId: number;
  page: number;
  selected: string | null;
  pending: { roleId: string; roleName: string; preference: "first" | "second" | null } | null;
}
const sessions = new Map<string, Session>();

export async function handleLoadoutConfigInteraction(interaction: Interaction, repository: RosterRepository): Promise<boolean> {
  const customId = "customId" in interaction ? interaction.customId : "";
  if (customId !== SQUAD_CONFIG_LOADOUT_CUSTOM_ID && !customId.startsWith(PREFIX)) return false;
  if (!interaction.inGuild() || !interaction.guild || !interaction.isRepliable()) return true;

  if (customId === SQUAD_CONFIG_LOADOUT_CUSTOM_ID && interaction.isButton()) {
    const config = repository.getGuildConfig(interaction.guild.id);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isManager = member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
    const membership = repository.getMembership(interaction.guild.id, member.id);
    if (!isManager || !membership) {
      await interaction.reply({ content: "You must be an assigned squad manager to configure a loadout.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const id = randomUUID().replaceAll("-", "").slice(0, 12);
    const session: Session = { ownerId: member.id, guildId: interaction.guild.id, squadId: membership.squadId, page: 0, selected: null, pending: null };
    sessions.set(id, session);
    await interaction.reply({ ...panel(repository, id, session), flags: MessageFlags.Ephemeral });
    return true;
  }

  const [, action, id] = customId.split(":");
  const session = id ? sessions.get(id) : undefined;
  if (!session || session.ownerId !== interaction.user.id || session.guildId !== interaction.guild.id) {
    await interaction.reply({ content: "This loadout configuration panel expired. Open a new one from the squad roster.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.isRoleSelectMenu() && action === "add") {
    const roleId = interaction.values[0];
    const role = roleId ? (interaction.roles.get(roleId) ?? interaction.guild.roles.cache.get(roleId)) : null;
    if (!role || role.id === interaction.guild.id) {
      await interaction.reply({ content: "Choose a regular server role.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const preferenceMatch = role.name.match(/^(1st|2nd)\s+(.+)$/iu);
    const roleName = (preferenceMatch?.[2] ?? role.name).trim();
    const preference = preferenceMatch?.[1]?.toLocaleLowerCase("en-US") === "1st"
      ? "first"
      : preferenceMatch ? "second" : null;
    const existing = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((item) => item.normalizedName === roleName.toLocaleLowerCase("en-US"));
    if (preference && existing) {
      repository.setSquadLoadoutPreferenceRole(session.guildId, session.squadId, existing.normalizedName, preference, role.id);
      session.selected = existing.normalizedName;
      await interaction.update(panel(repository, id!, session));
      return true;
    }
    if (preference === "second") {
      if (!existing) {
        await interaction.reply({
          content: `Select **1st ${escapeRosterText(roleName)}** first to create the **${escapeRosterText(roleName)}** loadout and set its percentage. This second-choice role is only a fallback and does not add a percentage.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
    }
    session.pending = { roleId: role.id, roleName, preference };
    const percentage = new TextInputBuilder().setCustomId("percentage").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(3).setValue(String(existing?.percentage ?? 10));
    const instructions = new TextInputBuilder().setCustomId("instructions").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setValue(existing?.instructions ?? "");
    const modal = new ModalBuilder().setCustomId(`${PREFIX}save-new:${id}`).setTitle(`Configure ${roleName}`.slice(0, 45))
      .addLabelComponents(
        new LabelBuilder().setLabel("Percentage of the squad (1-100)").setTextInputComponent(percentage),
        new LabelBuilder().setLabel("Loadout instructions (optional)").setTextInputComponent(instructions),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && action === "save-new") {
    const percentage = Number(interaction.fields.getTextInputValue("percentage").trim());
    if (!session.pending || !Number.isSafeInteger(percentage) || percentage < 1 || percentage > 100) {
      await interaction.reply({ content: "Percentage must be a whole number from 1 to 100.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const normalizedName = session.pending.roleName.toLocaleLowerCase("en-US");
    const existing = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === normalizedName);
    const otherTotal = repository.listSquadLoadoutRoles(session.guildId, session.squadId)
      .filter((role) => role.normalizedName !== normalizedName)
      .reduce((sum, role) => sum + role.percentage, 0);
    if (otherTotal + percentage > 100) {
      await interaction.reply({ content: `Configured percentages cannot exceed 100%. You have ${100 - otherTotal}% available for this role.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    repository.setSquadLoadoutRole(
      session.guildId,
      session.squadId,
      session.pending.roleName,
      percentage,
      interaction.fields.getTextInputValue("instructions"),
      session.pending.preference ? null : session.pending.roleId,
    );
    if (session.pending.preference) {
      repository.setSquadLoadoutPreferenceRole(session.guildId, session.squadId, normalizedName, session.pending.preference, session.pending.roleId);
    }
    session.selected = normalizedName;
    session.pending = null;
    await interaction.deferUpdate();
    await interaction.editReply(panel(repository, id!, session));
    return true;
  }

  if (interaction.isStringSelectMenu() && action === "select") {
    session.selected = interaction.values[0] ?? null;
    await interaction.update(panel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && ["inc", "dec", "remove"].includes(action ?? "")) {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === session.selected);
    if (selected) {
      const otherTotal = repository.listSquadLoadoutRoles(session.guildId, session.squadId)
        .filter((role) => role.normalizedName !== selected.normalizedName)
        .reduce((sum, role) => sum + role.percentage, 0);
      const nextPercentage = action === "inc" ? Math.min(100 - otherTotal, selected.percentage + 1) : action === "dec" ? Math.max(1, selected.percentage - 1) : 0;
      repository.setSquadLoadoutRole(session.guildId, session.squadId, selected.name, nextPercentage, selected.instructions, selected.discordRoleId);
      if (nextPercentage === 0) session.selected = null;
    }
    await interaction.update(panel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && action === "instructions") {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === session.selected);
    if (!selected) { await interaction.reply({ content: "Select a configured role first.", flags: MessageFlags.Ephemeral }); return true; }
    const input = new TextInputBuilder().setCustomId("instructions").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setValue(selected.instructions ?? "");
    const modal = new ModalBuilder().setCustomId(`${PREFIX}save-instructions:${id}`).setTitle(`Instructions: ${selected.name}`.slice(0, 45)).addLabelComponents(new LabelBuilder().setLabel("Loadout instructions (optional)").setTextInputComponent(input));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && action === "save-instructions") {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === session.selected);
    if (selected) repository.setSquadLoadoutRole(session.guildId, session.squadId, selected.name, selected.percentage, interaction.fields.getTextInputValue("instructions"), selected.discordRoleId);
    await interaction.deferUpdate();
    await interaction.editReply(panel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && action === "quantity") {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === session.selected);
    if (!selected) { await interaction.reply({ content: "Select a configured role first.", flags: MessageFlags.Ephemeral }); return true; }
    const input = new TextInputBuilder().setCustomId("percentage").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(selected.percentage));
    const modal = new ModalBuilder().setCustomId(`${PREFIX}save-quantity:${id}`).setTitle(`Percentage: ${selected.name}`.slice(0, 45)).addLabelComponents(new LabelBuilder().setLabel("Percentage of the squad (1-100)").setTextInputComponent(input));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && action === "save-quantity") {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find((role) => role.normalizedName === session.selected);
    const percentage = Number(interaction.fields.getTextInputValue("percentage").trim());
    if (!selected || !Number.isSafeInteger(percentage) || percentage < 1 || percentage > 100) {
      await interaction.reply({ content: "Percentage must be a whole number from 1 to 100.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const otherTotal = repository.listSquadLoadoutRoles(session.guildId, session.squadId)
      .filter((role) => role.normalizedName !== selected.normalizedName)
      .reduce((sum, role) => sum + role.percentage, 0);
    if (otherTotal + percentage > 100) {
      await interaction.reply({ content: `Configured percentages cannot exceed 100%. You have ${100 - otherTotal}% available for this role.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    repository.setSquadLoadoutRole(session.guildId, session.squadId, selected.name, percentage, selected.instructions, selected.discordRoleId);
    await interaction.deferUpdate();
    await interaction.editReply(panel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && (action === "prev" || action === "next")) {
    const count = repository.listSquadLoadoutRoles(session.guildId, session.squadId).length;
    const pages = Math.max(1, Math.ceil(count / 25));
    session.page = (session.page + (action === "next" ? 1 : -1) + pages) % pages;
    session.selected = null;
    await interaction.update(panel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && action === "close") {
    sessions.delete(id!);
    await interaction.update({ content: "Loadout configuration closed.", components: [] });
    return true;
  }
  return true;
}

function panel(repository: RosterRepository, id: string, session: Session) {
  const squad = repository.getSquad(session.guildId, session.squadId);
  const all = repository.listSquadLoadoutRoles(session.guildId, session.squadId);
  const total = all.reduce((sum, role) => sum + role.percentage, 0);
  const pageCount = Math.max(1, Math.ceil(all.length / 25));
  session.page = Math.min(session.page, pageCount - 1);
  const visible = all.slice(session.page * 25, session.page * 25 + 25);
  const lines = visible.map((role) => {
    const base = role.discordRoleId ? `<@&${role.discordRoleId}>` : `**${escapeRosterText(role.name)}**`;
    const preferences = [
      role.firstPreferenceRoleId ? `1st: <@&${role.firstPreferenceRoleId}>` : null,
      role.secondPreferenceRoleId ? `2nd: <@&${role.secondPreferenceRoleId}>` : null,
    ].filter(Boolean).join(", ");
    return `${role.normalizedName === session.selected ? "▶ " : "• "}${base} — ${role.percentage}%${preferences ? ` (${preferences})` : ""}${role.instructions ? ` — ${escapeRosterText(role.instructions)}` : ""}`;
  });
  const add = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}add:${id}`).setPlaceholder("Choose a Discord role to configure").setMinValues(1).setMaxValues(1);
  const rows: Array<ActionRowBuilder<any>> = [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(add)];
  if (visible.length) {
    const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}select:${id}`).setPlaceholder("Select a configured role to edit").addOptions(visible.map((role) => new StringSelectMenuOptionBuilder().setLabel(`${role.name} — ${role.percentage}%`.slice(0, 100)).setValue(role.normalizedName).setDefault(role.normalizedName === session.selected)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  const disabled = !session.selected;
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}inc:${id}`).setLabel("Increase").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}dec:${id}`).setLabel("Decrease").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}quantity:${id}`).setLabel("Set percentage").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}instructions:${id}`).setLabel("Instructions").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}remove:${id}`).setLabel("Remove role").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  ));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}prev:${id}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(pageCount === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}next:${id}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(pageCount === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}close:${id}`).setLabel("Done").setStyle(ButtonStyle.Primary),
  ));
  return { content: `**${escapeRosterText(squad?.name ?? "Squad")} loadout — ${total}% configured**\nUnallocated and rounded remainder: Rifleman\nPage ${session.page + 1}/${pageCount}\n${lines.join("\n") || "No roles configured. Select Discord roles above to add them."}`, components: rows, allowedMentions: { parse: [] as never[] } };
}
