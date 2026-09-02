import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type VoiceState,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import type { RosterScheduler } from "./scheduler.js";
import { ENLISTED_RANKS, OFFICER_RANKS, rankDisplayName } from "./ranks.js";

export class TemporaryVoiceService {
  private readonly pendingOwners = new Set<string>();
  private readonly rankTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly repository: RosterRepository,
    private readonly scheduler: RosterScheduler,
  ) {}

  async handleVoiceStateUpdate(before: VoiceState, after: VoiceState): Promise<void> {
    const guild = after.guild;
    const config = this.repository.getGuildConfig(guild.id);

    if (before.channelId && before.channelId !== after.channelId && before.member) {
      this.cancelRankTimer(guild.id, before.member.id);
      const elapsed = this.repository.endVoiceActivity(guild.id, before.member.id);
      if (elapsed > 0) {
        this.scheduler.schedule(guild.id, "squad");
      }
    }

    if (after.channelId && before.channelId !== after.channelId && after.member) {
      const voiceChannel = this.repository.listTemporaryVoiceChannels(guild.id)
        .find((record) => record.channelId === after.channelId);
      const membership = this.repository.getMembership(guild.id, after.member.id);
      if (voiceChannel?.squadId && membership?.squadId === voiceChannel.squadId && !after.member.user.bot) {
        const isOfficer =
          after.member.id === guild.ownerId ||
          after.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
          Boolean(config.squadLeaderRoleId && after.member.roles.cache.has(config.squadLeaderRoleId));
        this.repository.ensureMemberRankTrack(guild.id, after.member.id, isOfficer ? "officer" : "enlisted");
        this.repository.beginVoiceActivity(guild.id, after.member.id, voiceChannel.squadId);
        this.scheduleNextRankUpdate(guild, after.member.id);
      }
    }

    if (after.channelId && after.channelId === config.temporaryVoiceLobbyChannelId && after.member) {
      await this.createForMember(after);
    }

    if (before.channelId && before.channelId !== after.channelId) {
      await this.deleteIfEmpty(guild, before.channelId);
    }
  }

  stop(): void {
    for (const timer of this.rankTimers.values()) clearTimeout(timer);
    this.rankTimers.clear();
  }

  private scheduleNextRankUpdate(guild: Guild, userId: string): void {
    this.cancelRankTimer(guild.id, userId);
    const state = this.repository.getMemberRankState(guild.id, userId);
    if (state.manualRank) return;
    const member = guild.members.cache.get(userId);
    if (!member) return;
    const canReachGeneral = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild);
    const track = state.rankTrack === "officer"
      ? (canReachGeneral ? OFFICER_RANKS : OFFICER_RANKS.slice(0, 6))
      : ENLISTED_RANKS;
    const seconds = this.repository.getVoiceActivitySeconds(guild.id, userId);
    const nextIndex = track.findIndex((rank) => rank.requiredSeconds > seconds);
    if (nextIndex < 0) return;
    const next = track[nextIndex]!;
    const previous = track[Math.max(0, nextIndex - 1)]!;
    const delay = Math.max(1, next.requiredSeconds - seconds) * 1_000;
    const key = `${guild.id}:${userId}`;
    const timer = setTimeout(() => {
      this.rankTimers.delete(key);
      void (async () => {
        const stillActive = this.repository.listActiveVoiceSessions(guild.id).some((session) => session.userId === userId);
        if (!stillActive) return;
        this.scheduler.schedule(guild.id, "squad");
        await this.announcePromotion(guild, userId, previous.abbreviation, next.abbreviation);
        this.scheduleNextRankUpdate(guild, userId);
      })();
    }, delay);
    timer.unref();
    this.rankTimers.set(key, timer);
  }

  private cancelRankTimer(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    const timer = this.rankTimers.get(key);
    if (timer) clearTimeout(timer);
    this.rankTimers.delete(key);
  }

  private async announcePromotion(guild: Guild, userId: string, previousRank: string, nextRank: string): Promise<void> {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const channelId = this.repository.getGuildConfig(guild.id).rankUpdateChannelId;
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      this.repository.clearRankUpdateChannelIfMatches(guild.id, channelId);
      return;
    }
    await channel.send({
      content: `Congratulations <@${userId}>! You have been promoted from **${rankDisplayName(previousRank)}** to **${rankDisplayName(nextRank)}**.`,
      allowedMentions: { parse: [], users: [userId] },
    }).catch((error: unknown) => console.error(`[rank] Could not announce promotion in guild ${guild.id}:`, error));
  }

  async reconcileGuild(guild: Guild): Promise<void> {
    const activeUsers = new Set<string>();
    for (const record of this.repository.listTemporaryVoiceChannels(guild.id)) {
      const channel = await guild.channels.fetch(record.channelId).catch(() => null);
      if (!channel) {
        this.repository.removeTemporaryVoiceChannel(guild.id, record.channelId);
      } else if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
        await channel.delete("Removing an empty temporary voice channel").catch((error: unknown) => {
          console.error(`[voice] Could not remove empty temporary channel ${channel.id}:`, error);
        });
        this.repository.removeTemporaryVoiceChannel(guild.id, record.channelId);
      } else if (channel.type === ChannelType.GuildVoice && record.squadId) {
        for (const member of channel.members.values()) {
          const membership = this.repository.getMembership(guild.id, member.id);
          if (!member.user.bot && membership?.squadId === record.squadId) {
            activeUsers.add(member.id);
            const config = this.repository.getGuildConfig(guild.id);
            const isOfficer =
              member.id === guild.ownerId ||
              member.permissions.has(PermissionFlagsBits.ManageGuild) ||
              Boolean(config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId));
            this.repository.ensureMemberRankTrack(guild.id, member.id, isOfficer ? "officer" : "enlisted");
            this.repository.beginVoiceActivity(guild.id, member.id, record.squadId);
            this.scheduleNextRankUpdate(guild, member.id);
          }
        }
      }
    }
    for (const session of this.repository.listActiveVoiceSessions(guild.id)) {
      if (!activeUsers.has(session.userId)) {
        this.cancelRankTimer(guild.id, session.userId);
        this.repository.endVoiceActivity(guild.id, session.userId);
      }
    }
  }

  private async createForMember(state: VoiceState): Promise<void> {
    const member = state.member;
    if (!member || member.user.bot) return;
    const key = `${state.guild.id}:${member.id}`;
    if (this.pendingOwners.has(key)) return;
    this.pendingOwners.add(key);

    try {
      const config = this.repository.getGuildConfig(state.guild.id);
      const isManager = member.permissions.has(PermissionFlagsBits.ManageGuild);
      const isSquadLeader = Boolean(
        config.squadLeaderRoleId && member.roles.cache.has(config.squadLeaderRoleId),
      );
      if (!isManager && !isSquadLeader) return;

      const membership = this.repository.getMembership(state.guild.id, member.id);
      const squad = membership ? this.repository.getSquad(state.guild.id, membership.squadId) : null;
      if (isSquadLeader && !isManager && !squad) return;
      const channelName = (squad?.name ?? `${member.displayName}'s Channel`).slice(0, 100);

      const existing = this.repository.getTemporaryVoiceChannelForOwner(state.guild.id, member.id);
      if (existing) {
        const channel = await state.guild.channels.fetch(existing.channelId).catch(() => null);
        if (channel?.type === ChannelType.GuildVoice) {
          await member.voice.setChannel(channel, "Returning to owned temporary voice channel");
          return;
        }
        this.repository.removeTemporaryVoiceChannel(state.guild.id, existing.channelId);
      }

      const lobby = state.channel;
      if (!lobby || lobby.id !== config.temporaryVoiceLobbyChannelId) return;
      const channel = await state.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: lobby.parentId,
        reason: `Temporary voice channel requested by ${member.user.tag}`,
      });
      this.repository.upsertTemporaryVoiceChannel(state.guild.id, channel.id, member.id, squad?.id ?? null);
      try {
        await member.voice.setChannel(channel, "Moving member into temporary voice channel");
      } catch (error) {
        this.repository.removeTemporaryVoiceChannel(state.guild.id, channel.id);
        await channel.delete("Temporary channel owner could not be moved").catch(() => undefined);
        throw error;
      }
    } catch (error) {
      console.error(`[voice] Temporary channel creation failed for ${member.id} in guild ${state.guild.id}:`, error);
    } finally {
      this.pendingOwners.delete(key);
    }
  }

  private async deleteIfEmpty(guild: Guild, channelId: string): Promise<void> {
    const tracked = this.repository.listTemporaryVoiceChannels(guild.id)
      .some((record) => record.channelId === channelId);
    if (!tracked) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      this.repository.removeTemporaryVoiceChannel(guild.id, channelId);
      return;
    }
    if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
      await channel.delete("Temporary voice channel became empty");
      this.repository.removeTemporaryVoiceChannel(guild.id, channelId);
    }
  }
}
