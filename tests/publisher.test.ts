import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  RESTJSONErrorCodes,
  type Guild,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { RosterRepository } from "../src/database.js";
import { RosterPublisher } from "../src/rosters/publisher.js";

describe("RosterPublisher", () => {
  let repository: RosterRepository;

  afterEach(() => {
    repository?.close();
  });

  it("tracks failed old-channel cleanup and retries it without losing the active message", async () => {
    repository = new RosterRepository(":memory:");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "old-channel",
      messageId: "old-message",
    });
    repository.setRoleRosterChannel("guild-1", "new-channel");

    const oldDelete = vi.fn(async (): Promise<void> => {
      throw new Error("temporary channel failure");
    });
    const oldChannel = fakeChannel("old-channel", "unused", oldDelete);
    const newChannel = fakeChannel("new-channel", "new-message");
    const channels = new Map([
      [oldChannel.id, oldChannel],
      [newChannel.id, newChannel],
    ]);
    const guild = {
      id: "guild-1",
      channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    } as unknown as Guild;
    const publisher = new RosterPublisher(repository);
    const pages = [new EmbedBuilder().setTitle("Roster")];

    await publisher.publish(guild, "new-channel", "role", pages);

    expect(repository.listPublishedMessages("guild-1", "role")[0]).toMatchObject({
      channelId: "new-channel",
      messageId: "new-message",
    });
    expect(repository.listPublishedMessageCleanup("guild-1", "role")).toHaveLength(1);
    expect(newChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );

    oldDelete.mockImplementation(async () => undefined);
    await publisher.publish(guild, "new-channel", "role", pages);

    expect(repository.listPublishedMessageCleanup("guild-1", "role")).toEqual([]);
    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(newChannel.messages.edit).toHaveBeenCalledWith(
      "new-message",
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
  });

  it("recreates a roster page when its stored message was deleted", async () => {
    repository = new RosterRepository(":memory:");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "squad",
      ordinal: 0,
      channelId: "channel-1",
      messageId: "deleted-message",
    });
    repository.setSquadRosterChannel("guild-1", "channel-1");
    const channel = fakeChannel("channel-1", "replacement-message");
    const unknownMessage = Object.assign(new Error("Unknown Message"), {
      code: RESTJSONErrorCodes.UnknownMessage,
    });
    Object.setPrototypeOf(unknownMessage, DiscordAPIError.prototype);
    channel.messages.edit.mockRejectedValueOnce(unknownMessage);
    const guild = fakeGuild(channel);

    await new RosterPublisher(repository).publish(guild, channel.id, "squad", [
      new EmbedBuilder().setTitle("Squads"),
    ]);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(repository.listPublishedMessages("guild-1", "squad")[0]?.messageId).toBe(
      "replacement-message",
    );
  });

  it("deletes publication pages that are no longer needed", async () => {
    repository = new RosterRepository(":memory:");
    for (const [ordinal, messageId] of ["page-1", "page-2"].entries()) {
      repository.upsertPublishedMessage({
        guildId: "guild-1",
        rosterType: "role",
        ordinal,
        channelId: "channel-1",
        messageId,
      });
    }
    repository.setRoleRosterChannel("guild-1", "channel-1");
    const channel = fakeChannel("channel-1", "unused");
    const guild = fakeGuild(channel);

    await new RosterPublisher(repository).publish(guild, channel.id, "role", [
      new EmbedBuilder().setTitle("Roles"),
    ]);

    expect(channel.messages.delete).toHaveBeenCalledWith("page-2");
    expect(repository.listPublishedMessages("guild-1", "role")).toHaveLength(1);
  });

  it("deactivates an obsolete page even when Discord cleanup must be retried", async () => {
    repository = new RosterRepository(":memory:");
    for (const [ordinal, messageId] of ["page-1", "page-2"].entries()) {
      repository.upsertPublishedMessage({
        guildId: "guild-1",
        rosterType: "squad",
        ordinal,
        channelId: "channel-1",
        messageId,
      });
    }
    repository.setSquadRosterChannel("guild-1", "channel-1");
    const deleteMessage = vi.fn(async (): Promise<void> => {
      throw new Error("temporary permission failure");
    });
    const channel = fakeChannel("channel-1", "unused", deleteMessage);

    await new RosterPublisher(repository).publish(fakeGuild(channel), channel.id, "squad", [
      new EmbedBuilder().setTitle("Squads"),
    ]);

    expect(repository.listPublishedMessages("guild-1", "squad")).toHaveLength(1);
    expect(repository.getPublishedMessageById("guild-1", "page-2")).toBeNull();
    expect(repository.listPublishedMessageCleanup("guild-1", "squad")).toEqual([
      expect.objectContaining({ messageId: "page-2" }),
    ]);
  });

  it("deactivates every publication page and queues failed Discord deletions", async () => {
    repository = new RosterRepository(":memory:");
    for (const [ordinal, messageId] of ["page-1", "page-2"].entries()) {
      repository.upsertPublishedMessage({
        guildId: "guild-1",
        rosterType: "squad",
        ordinal,
        channelId: "channel-1",
        messageId,
      });
    }
    const deleteMessage = vi.fn(async (messageId: string): Promise<void> => {
      if (messageId === "page-2") {
        throw new Error("temporary permission failure");
      }
    });
    const channel = fakeChannel("channel-1", "unused", deleteMessage);

    const result = await new RosterPublisher(repository).deletePublication(
      fakeGuild(channel),
      "squad",
    );

    expect(result).toEqual({ pendingCleanupCount: 1 });
    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(repository.listPublishedMessages("guild-1", "squad")).toEqual([]);
    expect(repository.listPublishedMessageCleanup("guild-1", "squad")).toEqual([
      {
        guildId: "guild-1",
        rosterType: "squad",
        ordinal: 1,
        channelId: "channel-1",
        messageId: "page-2",
      },
    ]);
  });

  it("treats an already-missing page as successfully deactivated", async () => {
    repository = new RosterRepository(":memory:");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "channel-1",
      messageId: "missing-page",
    });
    const unknownMessage = Object.assign(new Error("Unknown Message"), {
      code: RESTJSONErrorCodes.UnknownMessage,
    });
    Object.setPrototypeOf(unknownMessage, DiscordAPIError.prototype);
    const deleteMessage = vi.fn(async (): Promise<void> => {
      throw unknownMessage;
    });
    const channel = fakeChannel("channel-1", "unused", deleteMessage);

    const result = await new RosterPublisher(repository).deletePublication(
      fakeGuild(channel),
      "role",
    );

    expect(result).toEqual({ pendingCleanupCount: 0 });
    expect(repository.listPublishedMessages("guild-1", "role")).toEqual([]);
    expect(repository.listPublishedMessageCleanup("guild-1", "role")).toEqual([]);
  });

  it("discovers and deletes stranded pages while a publication remains disabled", async () => {
    repository = new RosterRepository(":memory:");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "squad",
      ordinal: 0,
      channelId: "channel-1",
      messageId: "stranded-page",
    });
    const channel = fakeChannel("channel-1", "unused");

    await new RosterPublisher(repository).retryQueuedCleanup(
      fakeGuild(channel),
      "squad",
    );

    expect(channel.messages.delete).toHaveBeenCalledWith("stranded-page");
    expect(repository.listPublishedMessages("guild-1", "squad")).toEqual([]);
    expect(repository.listPublishedMessageCleanup("guild-1", "squad")).toEqual([]);
  });

  it("never deletes a newer publication that was re-enabled during cleanup", async () => {
    repository = new RosterRepository(":memory:");
    repository.setRoleRosterChannel("guild-1", "old-channel");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "old-channel",
      messageId: "old-page",
    });
    expect(repository.deactivatePublication("guild-1", "role", "old-channel")).toBe(1);
    repository.setRoleRosterChannel("guild-1", "new-channel");
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "new-channel",
      messageId: "new-page",
    });
    const oldChannel = fakeChannel("old-channel", "unused");
    const newChannel = fakeChannel("new-channel", "unused");
    const channels = new Map([
      [oldChannel.id, oldChannel],
      [newChannel.id, newChannel],
    ]);
    const guild = {
      id: "guild-1",
      channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    } as unknown as Guild;

    await new RosterPublisher(repository).deletePublication(guild, "role");

    expect(oldChannel.messages.delete).toHaveBeenCalledWith("old-page");
    expect(newChannel.messages.delete).not.toHaveBeenCalled();
    expect(repository.listPublishedMessages("guild-1", "role")).toEqual([
      expect.objectContaining({ channelId: "new-channel", messageId: "new-page" }),
    ]);
  });
});

type TestChannel = (TextChannel | NewsChannel) & {
  send: ReturnType<typeof vi.fn>;
  messages: {
    edit: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function fakeChannel(
  id: string,
  sentMessageId: string,
  deleteMessage: Mock<(messageId: string) => Promise<void>> = vi.fn(
    async (): Promise<void> => undefined,
  ),
): TestChannel {
  const edit = vi.fn(async () => ({ id: sentMessageId }) as Message);
  const send = vi.fn(async () => ({ id: sentMessageId }) as Message);
  return {
    id,
    type: ChannelType.GuildText,
    send,
    messages: { edit, delete: deleteMessage },
  } as unknown as TestChannel;
}

function fakeGuild(channel: TestChannel): Guild {
  return {
    id: "guild-1",
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Guild;
}
