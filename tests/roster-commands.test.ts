import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleChatInputCommand,
  type CommandContext,
} from "../src/commands.js";
import { RosterRepository } from "../src/database.js";
import type { RosterScheduler } from "../src/scheduler.js";
import type { PublishedMessage } from "../src/types.js";

const GUILD_ID = "guild-1";
const OTHER_GUILD_ID = "guild-2";
const OLD_CHANNEL_ID = "444444444444444444";
const CURRENT_CHANNEL_ID = "555555555555555555";
const DESTINATION_CHANNEL_ID = "666666666666666666";
const ROLE_PAGE_ONE_ID = "111111111111111111";
const ROLE_PAGE_TWO_ID = "111111111111111112";
const SQUAD_PAGE_ID = "222222222222222222";
const FOREIGN_PAGE_ID = "333333333333333333";

interface ContextHarness {
  context: CommandContext;
  runNow: ReturnType<typeof vi.fn>;
  deletePublication: ReturnType<typeof vi.fn>;
}

interface InteractionHarness {
  interaction: ChatInputCommandInteraction;
  guild: Guild;
  getSubcommand: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
}

describe("/roster publication management", () => {
  let repository: RosterRepository;

  beforeEach(() => {
    repository = new RosterRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
    vi.restoreAllMocks();
  });

  it("requires Manage Server before inspecting the requested roster action", async () => {
    const command = interactionMock({ subcommand: "delete", manager: false });
    const harness = contextMock(repository);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(command.getSubcommand).not.toHaveBeenCalled();
    expect(lastReply(command)).toContain("Manage Server");
    expect(harness.runNow).not.toHaveBeenCalled();
    expect(harness.deletePublication).not.toHaveBeenCalled();
  });

  it("uses any active page ID to find the roster and cancels safely without confirmation", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_ONE_ID,
    });
    repository.upsertPublishedMessage({
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 1,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_TWO_ID,
    });
    const command = interactionMock({
      subcommand: "delete",
      messageId: `  ${ROLE_PAGE_TWO_ID}  `,
      confirm: false,
    });
    const harness = contextMock(repository);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBe(
      OLD_CHANNEL_ID,
    );
    expect(repository.listPublishedMessages(GUILD_ID, "role")).toHaveLength(2);
    expect(harness.runNow).not.toHaveBeenCalled();
    expect(harness.deletePublication).not.toHaveBeenCalled();
    expect(lastReply(command)).toContain("Deletion cancelled");
  });

  it("deactivates the complete roster before draining refreshes and deleting every page", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_ONE_ID,
    });
    repository.upsertPublishedMessage({
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 1,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_TWO_ID,
    });
    const command = interactionMock({
      subcommand: "delete",
      messageId: ROLE_PAGE_TWO_ID,
      confirm: true,
    });
    const harness = contextMock(repository, {
      pendingCleanupCount: 1,
    });
    harness.runNow.mockImplementation(async () => {
      expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBeNull();
      expect(repository.listPublishedMessages(GUILD_ID, "role")).toEqual([]);
      expect(repository.listPublishedMessageCleanup(GUILD_ID, "role")).toHaveLength(2);
    });

    await handleChatInputCommand(command.interaction, harness.context);

    expect(harness.runNow).toHaveBeenCalledWith(GUILD_ID, "role");
    expect(harness.deletePublication).toHaveBeenCalledWith(command.guild, "role");
    expect(harness.runNow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.deletePublication.mock.invocationCallOrder[0] ?? 0,
    );
    expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBeNull();
    expect(lastReply(command)).toContain("Deleted and disabled the role roster (2 pages)");
    expect(lastReply(command)).toContain("Tracked-role settings were preserved");
    expect(lastReply(command)).toContain("1 Discord message could not be removed");
  });

  it("still deletes the publication when draining a separate queued refresh fails", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "squad",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: SQUAD_PAGE_ID,
    });
    repository.upsertPublishedMessage({
      guildId: GUILD_ID,
      rosterType: "squad",
      ordinal: 1,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_TWO_ID,
    });
    const command = interactionMock({
      subcommand: "delete",
      messageId: SQUAD_PAGE_ID,
      confirm: true,
    });
    const harness = contextMock(repository);
    harness.runNow.mockRejectedValue(new Error("unrelated queued refresh failed"));
    harness.deletePublication.mockResolvedValue({ pendingCleanupCount: 0 });
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(harness.runNow).toHaveBeenCalledWith(GUILD_ID, "squad");
    expect(harness.deletePublication).toHaveBeenCalledWith(command.guild, "squad");
    expect(harness.runNow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.deletePublication.mock.invocationCallOrder[0] ?? 0,
    );
    expect(repository.getGuildConfig(GUILD_ID).squadRosterChannelId).toBeNull();
    expect(repository.listPublishedMessages(GUILD_ID, "squad")).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("queued refresh failed while deleting the squad publication"),
      expect.any(Error),
    );
    expect(lastReply(command)).toContain("Deleted and disabled the squad roster (2 pages)");
    expect(lastReply(command)).toContain("A separate queued roster refresh also failed");
    expect(lastReply(command)).toContain("requested publication was still deleted");
  });

  it.each([
    ["an invalid ID", "not-a-snowflake"],
    ["a publication belonging to another server", FOREIGN_PAGE_ID],
  ])("rejects %s without changing configuration", async (kind, messageId) => {
    if (kind === "a publication belonging to another server") {
      seedPublication(repository, {
        guildId: OTHER_GUILD_ID,
        rosterType: "squad",
        ordinal: 0,
        channelId: OLD_CHANNEL_ID,
        messageId: FOREIGN_PAGE_ID,
      });
    }
    const command = interactionMock({ subcommand: "delete", messageId, confirm: true });
    const harness = contextMock(repository);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(harness.runNow).not.toHaveBeenCalled();
    expect(harness.deletePublication).not.toHaveBeenCalled();
    expect(lastReply(command)).toContain("not recognized as a published roster page");
  });

  it("allows an old active page ID to recover and delete a previously failed move", async () => {
    repository.setRoleRosterChannel(GUILD_ID, CURRENT_CHANNEL_ID);
    repository.upsertPublishedMessage({
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_ONE_ID,
    });
    const command = interactionMock({
      subcommand: "delete",
      messageId: ROLE_PAGE_ONE_ID,
      confirm: true,
    });
    const harness = contextMock(repository);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBeNull();
    expect(repository.listPublishedMessages(GUILD_ID, "role")).toEqual([]);
    expect(repository.listPublishedMessageCleanup(GUILD_ID, "role")).toEqual([
      expect.objectContaining({ messageId: ROLE_PAGE_ONE_ID }),
    ]);
    expect(harness.deletePublication).toHaveBeenCalledWith(command.guild, "role");
  });

  it("preserves and reports a newer publication re-enabled while deletion finishes", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_ONE_ID,
    });
    const command = interactionMock({
      subcommand: "delete",
      messageId: ROLE_PAGE_ONE_ID,
      confirm: true,
    });
    const harness = contextMock(repository);
    harness.runNow.mockImplementation(async () => {
      repository.setRoleRosterChannel(GUILD_ID, CURRENT_CHANNEL_ID);
      repository.upsertPublishedMessage({
        guildId: GUILD_ID,
        rosterType: "role",
        ordinal: 0,
        channelId: CURRENT_CHANNEL_ID,
        messageId: ROLE_PAGE_TWO_ID,
      });
    });

    await handleChatInputCommand(command.interaction, harness.context);

    expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBe(
      CURRENT_CHANNEL_ID,
    );
    expect(repository.listPublishedMessages(GUILD_ID, "role")).toEqual([
      expect.objectContaining({
        channelId: CURRENT_CHANNEL_ID,
        messageId: ROLE_PAGE_TWO_ID,
      }),
    ]);
    expect(lastReply(command)).toContain("Another manager re-enabled the role roster");
    expect(lastReply(command)).toContain("newer publication remains active");
    expect(lastReply(command)).not.toContain("Deleted and disabled");
  });

  it.each([
    ["role", ROLE_PAGE_ONE_ID],
    ["squad", SQUAD_PAGE_ID],
  ] as const)(
    "moves the roster type identified by a %s page into the selected channel",
    async (rosterType, messageId) => {
      seedPublication(repository, {
        guildId: GUILD_ID,
        rosterType,
        ordinal: 0,
        channelId: OLD_CHANNEL_ID,
        messageId,
      });
      const destination = usableTextChannel(DESTINATION_CHANNEL_ID);
      const command = interactionMock({
        subcommand: "move",
        messageId,
        destination,
      });
      const harness = contextMock(repository);
      harness.runNow.mockImplementation(async () => {
        for (const page of repository.listPublishedMessages(GUILD_ID, rosterType)) {
          repository.upsertPublishedMessage({
            ...page,
            channelId: DESTINATION_CHANNEL_ID,
            messageId: `${rosterType === "role" ? "7" : "8"}${String(page.ordinal).padStart(17, "0")}`,
          });
        }
      });

      await handleChatInputCommand(command.interaction, harness.context);

      const config = repository.getGuildConfig(GUILD_ID);
      expect(
        rosterType === "role"
          ? config.roleRosterChannelId
          : config.squadRosterChannelId,
      ).toBe(DESTINATION_CHANNEL_ID);
      expect(
        rosterType === "role"
          ? config.squadRosterChannelId
          : config.roleRosterChannelId,
      ).toBeNull();
      expect(harness.runNow).toHaveBeenCalledWith(GUILD_ID, rosterType);
      expect(harness.deletePublication).not.toHaveBeenCalled();
      expect(lastReply(command)).toContain(
        `The ${rosterType} roster is now published in <#${DESTINATION_CHANNEL_ID}>.`,
      );
    },
  );

  it("reports a saved but incomplete destination when Discord publication fails", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "squad",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: SQUAD_PAGE_ID,
    });
    const command = interactionMock({
      subcommand: "move",
      messageId: SQUAD_PAGE_ID,
      destination: usableTextChannel(DESTINATION_CHANNEL_ID),
    });
    const harness = contextMock(repository);
    harness.runNow.mockRejectedValue(new Error("Discord send failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(repository.getGuildConfig(GUILD_ID).squadRosterChannelId).toBe(
      DESTINATION_CHANNEL_ID,
    );
    expect(lastReply(command)).toContain("destination is set");
    expect(lastReply(command)).toContain("move is not complete yet");
    expect(lastReply(command)).not.toContain("is now published");
  });

  it("does not overwrite a newer roster destination resolved during a move", async () => {
    seedPublication(repository, {
      guildId: GUILD_ID,
      rosterType: "role",
      ordinal: 0,
      channelId: OLD_CHANNEL_ID,
      messageId: ROLE_PAGE_ONE_ID,
    });
    const destination = {
      id: DESTINATION_CHANNEL_ID,
      type: ChannelType.GuildText,
      permissionsFor: vi.fn(() => {
        repository.setRoleRosterChannel(GUILD_ID, CURRENT_CHANNEL_ID);
        return { has: () => true };
      }),
    } as unknown as GuildBasedChannel;
    const command = interactionMock({
      subcommand: "move",
      messageId: ROLE_PAGE_ONE_ID,
      destination,
    });
    const harness = contextMock(repository);

    await handleChatInputCommand(command.interaction, harness.context);

    expect(repository.getGuildConfig(GUILD_ID).roleRosterChannelId).toBe(
      CURRENT_CHANNEL_ID,
    );
    expect(harness.runNow).not.toHaveBeenCalled();
    expect(lastReply(command)).toContain("roster changed while the command was running");
  });
});

function seedPublication(
  repository: RosterRepository,
  publication: PublishedMessage,
): void {
  if (publication.rosterType === "role") {
    repository.setRoleRosterChannel(publication.guildId, publication.channelId);
  } else {
    repository.setSquadRosterChannel(publication.guildId, publication.channelId);
  }
  repository.upsertPublishedMessage(publication);
}

function contextMock(
  repository: RosterRepository,
  deletionResult = { pendingCleanupCount: 0 },
): ContextHarness {
  const runNow = vi.fn(async () => undefined);
  const deletePublication = vi.fn(async () => deletionResult);
  return {
    context: {
      repository,
      scheduler: { runNow } as unknown as RosterScheduler,
      publisher: { deletePublication },
    },
    runNow,
    deletePublication,
  };
}

function interactionMock(options: {
  subcommand: "delete" | "move";
  manager?: boolean;
  messageId?: string;
  confirm?: boolean;
  destination?: GuildBasedChannel;
}): InteractionHarness {
  const destination = options.destination ?? usableTextChannel(DESTINATION_CHANNEL_ID);
  const getSubcommand = vi.fn(() => options.subcommand);
  const editReply = vi.fn(async () => undefined);
  const guild = {
    id: GUILD_ID,
    members: { me: { id: "bot-user" } },
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelId === destination.id ? destination : null,
      ),
    },
  } as unknown as Guild;
  const interaction = {
    commandName: "roster",
    guild,
    guildId: GUILD_ID,
    user: { id: "manager-user" },
    memberPermissions: {
      has: vi.fn(() => options.manager ?? true),
    },
    options: {
      getSubcommand,
      getString: vi.fn(() => options.messageId ?? ROLE_PAGE_ONE_ID),
      getBoolean: vi.fn(() => options.confirm ?? false),
      getChannel: vi.fn(() => ({ id: destination.id })),
    },
    inGuild: () => true,
    deferReply: vi.fn(async () => undefined),
    editReply,
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
  return { interaction, guild, getSubcommand, editReply };
}

function usableTextChannel(id: string): GuildBasedChannel {
  return {
    id,
    type: ChannelType.GuildText,
    permissionsFor: vi.fn(() => ({ has: () => true })),
  } as unknown as GuildBasedChannel;
}

function lastReply(command: InteractionHarness): string {
  const payload = command.editReply.mock.calls.at(-1)?.[0] as
    | { content?: unknown }
    | undefined;
  expect(payload).toMatchObject({ allowedMentions: { parse: [] } });
  return String(payload?.content);
}
