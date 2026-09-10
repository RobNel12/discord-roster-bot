import {
  ChannelType,
  OverwriteType,
  type VoiceChannel,
  PermissionFlagsBits,
  type Guild,
  type VoiceState,
} from "discord.js";

import type { RosterRepository } from "./database.js";
import type { RosterScheduler } from "./scheduler.js";
import { ENLISTED_RANKS, OFFICER_RANKS } from "./ranks.js";

export class TemporaryVoiceService {
  private readonly pendingSquads = new Map<string, Promise<void>>();
  private readonly accessQueues = new Map<string, Promise<void>>();
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

  refreshRankTimers(guild: Guild): void {
    for (const session of this.repository.listActiveVoiceSessions(guild.id)) this.scheduleNextRankUpdate(guild, session.userId);
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
    const delay = Math.max(1, next.requiredSeconds - seconds) * 1_000;
    const key = `${guild.id}:${userId}`;
    const timer = setTimeout(() => {
      this.rankTimers.delete(key);
      const stillActive = this.repository.listActiveVoiceSessions(guild.id).some((session) => session.userId === userId);
      if (!stillActive) return;
      this.scheduler.schedule(guild.id, "squad");
      this.scheduleNextRankUpdate(guild, userId);
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

  async syncGuildPermissions(guild: Guild): Promise<void> {
    for (const record of this.repository.listTemporaryVoiceChannels(guild.id)) {
      if (record.squadId === null) continue;
      try {
        const channel = await guild.channels.fetch(record.channelId);
        if (channel?.type === ChannelType.GuildVoice) {
          const squad = this.repository.getSquad(guild.id, record.squadId);
          if (squad && channel.name !== squad.name) await channel.setName(squad.name, "Updating squad voice channel name");
          await this.syncChannelPermissions(channel, record.squadId);
        }
      } catch (error) { console.error(`[voice] Could not sync squad access for ${record.channelId}:`, error); }
    }
  }

  private async trySyncChannelPermissions(channel: VoiceChannel, squadId: number): Promise<void> {
    try {
      await this.syncChannelPermissions(channel, squadId);
    } catch (error) {
      const missingPermissions = (error as { code?: number } | null)?.code === 50013;
      console.warn(
        `[voice] Could not update squad access for ${channel.id}. ${missingPermissions
          ? "Grant the bot Manage Permissions in the voice category, plus View Channel and Connect."
          : "Permission synchronization will retry on the next roster refresh."} Continuing with existing channel permissions.`,
        error,
      );
    }
  }

  private async syncChannelPermissions(channel: VoiceChannel, squadId: number): Promise<void> {
    const key = channel.id;
    const previous = this.accessQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const guildId = channel.guild.id;
      const members = new Set(this.repository.listMemberships(guildId).filter(m => m.squadId === squadId).map(m => m.userId));
      for (const grant of this.repository.listVoiceAccessGrants(guildId, channel.id)) {
        if (members.has(grant.userId)) continue;
        if (channel.permissionOverwrites.cache.has(grant.userId)) {
          await channel.permissionOverwrites.edit(grant.userId, {
            ViewChannel: grant.view === null ? null : Boolean(grant.view),
            Connect: grant.connect === null ? null : Boolean(grant.connect),
          }, { type: OverwriteType.Member, reason: "Restoring access after squad departure" });
        }
        this.repository.removeVoiceAccessGrant(guildId, channel.id, grant.userId);
      }
      for (const userId of members) {
        const overwrite = channel.permissionOverwrites.cache.get(userId);
        const original = (flag: bigint) => overwrite?.allow.has(flag) ? 1 : overwrite?.deny.has(flag) ? 0 : null;
        this.repository.saveVoiceAccessGrant(guildId, channel.id, userId, original(PermissionFlagsBits.ViewChannel), original(PermissionFlagsBits.Connect));
        if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel) && overwrite.allow.has(PermissionFlagsBits.Connect)) continue;
        await channel.permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true }, {
          type: OverwriteType.Member, reason: "Allowing assigned squad members to see and join squad voice",
        });
      }
    });
    this.accessQueues.set(key, next);
    try { await next; } finally { if (this.accessQueues.get(key) === next) this.accessQueues.delete(key); }
  }

  async reconcileGuild(guild: Guild): Promise<void> {
    await this.syncGuildPermissions(guild);
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
    const config = this.repository.getGuildConfig(state.guild.id);
    const lobby = state.channel;
    if (!lobby || lobby.id !== config.temporaryVoiceLobbyChannelId) return;
    const membership = this.repository.getMembership(state.guild.id, member.id);
    const squad = membership ? this.repository.getSquad(state.guild.id, membership.squadId) : null;
    if (!squad) return;
    const key = `${state.guild.id}:${squad.id}`;
    const pending = this.pendingSquads.get(key);
    if (pending) {
      await pending;
      await this.moveToExistingSquadChannel(state.guild, member, squad.id);
      return;
    }

    const creation = (async () => {
      if (await this.moveToExistingSquadChannel(state.guild, member, squad.id)) return;
      const channel = await state.guild.channels.create({
        name: squad.name.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: lobby.parentId,
        reason: `Temporary voice channel requested by ${member.user.tag}`,
      });
      this.repository.upsertTemporaryVoiceChannel(state.guild.id, channel.id, member.id, squad.id);
      try {
        await this.trySyncChannelPermissions(channel, squad.id);
        await member.voice.setChannel(channel, "Moving member into temporary voice channel");
      } catch (error) {
        this.repository.removeTemporaryVoiceChannel(state.guild.id, channel.id);
        await channel.delete("Temporary channel owner could not be moved").catch(() => undefined);
        throw error;
      }
    })();
    this.pendingSquads.set(key, creation);
    try {
      await creation;
    } catch (error) {
      console.error(`[voice] Temporary channel creation failed for ${member.id} in guild ${state.guild.id}:`, error);
    } finally {
      if (this.pendingSquads.get(key) === creation) this.pendingSquads.delete(key);
    }
  }

  private async moveToExistingSquadChannel(guild: Guild, member: NonNullable<VoiceState["member"]>, squadId: number): Promise<boolean> {
    const existing = this.repository.getTemporaryVoiceChannelForSquad(guild.id, squadId);
    if (!existing) return false;
    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
      await this.trySyncChannelPermissions(channel, squadId);
      await member.voice.setChannel(channel, "Joining existing temporary squad voice channel");
      return true;
    }
    this.repository.removeTemporaryVoiceChannel(guild.id, existing.channelId);
    return false;
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
