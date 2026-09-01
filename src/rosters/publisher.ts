import {
  type ActionRowBuilder,
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  type EmbedBuilder,
  type Guild,
  type NewsChannel,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from "discord.js";

import type { RosterRepository } from "../database.js";
import type { PublishedMessage, RosterType } from "../types.js";

type RosterChannel = TextChannel | NewsChannel;

export interface PublicationDeleteResult {
  /** Number of Discord messages still queued for a later deletion retry. */
  pendingCleanupCount: number;
}

export class RosterChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterChannelError";
  }
}

export class MissingRosterChannelError extends RosterChannelError {
  constructor(channelId: string) {
    super(`Configured roster channel ${channelId} no longer exists.`);
    this.name = "MissingRosterChannelError";
  }
}

export class RosterPublisher {
  constructor(private readonly repository: RosterRepository) {}

  async publish(
    guild: Guild,
    channelId: string,
    rosterType: RosterType,
    pages: EmbedBuilder[],
    components: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] = [],
  ): Promise<void> {
    const channel = await getRosterChannel(guild, channelId);
    await this.retryQueuedCleanup(guild, rosterType);
    const stored = this.repository.listPublishedMessages(guild.id, rosterType);
    const storedByOrdinal = new Map(stored.map((message) => [message.ordinal, message]));

    for (const [ordinal, embed] of pages.entries()) {
      const existing = storedByOrdinal.get(ordinal);
      const payload = {
        embeds: [embed],
        components: [...components],
        allowedMentions: { parse: [] },
      };

      if (existing?.channelId === channel.id) {
        try {
          await channel.messages.edit(existing.messageId, payload);
          continue;
        } catch (error) {
          if (!isUnknownMessage(error)) {
            throw error;
          }
        }
      }

      if (existing && existing.channelId !== channel.id) {
        this.repository.queuePublishedMessageCleanup(existing);
      }

      let created;
      try {
        created = await channel.send(payload);
      } catch (error) {
        if (existing && existing.channelId !== channel.id) {
          this.repository.removePublishedMessageCleanup(existing);
        }
        throw error;
      }
      this.repository.upsertPublishedMessage({
        guildId: guild.id,
        rosterType,
        ordinal,
        channelId: channel.id,
        messageId: created.id,
      });

      if (existing && existing.channelId !== channel.id) {
        const removed = await this.deleteOldMessage(guild, existing, true);
        if (removed) {
          this.repository.removePublishedMessageCleanup(existing);
        }
      }
    }

    for (const obsolete of stored.filter((message) => message.ordinal >= pages.length)) {
      const removed = await this.deleteOldMessage(guild, obsolete, true);
      if (!removed) {
        this.repository.queuePublishedMessageCleanup(obsolete);
      }
      // Obsolete pages must stop being active immediately. This also prevents
      // persistent controls on a page awaiting cleanup from accepting clicks.
      this.repository.removePublishedMessage(guild.id, rosterType, obsolete.ordinal);
    }
  }

  async deletePublication(
    guild: Guild,
    rosterType: RosterType,
  ): Promise<PublicationDeleteResult> {
    // The repository atomically moved the deleted generation into the cleanup
    // queue before this call. retryQueuedCleanup may also capture rows left by
    // an in-flight publisher, but only while the roster is still disabled. It
    // deliberately never deletes a newer, configured publication generation.
    await this.retryQueuedCleanup(guild, rosterType);

    return {
      pendingCleanupCount: this.repository.listPublishedMessageCleanup(guild.id, rosterType)
        .length,
    };
  }

  async retryQueuedCleanup(guild: Guild, rosterType: RosterType): Promise<void> {
    this.repository.queueDisabledPublishedMessagesForCleanup(guild.id, rosterType);
    const active = new Set(
      this.repository
        .listPublishedMessages(guild.id, rosterType)
        .map((message) => `${message.channelId}:${message.messageId}`),
    );

    for (const queued of this.repository.listPublishedMessageCleanup(guild.id, rosterType)) {
      if (active.has(`${queued.channelId}:${queued.messageId}`)) {
        this.repository.removePublishedMessageCleanup(queued);
        continue;
      }
      const removed = await this.deleteOldMessage(guild, queued, true);
      if (removed) {
        this.repository.removePublishedMessageCleanup(queued);
      }
    }
  }

  private async deleteOldMessage(
    guild: Guild,
    message: PublishedMessage,
    reportFailure: boolean,
  ): Promise<boolean> {
    try {
      const channel = await getRosterChannel(guild, message.channelId);
      await channel.messages.delete(message.messageId);
      return true;
    } catch (error) {
      if (
        error instanceof MissingRosterChannelError ||
        isUnknownMessage(error) ||
        isUnknownChannel(error)
      ) {
        return true;
      }

      if (reportFailure) {
        console.warn(
          `[roster] Could not remove obsolete ${message.rosterType} message ${message.messageId}:`,
          error,
        );
      }
      return false;
    }
  }
}

export async function getRosterChannel(guild: Guild, channelId: string): Promise<RosterChannel> {
  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (error) {
    if (isUnknownChannel(error)) {
      throw new MissingRosterChannelError(channelId);
    }
    throw error;
  }
  if (!channel) {
    throw new MissingRosterChannelError(channelId);
  }
  if (
    (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new RosterChannelError(
      `Configured channel ${channelId} is missing or is not a server text channel.`,
    );
  }
  return channel;
}

function isUnknownMessage(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage
  );
}

function isUnknownChannel(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel
  );
}
