import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags,
  ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, type Interaction,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import type { RosterScheduler } from "./scheduler.js";
import { escapeRosterText } from "./rosters/format.js";
import { SQUAD_CONFIG_LOADOUT_CUSTOM_ID } from "./squad-components.js";

const PREFIX = "loadoutcfg:";
interface Session {
  ownerId: string;
  guildId: string;
  squadId: number;
  page: number;
  templatePage?: number;
  selectedTemplate?: number;
  pendingTemplateDelete?: number;
  pendingLimits?: { token: string; role: string };
  selected: string | null;
  pending: { roleId: string; roleName: string; preference: "first" | "second" | null } | null;
}
const sessions = new Map<string, Session>();

export async function handleLoadoutConfigInteraction(interaction: Interaction, repository: RosterRepository, scheduler?: Pick<RosterScheduler, "schedule">): Promise<boolean> {
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

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const leaderRoleId = repository.getGuildConfig(session.guildId).squadLeaderRoleId;
  if (!(member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(leaderRoleId && member.roles.cache.has(leaderRoleId))) ||
      repository.getMembership(session.guildId, member.id)?.squadId !== session.squadId) {
    sessions.delete(id!);
    await interaction.reply({ content: "You must still be an assigned manager of this squad. Open a new configuration panel.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.isButton() && action === "template-save") {
    const name = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(30);
    await interaction.showModal(new ModalBuilder().setCustomId(`${PREFIX}template-save-submit:${id}`).setTitle("Save loadout template")
      .addLabelComponents(new LabelBuilder().setLabel("Template name").setTextInputComponent(name)));
    return true;
  }

  if (interaction.isModalSubmit() && action === "template-save-submit") {
    try {
      repository.saveLoadoutTemplate(session.guildId, session.squadId, interaction.fields.getTextInputValue("name"));
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "Could not save the template.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.deferUpdate();
    await interaction.editReply(panel(repository, id!, session));
    await interaction.followUp({ content: "Template saved. It is available to squad managers in this server.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.isButton() && ["template-load", "templates-prev", "templates-next"].includes(action ?? "")) {
    const count = repository.listLoadoutTemplates(session.guildId).length;
    const pages = Math.max(1, Math.ceil(count / 25));
    session.templatePage = action === "template-load" ? 0 : ((session.templatePage ?? 0) + (action === "templates-next" ? 1 : -1) + pages) % pages;
    await interaction.update(templatePanel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && action === "templates-back") {
    await interaction.update(panel(repository, id!, session));
    return true;
  }

  if (interaction.isStringSelectMenu() && action === "template-select") {
    session.selectedTemplate = Number(interaction.values[0]);
    delete session.pendingTemplateDelete;
    await interaction.update(templatePanel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && ["template-rename", "template-delete"].includes(action ?? "")) {
    const template = repository.listLoadoutTemplates(session.guildId).find(t => t.id === session.selectedTemplate);
    if (!template) {
      await interaction.reply({ content: "Select an existing template first.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "template-rename") {
      const name = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(30).setValue(template.name);
      await interaction.showModal(new ModalBuilder().setCustomId(`${PREFIX}template-rename-submit:${id}:${template.id}`).setTitle("Rename template")
        .addLabelComponents(new LabelBuilder().setLabel("New template name").setTextInputComponent(name)));
    } else {
      session.pendingTemplateDelete = template.id;
      await interaction.update({
        content: `Delete **${escapeRosterText(template.name)}**? Saved templates cannot be recovered after deletion. Squads that already loaded it keep their settings and names.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${PREFIX}template-delete-confirm:${id}:${template.id}`).setLabel("Delete template").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${PREFIX}template-delete-cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        )], allowedMentions: { parse: [] },
      });
    }
    return true;
  }

  if (interaction.isModalSubmit() && action === "template-rename-submit") {
    try {
      const target = Number(customId.split(":")[3]);
      if (!Number.isSafeInteger(target)) throw new Error("Select an existing template first.");
      repository.renameLoadoutTemplate(session.guildId, target, interaction.fields.getTextInputValue("name"));
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "Could not rename template.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.deferUpdate();
    await interaction.editReply(templatePanel(repository, id!, session));
    return true;
  }

  if (interaction.isButton() && ["template-delete-confirm", "template-delete-cancel"].includes(action ?? "")) {
    if (action === "template-delete-confirm") {
      const target = Number(customId.split(":")[3]);
      if (target !== session.pendingTemplateDelete) {
        await interaction.reply({ content: "This deletion confirmation expired. Select the template again.", flags: MessageFlags.Ephemeral });
        return true;
      }
      repository.deleteLoadoutTemplate(session.guildId, target);
      delete session.selectedTemplate;
    }
    delete session.pendingTemplateDelete;
    await interaction.update(templatePanel(repository, id!, session));
    return true;
  }

  if ((interaction.isButton() || interaction.isStringSelectMenu()) && action === "template-apply") {
    const templateId = interaction.isStringSelectMenu() ? Number(interaction.values[0]) : session.selectedTemplate;
    try {
      if (templateId === undefined || !Number.isSafeInteger(templateId)) throw new Error("Select a saved template.");
      repository.loadLoadoutTemplate(session.guildId, session.squadId, templateId);
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "Could not load the template.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    session.page = 0;
    session.selected = null;
    session.pending = null;
    scheduler?.schedule(session.guildId, "squad");
    await interaction.update(panel(repository, id!, session));
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
      repository.setSquadLoadoutFillPriority(session.guildId, session.squadId, existing.normalizedName, preference === "first" ? "primary" : "secondary");
      session.selected = existing.normalizedName;
      await interaction.update(panel(repository, id!, session));
      return true;
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
    repository.setSquadLoadoutFillPriority(session.guildId, session.squadId, normalizedName, session.pending.preference === "second" ? "secondary" : "primary");
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

  if (interaction.isStringSelectMenu() && action === "fill-priority") {
    await interaction.reply({ content: "Choose the 1st or 2nd Discord role above to change this loadout's fill group.", flags: MessageFlags.Ephemeral });
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

  if (interaction.isButton() && action === "limits") {
    const selected = repository.listSquadLoadoutRoles(session.guildId, session.squadId).find(role => role.normalizedName === session.selected);
    if (!selected) { await interaction.reply({ content: "Select a configured role first.", flags: MessageFlags.Ephemeral }); return true; }
    const input = (name: string, value: number | null) => new TextInputBuilder().setCustomId(name).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setValue(value === null ? "" : String(value));
    session.pendingLimits = { token: randomUUID().slice(0, 8), role: selected.normalizedName };
    await interaction.showModal(new ModalBuilder().setCustomId(`${PREFIX}save-limits:${id}:${session.pendingLimits.token}`).setTitle("Minimum and maximum slots")
      .addLabelComponents(
        new LabelBuilder().setLabel("Minimum (blank = fill-priority default)").setTextInputComponent(input("minimum", selected.minimumSlots)),
        new LabelBuilder().setLabel("Maximum (blank = unlimited)").setTextInputComponent(input("maximum", selected.maximumSlots)),
      ));
    return true;
  }

  if (interaction.isModalSubmit() && action === "save-limits") {
    const parse = (key: string) => { const text = interaction.fields.getTextInputValue(key).trim(); return text === "" ? null : /^\d+$/u.test(text) ? Number(text) : NaN; };
    try {
      if (!session.pendingLimits || session.pendingLimits.token !== customId.split(":")[3]) throw new Error("This limits form expired. Open it again.");
      repository.setSquadLoadoutLimits(session.guildId, session.squadId, session.pendingLimits.role, parse("minimum"), parse("maximum"));
      delete session.pendingLimits;
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "Could not save slot limits.", flags: MessageFlags.Ephemeral });
      return true;
    }
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
    return `${role.normalizedName === session.selected ? "▶ " : "• "}${base} — ${role.percentage}% · ${role.fillPriority === "secondary" ? "2nd fill" : "1st fill"} · min ${role.minimumSlots ?? "auto"}, max ${role.maximumSlots ?? "∞"}${preferences ? ` (${preferences})` : ""}${role.instructions ? ` — ${escapeRosterText(role.instructions)}` : ""}`;
  });
  const add = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}add:${id}`).setPlaceholder("Choose a Discord role to configure").setMinValues(1).setMaxValues(1);
  const rows: Array<ActionRowBuilder<any>> = [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(add)];
  if (visible.length) {
    const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}select:${id}`).setPlaceholder("Select a configured role to edit").addOptions(visible.map((role) => new StringSelectMenuOptionBuilder().setLabel(`${role.name} — ${role.percentage}%`.slice(0, 100)).setValue(role.normalizedName).setDefault(role.normalizedName === session.selected)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  const disabled = !session.selected;
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}limits:${id}`).setLabel("Min / Max slots").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}quantity:${id}`).setLabel("Set percentage").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}instructions:${id}`).setLabel("Instructions").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${PREFIX}remove:${id}`).setLabel("Remove role").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  ));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}prev:${id}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(pageCount === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}next:${id}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(pageCount === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}template-save:${id}`).setLabel("Save template").setStyle(ButtonStyle.Secondary).setDisabled(all.length === 0),
    new ButtonBuilder().setCustomId(`${PREFIX}template-load:${id}`).setLabel("Load template").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}close:${id}`).setLabel("Done").setStyle(ButtonStyle.Primary),
  ));
  return { content: `**${escapeRosterText(squad?.name ?? "Squad")} loadout — ${total}% configured**\nUnallocated and rounded remainder: Rifleman\nPage ${session.page + 1}/${pageCount}\n${lines.join("\n") || "No roles configured. Select Discord roles above to add them."}`, components: rows, allowedMentions: { parse: [] as never[] } };
}

function templatePanel(repository: RosterRepository, id: string, session: Session) {
  const all = repository.listLoadoutTemplates(session.guildId);
  const pages = Math.max(1, Math.ceil(all.length / 25));
  session.templatePage = Math.min(session.templatePage ?? 0, pages - 1);
  const visible = all.slice(session.templatePage * 25, session.templatePage * 25 + 25);
  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  if (visible.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`${PREFIX}template-select:${id}`).setPlaceholder("Select a saved template")
      .addOptions(visible.map(t => ({ label: t.name, value: String(t.id), default: t.id === session.selectedTemplate }))),
  ));
  const selected = all.find(t => t.id === session.selectedTemplate);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}template-apply:${id}`).setLabel("Load template").setStyle(ButtonStyle.Primary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(`${PREFIX}template-rename:${id}`).setLabel("Rename template").setStyle(ButtonStyle.Secondary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(`${PREFIX}template-delete:${id}`).setLabel("Delete template").setStyle(ButtonStyle.Danger).setDisabled(!selected),
  ));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}templates-prev:${id}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(pages === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}templates-next:${id}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(pages === 1),
    new ButtonBuilder().setCustomId(`${PREFIX}templates-back:${id}`).setLabel("Back to loadout").setStyle(ButtonStyle.Primary),
  ));
  return { content: `**Templates — page ${session.templatePage + 1}/${pages}**\nSelect a template, then load, rename, or delete it. Loading replaces this squad's loadout settings and clears current assignments. Renaming or deleting affects only the saved template.\n${selected ? `Selected: **${escapeRosterText(selected.name)}**` : all.length ? "Choose a template below." : "No templates saved in this server yet."}`, components: rows, allowedMentions: { parse: [] as never[] } };
}
