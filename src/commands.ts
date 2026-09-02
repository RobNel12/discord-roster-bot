import {
  ActionRowBuilder,
  ChannelType,
  ChannelSelectMenuBuilder,
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";

import { DuplicateSquadNameError, type RosterRepository } from "./database.js";
import { canManageSquads, isServerManager, missingRosterChannelPermissions } from "./permissions.js";
import { escapeRosterText } from "./rosters/format.js";
import { RosterChannelError, RosterPublisher } from "./rosters/publisher.js";
import type { RosterScheduler } from "./scheduler.js";
import { SquadNameError } from "./squad-names.js";
import { MAX_INTERACTIVE_SQUADS } from "./squad-components.js";
import type { PublishedMessage, RosterTarget, RosterType } from "./types.js";
import { ENLISTED_RANKS, OFFICER_RANKS, isGeneralOfficerRank, isManualEnlistedRank, isOfficerRank, rankDisplayName, requiredSecondsForRank } from "./ranks.js";

export interface CommandContext {
  repository: RosterRepository;
  scheduler: RosterScheduler;
  publisher?: Pick<RosterPublisher, "deletePublication">;
}

const squadAdminSubcommands = new Set([
  "set-call-channel",
  "clear-call-channel",
  "set-rank-channel",
  "clear-rank-channel",
  "set-channel",
  "set-leader-role",
  "clear-leader-role",
  "set-voice-lobby",
  "clear-voice-lobby",
  "set-rank",
]);

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (interaction.commandName === "roster") {
      await handleRosterCommand(interaction, context);
      return;
    }
    if (interaction.commandName === "squad") {
      await handleSquadCommand(interaction, context);
      return;
    }

    await reply(interaction, "That command is not recognized by this version of the bot.");
  } catch (error) {
    console.error(
      `[command] /${interaction.commandName} failed in guild ${interaction.guildId}:`,
      error,
    );
    await reply(interaction, publicErrorMessage(error));
  }
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  repository: RosterRepository,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const query = String(focused.value).toLocaleLowerCase("en-US");
  if (interaction.commandName === "roster" && focused.name === "page") {
    await interaction.respond(repository.listRoleRosterPages(interaction.guildId)
      .filter((page) => page.name.toLocaleLowerCase("en-US").includes(query))
      .slice(0, 25)
      .map((page) => ({ name: page.name, value: String(page.id) })));
    return;
  }
  if (interaction.commandName !== "squad") {
    await interaction.respond([]);
    return;
  }
  if (focused.name !== "squad") {
    await interaction.respond([]);
    return;
  }

  const choices = repository
    .listSquads(interaction.guildId)
    .filter((squad) => squad.name.toLocaleLowerCase("en-US").includes(query))
    .slice(0, 25)
    .map((squad) => ({ name: squad.name, value: String(squad.id) }));
  await interaction.respond(choices);
}

async function handleRosterCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> {
  const { repository, scheduler } = context;
  const guild = interaction.guild as Guild;
  const guildId = guild.id;
  if (!isServerManager(interaction)) {
    await reply(interaction, "You need the **Manage Server** permission to configure the role roster.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "setup": {
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`roster-setup:channel:${interaction.user.id}`)
        .setPlaceholder("Choose the roster channel")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      await interaction.editReply({
        content: "**Role roster setup — Publication channel**\nChoose the channel where the named roster pages should be published.",
        components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect)],
      });
      return;
    }
    case "add-page": {
      const page = repository.createRoleRosterPage(guildId, interaction.options.getString("name", true));
      if (!page) {
        await reply(interaction, "Page names must be non-empty and unique.");
        return;
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(interaction, `Added roster page **${escapeRosterText(page.name)}**.${syncNote}`);
      return;
    }
    case "remove-page": {
      if (!interaction.options.getBoolean("confirm", true)) {
        await reply(interaction, "Page removal cancelled.");
        return;
      }
      const pageId = parseSquadId(interaction.options.getString("page", true));
      const pages = repository.listRoleRosterPages(guildId);
      const page = pageId ? pages.find((candidate) => candidate.id === pageId) : undefined;
      if (!page) {
        await reply(interaction, "That roster page no longer exists.");
        return;
      }
      if (pages.length <= 1) {
        await reply(interaction, "The last roster page cannot be removed. Add another page first.");
        return;
      }
      const fallback = pages.find((candidate) => candidate.id !== page.id)!;
      repository.removeRoleRosterPage(guildId, page.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(interaction, `Removed **${escapeRosterText(page.name)}**. Its tracked roles were moved to **${escapeRosterText(fallback.name)}**.${syncNote}`);
      return;
    }
    case "move-role": {
      const role = interaction.options.getRole("role", true);
      const pageId = parseSquadId(interaction.options.getString("page", true));
      const page = pageId ? repository.listRoleRosterPages(guildId).find((candidate) => candidate.id === pageId) : undefined;
      if (!page || !repository.moveTrackedRoleToPage(guildId, role.id, page.id)) {
        await reply(interaction, "Choose an existing page and a role that is already tracked.");
        return;
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(interaction, `Moved <@&${role.id}> to **${escapeRosterText(page.name)}**.${syncNote}`);
      return;
    }
    case "set-priority": {
      const role = interaction.options.getRole("role", true);
      const highPriority = interaction.options.getBoolean("high-priority", true);
      if (!repository.setTrackedRolePriority(guildId, role.id, highPriority)) {
        await reply(interaction, "That role is not currently tracked.");
        return;
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(interaction, `${highPriority ? "Highlighted" : "Removed the highlight from"} <@&${role.id}>.${syncNote}`);
      return;
    }
    case "set-channel": {
      const selectedChannel = interaction.options.getChannel("channel", true);
      const channel = await getUsableRosterChannel(guild, selectedChannel.id);
      repository.setRoleRosterChannel(guildId, channel.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      const cleanupNote = pendingCleanupNote(repository, guildId, "role");
      await reply(
        interaction,
        `The role roster channel is now <#${channel.id}>.${syncNote}${cleanupNote}`,
      );
      return;
    }
    case "add-role": {
      const role = interaction.options.getRole("role", true);
      const added = repository.addTrackedRole(guildId, role.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(
        interaction,
        `${added ? `<@&${role.id}> is now tracked.` : `<@&${role.id}> is already tracked.`}${syncNote}`,
      );
      return;
    }
    case "remove-role": {
      const role = interaction.options.getRole("role", true);
      const removed = repository.removeTrackedRole(guildId, role.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(
        interaction,
        `${removed ? `<@&${role.id}> is no longer tracked.` : `<@&${role.id}> was not tracked.`}${syncNote}`,
      );
      return;
    }
    case "list-roles": {
      const roles = repository.listTrackedRoles(guildId);
      const content =
        roles.length === 0
          ? "No roles are being tracked."
          : `Tracked roles, in roster order:\n${roles
              .map((tracked, index) => `${index + 1}. <@&${tracked.roleId}>`)
              .join("\n")}`;
      await reply(interaction, truncate(content, 1_900));
      return;
    }
    case "sort": {
      const tracked = repository.listTrackedRoles(guildId);
      const sortedRoleIds = tracked
        .map((trackedRole) => guild.roles.cache.get(trackedRole.roleId))
        .filter((role): role is NonNullable<typeof role> => Boolean(role))
        .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id))
        .map((role) => role.id);
      repository.reorderTrackedRoles(guildId, sortedRoleIds);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(
        interaction,
        `${sortedRoleIds.length === 0 ? "There are no tracked roles to sort." : `Sorted ${sortedRoleIds.length} tracked role${sortedRoleIds.length === 1 ? "" : "s"} by server role hierarchy.`}${syncNote}`,
      );
      return;
    }
    case "clear-roles": {
      if (!interaction.options.getBoolean("confirm", true)) {
        await reply(interaction, "Clear cancelled; tracked roles were not changed.");
        return;
      }
      const removed = repository.clearTrackedRoles(guildId);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "role");
      await reply(
        interaction,
        `${removed === 0 ? "No roles were being tracked." : `Stopped tracking all ${removed} role${removed === 1 ? "" : "s"}.`}${syncNote}`,
      );
      return;
    }
    case "refresh": {
      if (!repository.getGuildConfig(guildId).roleRosterChannelId) {
        await reply(interaction, "Set a role roster channel first with `/roster set-channel`.");
        return;
      }
      await scheduler.runNow(guildId, "role", true);
      await reply(interaction, "The role roster has been reconciled and refreshed.");
      return;
    }
    case "delete": {
      const reference = getPublicationReference(
        repository,
        guildId,
        interaction.options.getString("message-id", true),
      );
      if (!reference) {
        await reply(
          interaction,
          "That message ID is not recognized as a published roster page in this server. Enable Developer Mode, then copy the ID from any page of the roster.",
        );
        return;
      }
      const { publication: published } = reference;
      if (!interaction.options.getBoolean("confirm", true)) {
        await reply(interaction, "Deletion cancelled; the roster is still active.");
        return;
      }

      const queuedPageCount = repository.deactivatePublication(
        guildId,
        published.rosterType,
        reference.configuredChannelId,
      );
      if (queuedPageCount === null) {
        await reply(
          interaction,
          "That roster changed while the command was running. Copy an ID from its current publication and try again.",
        );
        return;
      }

      // Queue behind any in-flight refresh so it cannot recreate a page after deletion.
      let refreshDrainFailed = false;
      try {
        await scheduler.runNow(guildId, published.rosterType);
      } catch (error) {
        refreshDrainFailed = true;
        console.error(
          `[roster] A queued refresh failed while deleting the ${published.rosterType} publication in guild ${guildId}:`,
          error,
        );
      }
      const publisher = context.publisher ?? new RosterPublisher(repository);
      const result = await publisher.deletePublication(guild, published.rosterType);
      const configAfterDelete = repository.getGuildConfig(guildId);
      const configuredChannelAfterDelete =
        published.rosterType === "role"
          ? configAfterDelete.roleRosterChannelId
          : configAfterDelete.squadRosterChannelId;
      const rosterLabel = published.rosterType === "role" ? "role roster" : "squad roster";
      const preserved =
        published.rosterType === "role"
          ? "Tracked-role settings were preserved."
          : "Squads and member assignments were preserved.";
      const pending =
        result.pendingCleanupCount === 0
          ? ""
          : `\n\n${result.pendingCleanupCount} Discord message${result.pendingCleanupCount === 1 ? "" : "s"} could not be removed yet. ${result.pendingCleanupCount === 1 ? "Its" : "Their"} controls are inactive, and cleanup will retry automatically; you can also delete ${result.pendingCleanupCount === 1 ? "it" : "them"} manually.`;
      const refreshWarning = refreshDrainFailed
        ? "\n\nA separate queued roster refresh also failed. The requested publication was still deleted; check the bot log for the unrelated refresh error."
        : "";
      const concurrentReenable = configuredChannelAfterDelete
        ? `\n\nAnother manager re-enabled the ${rosterLabel} in <#${configuredChannelAfterDelete}> while deletion was finishing. That newer publication remains active.`
        : "";
      const state = configuredChannelAfterDelete ? "Deleted" : "Deleted and disabled";
      await reply(
        interaction,
        `${state} the ${rosterLabel} (${queuedPageCount} page${queuedPageCount === 1 ? "" : "s"}). ${preserved}${pending}${refreshWarning}${concurrentReenable}`,
      );
      return;
    }
    case "move": {
      const reference = getPublicationReference(
        repository,
        guildId,
        interaction.options.getString("message-id", true),
      );
      if (!reference) {
        await reply(
          interaction,
          "That message ID is not recognized as a published roster page in this server. Enable Developer Mode, then copy the ID from any page of the roster.",
        );
        return;
      }
      const { publication: published } = reference;

      const selectedChannel = interaction.options.getChannel("channel", true);
      const channel = await getUsableRosterChannel(guild, selectedChannel.id);
      if (!movePublicationIfCurrent(repository, reference, channel.id)) {
        await reply(
          interaction,
          "That roster changed while the command was running. Copy an ID from its current publication and try again.",
        );
        return;
      }
      const syncNote = await refreshAfterMutation(
        scheduler,
        guildId,
        published.rosterType,
      );
      const rosterLabel = published.rosterType === "role" ? "role roster" : "squad roster";
      const configAfterMove = repository.getGuildConfig(guildId);
      const configuredChannelAfterMove =
        published.rosterType === "role"
          ? configAfterMove.roleRosterChannelId
          : configAfterMove.squadRosterChannelId;
      const activePages = repository.listPublishedMessages(guildId, published.rosterType);
      const fullyPublished =
        configuredChannelAfterMove === channel.id &&
        activePages.length > 0 &&
        activePages.every((page) => page.channelId === channel.id);

      if (!fullyPublished) {
        const status =
          configuredChannelAfterMove === channel.id
            ? `The ${rosterLabel} destination is set to <#${channel.id}>, but the move is not complete yet.`
            : `The ${rosterLabel} could not be published in <#${channel.id}>, so it is not currently configured to that channel.`;
        const retryCommand = published.rosterType === "role" ? "/roster refresh" : "/squad refresh";
        await reply(
          interaction,
          `${status}${syncNote}\n\nCheck the bot's channel permissions, then retry the move or use \`${retryCommand}\`.`,
        );
        return;
      }

      const cleanupNote = pendingCleanupNote(
        repository,
        guildId,
        published.rosterType,
      );
      await reply(
        interaction,
        `The ${rosterLabel} is now published in <#${channel.id}>.${syncNote}${cleanupNote}`,
      );
      return;
    }
    default:
      await reply(interaction, "Unknown roster action.");
  }
}

async function handleSquadCommand(
  interaction: ChatInputCommandInteraction,
  { repository, scheduler }: CommandContext,
): Promise<void> {
  const guild = interaction.guild as Guild;
  const guildId = guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (squadAdminSubcommands.has(subcommand)) {
    if (!isServerManager(interaction)) {
      await reply(
        interaction,
        "You need the **Manage Server** permission to change squad roster settings.",
      );
      return;
    }

    if (subcommand === "set-channel") {
      const selectedChannel = interaction.options.getChannel("channel", true);
      const channel = await getUsableRosterChannel(guild, selectedChannel.id);
      repository.setSquadRosterChannel(guildId, channel.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      const cleanupNote = pendingCleanupNote(repository, guildId, "squad");
      await reply(
        interaction,
        `The squad roster channel is now <#${channel.id}>.${syncNote}${cleanupNote}`,
      );
      return;
    }

    if (subcommand === "set-call-channel") {
      const selected = interaction.options.getChannel("channel", true);
      const channel = await guild.channels.fetch(selected.id);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await reply(interaction, "Choose a server text or announcement channel.");
        return;
      }
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      const missing = [
        [PermissionFlagsBits.ViewChannel, "View Channel"],
        [PermissionFlagsBits.SendMessages, "Send Messages"],
      ] as const;
      const missingNames = missing.filter(([permission]) => !permissions?.has(permission)).map(([, name]) => name);
      if (missingNames.length) {
        await reply(interaction, `The bot is missing these permissions in <#${channel.id}>: ${missingNames.join(", ")}.`);
        return;
      }
      repository.setSquadCallChannel(guildId, channel.id);
      await reply(interaction, `Squad calls will now be sent in <#${channel.id}>.`);
      return;
    }

    if (subcommand === "clear-call-channel") {
      repository.setSquadCallChannel(guildId, null);
      await reply(interaction, "Squad call notifications are now disabled.");
      return;
    }

    if (subcommand === "set-rank-channel") {
      const selected = interaction.options.getChannel("channel", true);
      const channel = await guild.channels.fetch(selected.id);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await reply(interaction, "Choose a server text or announcement channel.");
        return;
      }
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      if (!channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        await reply(interaction, "The bot needs View Channel and Send Messages in that channel.");
        return;
      }
      repository.setRankUpdateChannel(guildId, channel.id);
      await reply(interaction, `Automatic rank promotions will now be announced in <#${channel.id}>.`);
      return;
    }

    if (subcommand === "clear-rank-channel") {
      repository.setRankUpdateChannel(guildId, null);
      await reply(interaction, "Automatic rank promotion announcements are now disabled.");
      return;
    }

    if (subcommand === "set-leader-role") {
      const role = interaction.options.getRole("role", true);
      if (role.id === guild.id || role.managed) {
        await reply(
          interaction,
          "Choose a regular server role. `@everyone` and integration-managed roles cannot be squad leader roles.",
        );
        return;
      }
      repository.setSquadLeaderRole(guildId, role.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(
        interaction,
        `Everyone with <@&${role.id}> can now create squads and manage assignments.${syncNote}`,
      );
      return;
    }

    if (subcommand === "set-voice-lobby") {
      const selected = interaction.options.getChannel("channel", true);
      const channel = await guild.channels.fetch(selected.id);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await reply(interaction, "Choose a server voice channel.");
        return;
      }
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      const required = [
        [PermissionFlagsBits.ViewChannel, "View Channel"],
        [PermissionFlagsBits.Connect, "Connect"],
        [PermissionFlagsBits.MoveMembers, "Move Members"],
        [PermissionFlagsBits.ManageChannels, "Manage Channels"],
      ] as const;
      const missing = required
        .filter(([permission]) => !permissions?.has(permission))
        .map(([, name]) => name);
      if (missing.length > 0) {
        await reply(interaction, `The bot is missing these permissions in <#${channel.id}>: ${missing.join(", ")}.`);
        return;
      }
      repository.setTemporaryVoiceLobbyChannel(guildId, channel.id);
      await reply(interaction, `Joining <#${channel.id}> will now create temporary voice channels for server managers and squad leaders.`);
      return;
    }

    if (subcommand === "clear-voice-lobby") {
      repository.setTemporaryVoiceLobbyChannel(guildId, null);
      await reply(interaction, "Temporary voice channel creation is now disabled. Existing temporary channels will still be removed when empty.");
      return;
    }

    if (subcommand === "set-rank") {
      const user = interaction.options.getUser("member", true);
      const member = await guild.members.fetch(user.id);
      const rank = interaction.options.getString("rank", true);
      const seconds = requiredSecondsForRank(rank);
      if (seconds === null) {
        await reply(interaction, "That rank is not recognized.");
        return;
      }
      const canReachGeneral = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild);
      const isOfficer = canReachGeneral || Boolean(
        repository.getGuildConfig(guildId).squadLeaderRoleId &&
        member.roles.cache.has(repository.getGuildConfig(guildId).squadLeaderRoleId!),
      );
      if (isOfficerRank(rank) && !isOfficer) {
        await reply(interaction, "Officer ranks can only be assigned to squad managers, server managers, or the server owner.");
        return;
      }
      if (isGeneralOfficerRank(rank) && !canReachGeneral) {
        await reply(interaction, "General officer ranks can only be assigned to members with Manage Server or the server owner.");
        return;
      }
      if ((isManualEnlistedRank(rank) || !isOfficerRank(rank)) && isOfficer) {
        await reply(interaction, "Enlisted ranks can only be assigned to members on the enlisted track.");
        return;
      }
      repository.ensureMemberRankTrack(guildId, user.id, isOfficer ? "officer" : "enlisted");
      if (isManualEnlistedRank(rank)) {
        repository.setManualRank(guildId, user.id, rank);
      } else {
        repository.setVoiceActivitySeconds(guildId, user.id, seconds);
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(interaction, `Set <@${user.id}>'s activity rank to **${rankDisplayName(rank)}**.${syncNote}`);
      return;
    }

    repository.setSquadLeaderRole(guildId, null);
    const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
    await reply(
      interaction,
      `The squad leader role was cleared. Server managers still have access.${syncNote}`,
    );
    return;
  }

  if (subcommand === "rank-progress") {
    const user = interaction.options.getUser("member") ?? interaction.user;
    const member = await guild.members.fetch(user.id);
    const config = repository.getGuildConfig(guildId);
    const canReachGeneral = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild);
    const isOfficer = canReachGeneral || Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
    repository.ensureMemberRankTrack(guildId, user.id, isOfficer ? "officer" : "enlisted");
    const state = repository.getMemberRankState(guildId, user.id);
    const seconds = repository.getVoiceActivitySeconds(guildId, user.id);
    const track = isOfficer
      ? (canReachGeneral ? OFFICER_RANKS : OFFICER_RANKS.slice(0, 6))
      : ENLISTED_RANKS;
    const currentIndex = Math.max(0, track.findLastIndex((rank) => seconds >= rank.requiredSeconds));
    const current = state.manualRank ?? track[currentIndex]!.abbreviation;
    const next = state.manualRank ? undefined : track[currentIndex + 1];
    const progress = next
      ? Math.min(100, Math.floor((seconds - track[currentIndex]!.requiredSeconds) / (next.requiredSeconds - track[currentIndex]!.requiredSeconds) * 100))
      : 100;
    await reply(interaction, `<@${user.id}> has **${formatDuration(seconds)}** of logged squad voice time.\nCurrent rank: **${rankDisplayName(current)}**\n${next ? `Next rank: **${rankDisplayName(next.abbreviation)}** — **${progress}%** complete (${formatDuration(Math.max(0, next.requiredSeconds - seconds))} remaining)` : "This member is at the top of their current rank track."}`);
    return;
  }

  if (subcommand === "list") {
    const squads = repository.listSquads(guildId);
    const counts = new Map<number, number>();
    for (const membership of repository.listMemberships(guildId)) {
      counts.set(membership.squadId, (counts.get(membership.squadId) ?? 0) + 1);
    }

    const content =
      squads.length === 0
        ? "No squads have been created yet."
        : `Squads:\n${squads
            .map(
              (squad) =>
                `• **${escapeRosterText(squad.name)}** — ${counts.get(squad.id) ?? 0} members`,
            )
            .join("\n")}`;
    await reply(interaction, truncate(content, 1_900));
    return;
  }

  if (!(await canManageSquads(interaction, repository))) {
    const leaderRoleId = repository.getGuildConfig(guildId).squadLeaderRoleId;
    const access = leaderRoleId ? `<@&${leaderRoleId}>` : "a server manager";
    await reply(interaction, `You must be ${access} to manage squads.`);
    return;
  }

  switch (subcommand) {
    case "create": {
      if (repository.listSquads(guildId).length >= MAX_INTERACTIVE_SQUADS) {
        await reply(
          interaction,
          `This server has reached the ${MAX_INTERACTIVE_SQUADS}-squad limit supported by the roster menus.`,
        );
        return;
      }
      const squad = repository.createSquad(
        guildId,
        interaction.options.getString("name", true),
        interaction.user.id,
      );
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(
        interaction,
        `Created squad **${escapeRosterText(squad.name)}**.${syncNote}`,
      );
      return;
    }
    case "rename": {
      const squadId = parseSquadId(interaction.options.getString("squad", true));
      const renamed = squadId
        ? repository.renameSquad(
            guildId,
            squadId,
            interaction.options.getString("name", true),
          )
        : null;
      if (!renamed) {
        await reply(interaction, "That squad no longer exists. Choose it again and retry.");
        return;
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(
        interaction,
        `Renamed the squad to **${escapeRosterText(renamed.name)}**.${syncNote}`,
      );
      return;
    }
    case "delete": {
      if (!interaction.options.getBoolean("confirm", true)) {
        await reply(interaction, "Deletion cancelled; no squad data was changed.");
        return;
      }
      const squadId = parseSquadId(interaction.options.getString("squad", true));
      const squad = squadId ? repository.getSquad(guildId, squadId) : null;
      if (squad) {
        for (const membership of repository.listMemberships(guildId)) {
          if (membership.squadId === squad.id) repository.endVoiceActivity(guildId, membership.userId);
        }
      }
      if (!squad || !repository.deleteSquad(guildId, squad.id)) {
        await reply(interaction, "That squad no longer exists. Choose it again and retry.");
        return;
      }
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(
        interaction,
        `Deleted **${escapeRosterText(squad.name)}** and moved its members to Unassigned.${syncNote}`,
      );
      return;
    }
    case "assign": {
      const user = interaction.options.getUser("member", true);
      const member = await guild.members.fetch(user.id);
      if (member.user.bot && !repository.getGuildConfig(guildId).includeBots) {
        await reply(interaction, "Bots are excluded from this server's rosters.");
        return;
      }

      const squadId = parseSquadId(interaction.options.getString("squad", true));
      const squad = squadId ? repository.getSquad(guildId, squadId) : null;
      if (!squad) {
        await reply(interaction, "That squad no longer exists. Choose it again and retry.");
        return;
      }
      repository.endVoiceActivity(guildId, member.id);
      repository.assignMember(guildId, member.id, squad.id, interaction.user.id);
      const syncNote = await refreshAfterMutation(scheduler, guildId, "squad");
      await reply(
        interaction,
        `Assigned <@${member.id}> to **${escapeRosterText(squad.name)}**. Any previous assignment was replaced.${syncNote}`,
      );
      return;
    }
    case "unassign": {
      const user = interaction.options.getUser("member", true);
      repository.endVoiceActivity(guildId, user.id);
      const removed = repository.unassignMember(guildId, user.id);
      const syncNote = removed
        ? await refreshAfterMutation(scheduler, guildId, "squad")
        : "";
      await reply(
        interaction,
        `${removed ? `<@${user.id}> is now Unassigned.` : `<@${user.id}> was not assigned to a squad.`}${syncNote}`,
      );
      return;
    }
    case "refresh": {
      if (!repository.getGuildConfig(guildId).squadRosterChannelId) {
        await reply(interaction, "Set a squad roster channel first with `/squad set-channel`.");
        return;
      }
      await scheduler.runNow(guildId, "squad", true);
      await reply(interaction, "The squad roster has been reconciled and refreshed.");
      return;
    }
    default:
      await reply(interaction, "Unknown squad action.");
  }
}

async function getUsableRosterChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildBasedChannel> {
  const channel = await guild.channels.fetch(channelId);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    throw new RosterChannelError("Roster channels must be server text or announcement channels.");
  }

  const missing = await missingRosterChannelPermissions(guild, channel);
  if (missing.length > 0) {
    throw new RosterChannelError(
      `The bot is missing these permissions in <#${channel.id}>: ${missing.join(", ")}.`,
    );
  }
  return channel;
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.editReply({
    content,
    allowedMentions: { parse: [] },
  });
}

function parseSquadId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface PublicationReference {
  publication: PublishedMessage;
  configuredChannelId: string | null;
}

function getPublicationReference(
  repository: RosterRepository,
  guildId: string,
  rawMessageId: string,
): PublicationReference | null {
  const messageId = rawMessageId.trim();
  if (!/^\d{17,20}$/.test(messageId)) {
    return null;
  }
  const published = repository.getPublishedMessageById(guildId, messageId);
  if (!published) {
    return null;
  }
  const config = repository.getGuildConfig(guildId);
  const currentChannelId =
    published.rosterType === "role"
      ? config.roleRosterChannelId
      : config.squadRosterChannelId;
  return { publication: published, configuredChannelId: currentChannelId };
}

function movePublicationIfCurrent(
  repository: RosterRepository,
  reference: PublicationReference,
  nextChannelId: string,
): boolean {
  const { publication } = reference;
  return publication.rosterType === "role"
    ? repository.moveRoleRosterChannelIfMatches(
        publication.guildId,
        reference.configuredChannelId,
        nextChannelId,
      )
    : repository.moveSquadRosterChannelIfMatches(
        publication.guildId,
        reference.configuredChannelId,
        nextChannelId,
      );
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  return `${hours}h ${minutes}m`;
}

function pendingCleanupNote(
  repository: RosterRepository,
  guildId: string,
  target: Exclude<RosterTarget, "both">,
): string {
  const pending = repository.listPublishedMessageCleanup(guildId, target).length;
  if (pending === 0) {
    return "";
  }
  return `\n\nThe new roster is active, but ${pending} old roster message${pending === 1 ? "" : "s"} could not be removed. Delete ${pending === 1 ? "it" : "them"} manually or temporarily restore the bot's View Channel permission there; cleanup will retry automatically.`;
}

async function refreshAfterMutation(
  scheduler: RosterScheduler,
  guildId: string,
  target: RosterTarget,
): Promise<string> {
  try {
    await scheduler.runNow(guildId, target);
    return "";
  } catch (error) {
    console.error(
      `[roster] A ${target} change was saved but its publication failed in guild ${guildId}:`,
      error,
    );
    return "\n\nThe change was saved, but the roster message could not be updated. Check the bot's channel permissions, then use the refresh command.";
  }
}

function publicErrorMessage(error: unknown): string {
  if (
    error instanceof DuplicateSquadNameError ||
    error instanceof SquadNameError ||
    error instanceof RosterChannelError
  ) {
    return error.message;
  }

  if (error instanceof DiscordAPIError && error.status === 403) {
    return "Discord refused that action because the bot is missing a required channel permission.";
  }

  return "The command could not be completed. Check the bot log for details and try again.";
}
