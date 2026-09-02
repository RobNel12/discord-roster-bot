import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ALL_RANK_ABBREVIATIONS, rankDisplayName } from "./ranks.js";

const rosterCommand = new SlashCommandBuilder()
  .setName("roster")
  .setDescription("Configure roles and manage published roster messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((subcommand) =>
    subcommand.setName("setup").setDescription("Set up the role roster with guided menus"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add-page")
      .setDescription("Add a named page to the role roster")
      .addStringOption((option) => option.setName("name").setDescription("Page name").setMinLength(1).setMaxLength(50).setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove-page")
      .setDescription("Remove a page and move its roles to another page")
      .addStringOption((option) => option.setName("page").setDescription("Page to remove").setAutocomplete(true).setRequired(true))
      .addBooleanOption((option) => option.setName("confirm").setDescription("Confirm page removal").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("move-role")
      .setDescription("Move a tracked role to another roster page")
      .addRoleOption((option) => option.setName("role").setDescription("Tracked role").setRequired(true))
      .addStringOption((option) => option.setName("page").setDescription("Destination page").setAutocomplete(true).setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-priority")
      .setDescription("Change whether a tracked role is highlighted")
      .addRoleOption((option) => option.setName("role").setDescription("Tracked role").setRequired(true))
      .addBooleanOption((option) => option.setName("high-priority").setDescription("Highlight this role").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-channel")
      .setDescription("Choose the channel that will contain the role roster")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Role roster channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add-role")
      .setDescription("Add a Discord role to the live roster")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to track").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove-role")
      .setDescription("Stop tracking a Discord role")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to stop tracking").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list-roles").setDescription("Show all currently tracked roles"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("sort").setDescription("Sort tracked roles by server role hierarchy"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("clear-roles")
      .setDescription("Stop tracking every role at once")
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm removal of every tracked role")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("refresh").setDescription("Reconcile and republish the role roster"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete and disable a published role or squad roster")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of any message page in the roster")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm deletion of every page in this roster")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("move")
      .setDescription("Move a published role or squad roster to another channel")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of any message page in the roster")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Destination roster channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  );

const squadCommand = new SlashCommandBuilder()
  .setName("squad")
  .setDescription("Configure and manage the live squad roster")
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-call-channel")
      .setDescription("Choose where squad call notifications are sent")
      .addChannelOption((option) => option.setName("channel").setDescription("Squad call channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("clear-call-channel").setDescription("Disable squad call notifications"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-rank-channel")
      .setDescription("Choose where automatic rank promotions are announced")
      .addChannelOption((option) => option.setName("channel").setDescription("Rank update channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("clear-rank-channel").setDescription("Disable automatic rank promotion announcements"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rank-progress")
      .setDescription("Check logged squad voice time and progress toward the next rank")
      .addUserOption((option) => option.setName("member").setDescription("Member to check; defaults to you")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-voice-lobby")
      .setDescription("Choose the voice channel that creates temporary squad channels")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Join-to-create voice channel")
          .addChannelTypes(ChannelType.GuildVoice)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("clear-voice-lobby").setDescription("Disable temporary voice channel creation"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-rank")
      .setDescription("Set a member's activity rank")
      .addUserOption((option) =>
        option.setName("member").setDescription("Server member").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("rank")
          .setDescription("Enlisted rank abbreviation")
          .setChoices(...ALL_RANK_ABBREVIATIONS.map((rank) => ({ name: rankDisplayName(rank), value: rank })))
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-channel")
      .setDescription("Choose the channel that will contain the squad roster")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Squad roster channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set-leader-role")
      .setDescription("Let everyone with this role manage squads")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Existing squad leader role").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("clear-leader-role")
      .setDescription("Return squad management to members with Manage Server only"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a squad")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Squad name")
          .setMaxLength(50)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rename")
      .setDescription("Rename a squad")
      .addStringOption((option) =>
        option
          .setName("squad")
          .setDescription("Squad to rename")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("New squad name")
          .setMaxLength(50)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a squad and unassign its members")
      .addStringOption((option) =>
        option
          .setName("squad")
          .setDescription("Squad to delete")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm deletion and unassignment")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("assign")
      .setDescription("Assign or move a member to a squad")
      .addUserOption((option) =>
        option.setName("member").setDescription("Server member").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("squad")
          .setDescription("Destination squad")
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("unassign")
      .setDescription("Remove a member from their squad")
      .addUserOption((option) =>
        option.setName("member").setDescription("Server member").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List squads and assignment counts"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("refresh").setDescription("Reconcile and republish the squad roster"),
  );

export const commandData = [rosterCommand, squadCommand] as const;
export const commandJson = commandData.map((command) => command.toJSON());
