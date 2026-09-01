import { Client, Events, GatewayIntentBits, type Interaction } from "discord.js";

import type { AppConfig } from "./config.js";
import { handleAutocomplete, handleChatInputCommand } from "./commands.js";
import type { RosterRepository } from "./database.js";
import { RosterService } from "./rosters/service.js";
import { RosterScheduler } from "./scheduler.js";
import { handleSquadComponentInteraction } from "./squad-interactions.js";
import { handleRosterSetupInteraction } from "./roster-setup-interactions.js";
import type { RosterTarget } from "./types.js";
import { TemporaryVoiceService } from "./temporary-voice.js";

export class RosterBot {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  private readonly service: RosterService;
  private readonly scheduler: RosterScheduler;
  private readonly temporaryVoice: TemporaryVoiceService;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly activeTasks = new Set<Promise<void>>();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: RosterRepository,
  ) {
    this.service = new RosterService(this.client, repository);
    this.scheduler = new RosterScheduler(config.rosterDebounceMs, (guildId, target, reconcile) =>
      this.executeRefresh(guildId, target, reconcile),
    );
    this.temporaryVoice = new TemporaryVoiceService(repository, this.scheduler);
    this.registerEventHandlers();
  }

  async start(): Promise<void> {
    await this.client.login(this.config.token);
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.client.removeAllListeners();

    const schedulerDrain = this.scheduler.stop();
    await Promise.allSettled([schedulerDrain, ...this.activeTasks]);
    await this.client.destroy();
  }

  private registerEventHandlers(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      this.track(this.handleReady(readyClient));
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      this.track(this.handleInteraction(interaction));
    });

    this.client.on(Events.GuildCreate, (guild) => {
      if (this.client.isReady()) {
        this.track(this.initializeGuild(guild.id));
      }
    });

    this.client.on(Events.GuildAvailable, (guild) => {
      if (this.client.isReady()) {
        this.track(this.initializeGuild(guild.id));
      }
    });

    this.client.on(Events.GuildMemberAdd, (member) => {
      this.scheduler.schedule(member.guild.id, "both");
    });

    this.client.on(Events.GuildMemberRemove, (member) => {
      this.repository.unassignMember(member.guild.id, member.id);
      this.scheduler.schedule(member.guild.id, "both");
    });

    this.client.on(Events.GuildMemberUpdate, (_before, after) => {
      this.scheduler.schedule(after.guild.id, "both");
    });

    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      this.track(this.temporaryVoice.handleVoiceStateUpdate(before, after));
    });

    this.client.on(Events.GuildRoleUpdate, (_before, after) => {
      const tracked = this.repository
        .listTrackedRoles(after.guild.id)
        .some((role) => role.roleId === after.id);
      const isLeaderRole =
        this.repository.getGuildConfig(after.guild.id).squadLeaderRoleId === after.id;

      if (tracked) {
        this.scheduler.schedule(after.guild.id, "role");
      }
      if (isLeaderRole) {
        this.scheduler.schedule(after.guild.id, "squad");
      }
    });

    this.client.on(Events.GuildRoleDelete, (role) => {
      const tracked = this.repository.removeTrackedRole(role.guild.id, role.id);
      const wasLeader = this.repository.clearSquadLeaderRoleIfMatches(role.guild.id, role.id);
      if (tracked && wasLeader) {
        this.scheduler.schedule(role.guild.id, "both");
      } else if (tracked) {
        this.scheduler.schedule(role.guild.id, "role");
      } else if (wasLeader) {
        this.scheduler.schedule(role.guild.id, "squad");
      }
    });

    this.client.on(Events.ChannelDelete, (channel) => {
      if (channel.isDMBased()) {
        return;
      }
      const guildId = channel.guild.id;
      const roleChannel = this.repository.clearRoleRosterChannelIfMatches(guildId, channel.id);
      const squadChannel = this.repository.clearSquadRosterChannelIfMatches(guildId, channel.id);
      const voiceLobby = this.repository.clearTemporaryVoiceLobbyChannelIfMatches(guildId, channel.id);
      this.repository.removeTemporaryVoiceChannel(guildId, channel.id);
      if (roleChannel || squadChannel) {
        this.repository.removePublishedMessagesForChannel(guildId, channel.id);
        console.warn(`[roster] Cleared deleted roster channel ${channel.id} in guild ${guildId}.`);
      }
      if (voiceLobby) console.warn(`[voice] Cleared deleted voice lobby ${channel.id} in guild ${guildId}.`);
    });

    this.client.on(Events.UserUpdate, (_before, after) => {
      for (const guild of this.client.guilds.cache.values()) {
        if (guild.members.cache.has(after.id)) {
          this.scheduler.schedule(guild.id, "both");
        }
      }
    });

    this.client.on(Events.Error, (error) => {
      console.error("[discord] Client error:", error);
    });
    this.client.on(Events.Warn, (warning) => {
      console.warn("[discord]", warning);
    });
    this.client.on(Events.ShardError, (error, shardId) => {
      console.error(`[discord] Shard ${shardId} error:`, error);
    });
  }

  private async handleReady(readyClient: Client<true>): Promise<void> {
    console.info(`[bot] Logged in as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} guild(s).`);

    for (const guild of readyClient.guilds.cache.values()) {
      this.repository.ensureGuild(guild.id);
      try {
        await this.temporaryVoice.reconcileGuild(guild);
        await this.scheduler.runNow(guild.id, "both", true);
      } catch (error) {
        console.error(`[roster] Initial refresh failed for ${guild.id}:`, error);
      }
    }

    if (this.stopping) {
      return;
    }
    this.reconcileTimer = setInterval(() => {
      for (const guild of this.client.guilds.cache.values()) {
        void this.scheduler.runNow(guild.id, "both", true).catch((error: unknown) => {
          console.error(`[roster] Reconciliation failed for ${guild.id}:`, error);
        });
      }
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) {
        const handled = await handleRosterSetupInteraction(interaction, {
          repository: this.repository,
          scheduler: this.scheduler,
        });
        if (handled) return;
      }
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const handled = await handleSquadComponentInteraction(interaction, {
          repository: this.repository,
          scheduler: this.scheduler,
        });
        if (handled) {
          return;
        }
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, this.repository);
      } else if (interaction.isChatInputCommand()) {
        await handleChatInputCommand(interaction, {
          repository: this.repository,
          scheduler: this.scheduler,
        });
      }
    } catch (error) {
      console.error("[interaction] Unhandled interaction error:", error);
    }
  }

  private async initializeGuild(guildId: string): Promise<void> {
    this.repository.ensureGuild(guildId);
    try {
      const guild = await this.client.guilds.fetch(guildId);
      await this.temporaryVoice.reconcileGuild(guild);
      await this.scheduler.runNow(guildId, "both", true);
    } catch (error) {
      console.error(`[roster] Guild initialization failed for ${guildId}:`, error);
    }
  }

  private track(task: Promise<void>): void {
    this.activeTasks.add(task);
    void task
      .catch((error: unknown) => {
        console.error("[bot] Background task failed:", error);
      })
      .finally(() => {
        this.activeTasks.delete(task);
      });
  }

  private async executeRefresh(
    guildId: string,
    target: RosterTarget,
    reconcileMembers: boolean,
  ): Promise<void> {
    if (target === "role") {
      await this.service.syncRoleRoster(guildId, reconcileMembers);
    } else if (target === "squad") {
      await this.service.syncSquadRoster(guildId, reconcileMembers);
    } else {
      await this.service.syncBoth(guildId, reconcileMembers);
    }
  }
}
