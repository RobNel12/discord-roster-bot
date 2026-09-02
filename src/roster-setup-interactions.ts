import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type Interaction,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import { missingRosterChannelPermissions } from "./permissions.js";
import type { RosterScheduler } from "./scheduler.js";

const CHANNEL_PREFIX = "roster-setup:channel:";
const PREFIX = "rs:";

interface DraftPage { name: string; roleIds: string[]; priorityRoleIds: Set<string> }
interface SetupDraft { ownerId: string; guildId: string; channelId: string; pages: DraftPage[]; currentPage: DraftPage | undefined }
const drafts = new Map<string, SetupDraft>();

export async function handleRosterSetupInteraction(
  interaction: Interaction,
  context: { repository: RosterRepository; scheduler: RosterScheduler },
): Promise<boolean> {
  const customId = "customId" in interaction ? interaction.customId : "";
  if (!customId.startsWith(CHANNEL_PREFIX) && !customId.startsWith(PREFIX)) return false;
  if (!interaction.inGuild() || !interaction.guild) {
    if (interaction.isRepliable()) await interaction.reply({ content: "Roster setup can only be used inside a server.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    if (interaction.isRepliable()) await interaction.reply({ content: "You need **Manage Server** to configure the roster.", flags: MessageFlags.Ephemeral });
    return true;
  }

  const guild = interaction.guild as Guild;
  if (interaction.isChannelSelectMenu() && customId.startsWith(CHANNEL_PREFIX)) {
    const ownerId = customId.slice(CHANNEL_PREFIX.length);
    if (interaction.user.id !== ownerId) return denyOwner(interaction);
    const channelId = interaction.values[0];
    const channel = channelId ? await guild.channels.fetch(channelId) : null;
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      await interaction.reply({ content: "Choose a server text or announcement channel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const missing = await missingRosterChannelPermissions(guild, channel);
    if (missing.length) {
      await interaction.reply({ content: `The bot is missing these permissions in <#${channel.id}>: ${missing.join(", ")}.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
    drafts.set(nonce, { ownerId, guildId: guild.id, channelId: channel.id, pages: [], currentPage: undefined });
    await interaction.update(setupActions(nonce, drafts.get(nonce)!));
    return true;
  }

  const [, action, nonce] = customId.split(":");
  const draft = nonce ? drafts.get(nonce) : undefined;
  if (!draft || draft.guildId !== guild.id) {
    if (interaction.isRepliable()) await interaction.reply({ content: "This setup draft expired. Run `/roster setup` again.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== draft.ownerId) return denyOwner(interaction);

  if (interaction.isButton() && action === "add") {
    const input = new TextInputBuilder().setCustomId("page-name").setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(50).setRequired(true).setPlaceholder("Example: Command and Leadership");
    const modal = new ModalBuilder().setCustomId(`${PREFIX}modal:${nonce}`).setTitle("Create roster page").addLabelComponents(new LabelBuilder().setLabel("Page name").setTextInputComponent(input));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && action === "modal") {
    const name = interaction.fields.getTextInputValue("page-name").trim();
    if (draft.pages.some((page) => page.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
      await interaction.reply({ content: "Page names must be unique. Choose another name.", flags: MessageFlags.Ephemeral });
      return true;
    }
    draft.currentPage = { name, roleIds: [], priorityRoleIds: new Set() };
    const select = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}roles:${nonce}`).setPlaceholder(`Roles for ${name}`).setMinValues(1).setMaxValues(12);
    await interaction.deferUpdate();
    await interaction.editReply({ content: `**Role roster setup**\nPage: **${name}**\nSelect up to 12 roles for this page.`, components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)] });
    return true;
  }

  if (interaction.isRoleSelectMenu() && action === "roles" && draft.currentPage) {
    const used = new Set(draft.pages.flatMap((page) => page.roleIds));
    const duplicate = interaction.values.find((roleId) => used.has(roleId));
    if (duplicate) {
      await interaction.reply({ content: `<@&${duplicate}> is already assigned to another page.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    draft.currentPage.roleIds = interaction.values.filter((id) => id !== guild.id);
    if (draft.currentPage.roleIds.length === 0) {
      await interaction.reply({ content: "Select at least one regular server role; `@everyone` cannot be tracked.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const priority = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}priority:${nonce}`).setPlaceholder("Select high-priority roles").setMinValues(1).setMaxValues(draft.currentPage.roleIds.length);
    const skip = new ButtonBuilder().setCustomId(`${PREFIX}skip:${nonce}`).setLabel("No priority roles").setStyle(ButtonStyle.Secondary);
    await interaction.update({ content: `**Role roster setup**\nPage: **${draft.currentPage.name}**\nOptionally select which assigned roles should be highlighted.`, components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(priority), new ActionRowBuilder<ButtonBuilder>().addComponents(skip)] });
    return true;
  }

  if ((interaction.isRoleSelectMenu() && action === "priority") || (interaction.isButton() && action === "skip")) {
    if (!draft.currentPage) return true;
    const selected = interaction.isRoleSelectMenu() ? interaction.values : [];
    const invalid = selected.find((roleId) => !draft.currentPage!.roleIds.includes(roleId));
    if (invalid) {
      await interaction.reply({ content: "High-priority roles must be assigned to this page.", flags: MessageFlags.Ephemeral });
      return true;
    }
    draft.currentPage.priorityRoleIds = new Set(selected);
    draft.pages.push(draft.currentPage);
    draft.currentPage = undefined;
    await interaction.update(setupActions(nonce!, draft));
    return true;
  }

  if (interaction.isButton() && action === "finish") {
    if (draft.pages.length === 0) {
      await interaction.reply({ content: "Create at least one page before finishing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    context.repository.replaceRoleRosterSetup(guild.id, draft.channelId, draft.pages.map((page) => ({ name: page.name, roles: page.roleIds.map((roleId) => ({ roleId, highPriority: page.priorityRoleIds.has(roleId) })) })));
    drafts.delete(nonce!);
    await interaction.update({ content: `Setup complete: ${draft.pages.length} named page${draft.pages.length === 1 ? "" : "s"} will publish in <#${draft.channelId}>.`, components: [], allowedMentions: { parse: [] } });
    try { await context.scheduler.runNow(guild.id, "role"); }
    catch (error) { console.error(`[roster] Named-page setup publication failed in guild ${guild.id}:`, error); await interaction.editReply({ content: "Setup was saved, but publishing failed. Check channel permissions and run `/roster refresh`." }); }
    return true;
  }
  return true;
}

function setupActions(nonce: string, draft: SetupDraft) {
  const summary = draft.pages.length ? draft.pages.map((page, index) => `${index + 1}. **${page.name}** — ${page.roleIds.length} roles, ${page.priorityRoleIds.size} priority`).join("\n") : "No pages created yet.";
  const add = new ButtonBuilder().setCustomId(`${PREFIX}add:${nonce}`).setLabel("Add named page").setStyle(ButtonStyle.Primary);
  const finish = new ButtonBuilder().setCustomId(`${PREFIX}finish:${nonce}`).setLabel("Finish and publish").setStyle(ButtonStyle.Success).setDisabled(draft.pages.length === 0);
  return { content: `**Role roster setup**\nChannel: <#${draft.channelId}>\n${summary}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(add, finish)], allowedMentions: { parse: [] as never[] } };
}

async function denyOwner(interaction: Interaction): Promise<true> {
  if (interaction.isRepliable()) await interaction.reply({ content: "Only the manager who started this setup can use these controls.", flags: MessageFlags.Ephemeral });
  return true;
}
