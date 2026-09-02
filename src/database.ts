import { DatabaseSync } from "node:sqlite";

import { validateSquadName } from "./squad-names.js";
import type {
  GuildConfig,
  PublishedMessage,
  RosterType,
  Squad,
  SquadMembership,
  TrackedRole,
  TemporaryVoiceChannel,
  RoleRosterPage,
  SquadLoadoutRole,
  SquadLoadoutAssignment,
} from "./types.js";

interface GuildConfigRow {
  guild_id: string;
  role_roster_channel_id: string | null;
  squad_roster_channel_id: string | null;
  squad_call_channel_id: string | null;
  rank_update_channel_id: string | null;
  squad_leader_role_id: string | null;
  temporary_voice_lobby_channel_id: string | null;
  include_bots: number;
}

interface TrackedRoleRow {
  guild_id: string;
  role_id: string;
  sort_order: number;
  page_id: number | null;
  high_priority: number;
}

interface SquadRow {
  id: number;
  guild_id: string;
  name: string;
  normalized_name: string;
  sort_order: number;
}

interface MembershipRow {
  guild_id: string;
  user_id: string;
  squad_id: number;
}

interface PublishedMessageRow {
  guild_id: string;
  roster_type: RosterType;
  ordinal: number;
  channel_id: string;
  message_id: string;
}

export class DuplicateSquadNameError extends Error {
  constructor(name: string) {
    super(`A squad named “${name}” already exists.`);
    this.name = "DuplicateSquadNameError";
  }
}

export class RosterRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL;");
    }
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        role_roster_channel_id TEXT,
        squad_roster_channel_id TEXT,
        squad_call_channel_id TEXT,
        rank_update_channel_id TEXT,
        squad_leader_role_id TEXT,
        temporary_voice_lobby_channel_id TEXT,
        include_bots INTEGER NOT NULL DEFAULT 0 CHECK (include_bots IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tracked_roles (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        page_id INTEGER,
        high_priority INTEGER NOT NULL DEFAULT 0 CHECK (high_priority IN (0, 1)),
        PRIMARY KEY (guild_id, role_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS role_roster_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE (guild_id, name),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS squads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (guild_id, normalized_name),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS squad_memberships (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        squad_id INTEGER NOT NULL,
        assigned_by_user_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS published_messages (
        guild_id TEXT NOT NULL,
        roster_type TEXT NOT NULL CHECK (roster_type IN ('role', 'squad')),
        ordinal INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, roster_type, ordinal),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS publication_cleanup (
        guild_id TEXT NOT NULL,
        roster_type TEXT NOT NULL CHECK (roster_type IN ('role', 'squad')),
        ordinal INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, roster_type, channel_id, message_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS temporary_voice_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        squad_id INTEGER,
        PRIMARY KEY (guild_id, channel_id),
        UNIQUE (guild_id, owner_user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS member_voice_activity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        activity_seconds INTEGER NOT NULL DEFAULT 0 CHECK (activity_seconds >= 0),
        rank_track TEXT NOT NULL DEFAULT 'enlisted' CHECK (rank_track IN ('enlisted', 'officer')),
        manual_rank TEXT,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS active_voice_sessions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        squad_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS squad_loadout_roles (
        squad_id INTEGER NOT NULL,
        normalized_name TEXT NOT NULL,
        name TEXT NOT NULL,
        role_count INTEGER NOT NULL CHECK (role_count >= 1),
        instructions TEXT,
        discord_role_id TEXT,
        first_preference_role_id TEXT,
        second_preference_role_id TEXT,
        PRIMARY KEY (squad_id, normalized_name),
        FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS squad_loadout_assignments (
        guild_id TEXT NOT NULL,
        squad_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS loadout_role_activity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        normalized_role_name TEXT NOT NULL,
        role_name TEXT NOT NULL,
        activity_seconds INTEGER NOT NULL DEFAULT 0 CHECK (activity_seconds >= 0),
        PRIMARY KEY (guild_id, user_id, normalized_role_name),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS active_loadout_role_sessions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        squad_id INTEGER NOT NULL,
        normalized_role_name TEXT NOT NULL,
        role_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tracked_roles_order
        ON tracked_roles(guild_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_squads_order
        ON squads(guild_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_memberships_squad
        ON squad_memberships(guild_id, squad_id);
      CREATE INDEX IF NOT EXISTS idx_published_messages_message
        ON published_messages(guild_id, message_id);
    `);
    const configColumns = this.database
      .prepare("PRAGMA table_info(guild_config)")
      .all() as unknown as Array<{ name: string }>;
    if (!configColumns.some((column) => column.name === "temporary_voice_lobby_channel_id")) {
      this.database.exec("ALTER TABLE guild_config ADD COLUMN temporary_voice_lobby_channel_id TEXT;");
    }
    if (!configColumns.some((column) => column.name === "squad_call_channel_id")) {
      this.database.exec("ALTER TABLE guild_config ADD COLUMN squad_call_channel_id TEXT;");
    }
    if (!configColumns.some((column) => column.name === "rank_update_channel_id")) {
      this.database.exec("ALTER TABLE guild_config ADD COLUMN rank_update_channel_id TEXT;");
    }
    const voiceColumns = this.database.prepare("PRAGMA table_info(temporary_voice_channels)").all() as unknown as Array<{ name: string }>;
    if (!voiceColumns.some((column) => column.name === "squad_id")) {
      this.database.exec("ALTER TABLE temporary_voice_channels ADD COLUMN squad_id INTEGER;");
    }
    const activityColumns = this.database.prepare("PRAGMA table_info(member_voice_activity)").all() as unknown as Array<{ name: string }>;
    if (!activityColumns.some((column) => column.name === "rank_track")) {
      this.database.exec("ALTER TABLE member_voice_activity ADD COLUMN rank_track TEXT NOT NULL DEFAULT 'enlisted';");
    }
    if (!activityColumns.some((column) => column.name === "manual_rank")) {
      this.database.exec("ALTER TABLE member_voice_activity ADD COLUMN manual_rank TEXT;");
    }
    const trackedColumns = this.database.prepare("PRAGMA table_info(tracked_roles)").all() as unknown as Array<{ name: string }>;
    if (!trackedColumns.some((column) => column.name === "page_id")) {
      this.database.exec("ALTER TABLE tracked_roles ADD COLUMN page_id INTEGER;");
    }
    if (!trackedColumns.some((column) => column.name === "high_priority")) {
      this.database.exec("ALTER TABLE tracked_roles ADD COLUMN high_priority INTEGER NOT NULL DEFAULT 0;");
    }
    const loadoutTableSql = (this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'squad_loadout_roles'").get() as unknown as { sql: string } | undefined)?.sql ?? "";
    if (loadoutTableSql.includes("BETWEEN 1 AND 6")) {
      this.database.exec(`
        ALTER TABLE squad_loadout_roles RENAME TO squad_loadout_roles_limited;
        CREATE TABLE squad_loadout_roles (
          squad_id INTEGER NOT NULL,
          normalized_name TEXT NOT NULL,
          name TEXT NOT NULL,
          role_count INTEGER NOT NULL CHECK (role_count >= 1),
          instructions TEXT,
          discord_role_id TEXT,
          first_preference_role_id TEXT,
          second_preference_role_id TEXT,
          PRIMARY KEY (squad_id, normalized_name),
          FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO squad_loadout_roles (squad_id, normalized_name, name, role_count, instructions)
          SELECT squad_id, normalized_name, name, role_count, instructions FROM squad_loadout_roles_limited;
        DROP TABLE squad_loadout_roles_limited;
      `);
    }
    const loadoutColumns = this.database.prepare("PRAGMA table_info(squad_loadout_roles)").all() as unknown as Array<{ name: string }>;
    if (!loadoutColumns.some((column) => column.name === "discord_role_id")) {
      this.database.exec("ALTER TABLE squad_loadout_roles ADD COLUMN discord_role_id TEXT;");
    }
    if (!loadoutColumns.some((column) => column.name === "first_preference_role_id")) {
      this.database.exec("ALTER TABLE squad_loadout_roles ADD COLUMN first_preference_role_id TEXT;");
    }
    if (!loadoutColumns.some((column) => column.name === "second_preference_role_id")) {
      this.database.exec("ALTER TABLE squad_loadout_roles ADD COLUMN second_preference_role_id TEXT;");
    }
  }

  ensureGuild(guildId: string): void {
    this.database
      .prepare("INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)")
      .run(guildId);
  }

  getGuildConfig(guildId: string): GuildConfig {
    this.ensureGuild(guildId);
    const row = this.database
      .prepare(`
        SELECT guild_id, role_roster_channel_id, squad_roster_channel_id, squad_call_channel_id, rank_update_channel_id,
               squad_leader_role_id, temporary_voice_lobby_channel_id, include_bots
        FROM guild_config
        WHERE guild_id = ?
      `)
      .get(guildId) as unknown as GuildConfigRow;

    return {
      guildId: row.guild_id,
      roleRosterChannelId: row.role_roster_channel_id,
      squadRosterChannelId: row.squad_roster_channel_id,
      squadCallChannelId: row.squad_call_channel_id,
      rankUpdateChannelId: row.rank_update_channel_id,
      squadLeaderRoleId: row.squad_leader_role_id,
      temporaryVoiceLobbyChannelId: row.temporary_voice_lobby_channel_id,
      includeBots: row.include_bots === 1,
    };
  }

  listGuildIds(): string[] {
    const rows = this.database
      .prepare("SELECT guild_id FROM guild_config ORDER BY guild_id")
      .all() as unknown as Array<{ guild_id: string }>;
    return rows.map((row) => row.guild_id);
  }

  setRoleRosterChannel(guildId: string, channelId: string | null): void {
    this.ensureGuild(guildId);
    this.database
      .prepare(`
        UPDATE guild_config
        SET role_roster_channel_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
      `)
      .run(channelId, guildId);
  }

  setSquadRosterChannel(guildId: string, channelId: string | null): void {
    this.ensureGuild(guildId);
    this.database
      .prepare(`
        UPDATE guild_config
        SET squad_roster_channel_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
      `)
      .run(channelId, guildId);
  }

  setSquadCallChannel(guildId: string, channelId: string | null): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      UPDATE guild_config SET squad_call_channel_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(channelId, guildId);
  }

  setRankUpdateChannel(guildId: string, channelId: string | null): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      UPDATE guild_config SET rank_update_channel_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(channelId, guildId);
  }

  clearRankUpdateChannelIfMatches(guildId: string, channelId: string): boolean {
    const result = this.database.prepare(`
      UPDATE guild_config SET rank_update_channel_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND rank_update_channel_id = ?
    `).run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  clearSquadCallChannelIfMatches(guildId: string, channelId: string): boolean {
    const result = this.database.prepare(`
      UPDATE guild_config SET squad_call_channel_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND squad_call_channel_id = ?
    `).run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  setSquadLeaderRole(guildId: string, roleId: string | null): void {
    this.ensureGuild(guildId);
    this.database
      .prepare(`
        UPDATE guild_config
        SET squad_leader_role_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
      `)
      .run(roleId, guildId);
  }

  setTemporaryVoiceLobbyChannel(guildId: string, channelId: string | null): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      UPDATE guild_config
      SET temporary_voice_lobby_channel_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(channelId, guildId);
  }

  clearTemporaryVoiceLobbyChannelIfMatches(guildId: string, channelId: string): boolean {
    const result = this.database.prepare(`
      UPDATE guild_config
      SET temporary_voice_lobby_channel_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND temporary_voice_lobby_channel_id = ?
    `).run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  upsertTemporaryVoiceChannel(guildId: string, channelId: string, ownerUserId: string, squadId: number | null = null): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      INSERT INTO temporary_voice_channels (guild_id, channel_id, owner_user_id, squad_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, owner_user_id) DO UPDATE SET
        channel_id = excluded.channel_id, squad_id = excluded.squad_id
    `).run(guildId, channelId, ownerUserId, squadId);
  }

  getTemporaryVoiceChannelForOwner(guildId: string, ownerUserId: string): TemporaryVoiceChannel | null {
    const row = this.database.prepare(`
      SELECT guild_id, channel_id, owner_user_id, squad_id
      FROM temporary_voice_channels WHERE guild_id = ? AND owner_user_id = ?
    `).get(guildId, ownerUserId) as unknown as { guild_id: string; channel_id: string; owner_user_id: string; squad_id: number | null } | undefined;
    return row ? { guildId: row.guild_id, channelId: row.channel_id, ownerUserId: row.owner_user_id, squadId: row.squad_id } : null;
  }

  listTemporaryVoiceChannels(guildId: string): TemporaryVoiceChannel[] {
    const rows = this.database.prepare(`
      SELECT guild_id, channel_id, owner_user_id, squad_id
      FROM temporary_voice_channels WHERE guild_id = ?
    `).all(guildId) as unknown as Array<{ guild_id: string; channel_id: string; owner_user_id: string; squad_id: number | null }>;
    return rows.map((row) => ({ guildId: row.guild_id, channelId: row.channel_id, ownerUserId: row.owner_user_id, squadId: row.squad_id }));
  }

  removeTemporaryVoiceChannel(guildId: string, channelId: string): boolean {
    const result = this.database.prepare(
      "DELETE FROM temporary_voice_channels WHERE guild_id = ? AND channel_id = ?",
    ).run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  beginVoiceActivity(guildId: string, userId: string, squadId: number, startedAt = Math.floor(Date.now() / 1000)): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      INSERT OR IGNORE INTO active_voice_sessions (guild_id, user_id, squad_id, started_at)
      VALUES (?, ?, ?, ?)
    `).run(guildId, userId, squadId, startedAt);
    const assignment = this.database.prepare(`
      SELECT role_name FROM squad_loadout_assignments
      WHERE guild_id = ? AND user_id = ? AND squad_id = ?
    `).get(guildId, userId, squadId) as unknown as { role_name: string } | undefined;
    if (assignment) this.beginLoadoutRoleActivity(guildId, userId, squadId, assignment.role_name, startedAt);
  }

  listActiveVoiceSessions(guildId: string): Array<{ userId: string; squadId: number }> {
    const rows = this.database.prepare(`
      SELECT user_id, squad_id FROM active_voice_sessions WHERE guild_id = ?
    `).all(guildId) as unknown as Array<{ user_id: string; squad_id: number }>;
    return rows.map((row) => ({ userId: row.user_id, squadId: row.squad_id }));
  }

  endVoiceActivity(guildId: string, userId: string, endedAt = Math.floor(Date.now() / 1000)): number {
    const session = this.database.prepare(`
      SELECT started_at FROM active_voice_sessions WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { started_at: number } | undefined;
    if (!session) return 0;
    const roleSession = this.database.prepare(`
      SELECT normalized_role_name, role_name, started_at
      FROM active_loadout_role_sessions WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { normalized_role_name: string; role_name: string; started_at: number } | undefined;
    const elapsed = Math.max(0, endedAt - session.started_at);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`
        INSERT INTO member_voice_activity (guild_id, user_id, activity_seconds)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          activity_seconds = activity_seconds + excluded.activity_seconds
      `).run(guildId, userId, elapsed);
      this.database.prepare(
        "DELETE FROM active_voice_sessions WHERE guild_id = ? AND user_id = ?",
      ).run(guildId, userId);
      if (roleSession) {
        const roleElapsed = Math.max(0, endedAt - roleSession.started_at);
        this.database.prepare(`
          INSERT INTO loadout_role_activity (guild_id, user_id, normalized_role_name, role_name, activity_seconds)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(guild_id, user_id, normalized_role_name) DO UPDATE SET
            role_name = excluded.role_name,
            activity_seconds = activity_seconds + excluded.activity_seconds
        `).run(guildId, userId, roleSession.normalized_role_name, roleSession.role_name, roleElapsed);
        this.database.prepare("DELETE FROM active_loadout_role_sessions WHERE guild_id = ? AND user_id = ?")
          .run(guildId, userId);
      }
      this.database.exec("COMMIT;");
      return elapsed;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getVoiceActivitySeconds(guildId: string, userId: string): number {
    const row = this.database.prepare(`
      SELECT activity_seconds FROM member_voice_activity WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { activity_seconds: number } | undefined;
    const active = this.database.prepare(`
      SELECT started_at FROM active_voice_sessions WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { started_at: number } | undefined;
    return (row?.activity_seconds ?? 0) + (active ? Math.max(0, Math.floor(Date.now() / 1000) - active.started_at) : 0);
  }

  beginLoadoutRoleActivity(guildId: string, userId: string, squadId: number, roleName: string, startedAt = Math.floor(Date.now() / 1000)): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO active_loadout_role_sessions
        (guild_id, user_id, squad_id, normalized_role_name, role_name, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, userId, squadId, roleName.toLocaleLowerCase("en-US"), roleName, startedAt);
  }

  endLoadoutRoleActivity(guildId: string, userId: string, endedAt = Math.floor(Date.now() / 1000)): number {
    const session = this.database.prepare(`
      SELECT normalized_role_name, role_name, started_at FROM active_loadout_role_sessions
      WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { normalized_role_name: string; role_name: string; started_at: number } | undefined;
    if (!session) return 0;
    const elapsed = Math.max(0, endedAt - session.started_at);
    this.database.prepare(`
      INSERT INTO loadout_role_activity (guild_id, user_id, normalized_role_name, role_name, activity_seconds)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, normalized_role_name) DO UPDATE SET
        role_name = excluded.role_name, activity_seconds = activity_seconds + excluded.activity_seconds
    `).run(guildId, userId, session.normalized_role_name, session.role_name, elapsed);
    this.database.prepare("DELETE FROM active_loadout_role_sessions WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
    return elapsed;
  }

  getLoadoutRoleActivitySeconds(guildId: string, userId: string, roleName: string, now = Math.floor(Date.now() / 1000)): number {
    const normalized = roleName.toLocaleLowerCase("en-US");
    const stored = this.database.prepare(`
      SELECT activity_seconds FROM loadout_role_activity
      WHERE guild_id = ? AND user_id = ? AND normalized_role_name = ?
    `).get(guildId, userId, normalized) as unknown as { activity_seconds: number } | undefined;
    const active = this.database.prepare(`
      SELECT started_at FROM active_loadout_role_sessions
      WHERE guild_id = ? AND user_id = ? AND normalized_role_name = ?
    `).get(guildId, userId, normalized) as unknown as { started_at: number } | undefined;
    return (stored?.activity_seconds ?? 0) + (active ? Math.max(0, now - active.started_at) : 0);
  }

  getMemberRankState(guildId: string, userId: string): { activitySeconds: number; rankTrack: "enlisted" | "officer"; manualRank: string | null } {
    const row = this.database.prepare(`
      SELECT activity_seconds, rank_track, manual_rank
      FROM member_voice_activity WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as unknown as { activity_seconds: number; rank_track: "enlisted" | "officer"; manual_rank: string | null } | undefined;
    return row
      ? { activitySeconds: row.activity_seconds, rankTrack: row.rank_track, manualRank: row.manual_rank }
      : { activitySeconds: 0, rankTrack: "enlisted", manualRank: null };
  }

  ensureMemberRankTrack(guildId: string, userId: string, rankTrack: "enlisted" | "officer"): number {
    this.ensureGuild(guildId);
    const current = this.getMemberRankState(guildId, userId);
    if (current.rankTrack === rankTrack) return current.activitySeconds;
    this.database.prepare(`
      INSERT INTO member_voice_activity (guild_id, user_id, activity_seconds, rank_track, manual_rank)
      VALUES (?, ?, 0, ?, NULL)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        activity_seconds = 0, rank_track = excluded.rank_track, manual_rank = NULL
    `).run(guildId, userId, rankTrack);
    this.database.prepare(`
      UPDATE active_voice_sessions SET started_at = ? WHERE guild_id = ? AND user_id = ?
    `).run(Math.floor(Date.now() / 1000), guildId, userId);
    return 0;
  }

  setManualRank(guildId: string, userId: string, rank: string | null): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      INSERT INTO member_voice_activity (guild_id, user_id, manual_rank)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET manual_rank = excluded.manual_rank
    `).run(guildId, userId, rank);
  }

  setVoiceActivitySeconds(guildId: string, userId: string, seconds: number): void {
    this.ensureGuild(guildId);
    this.database.prepare(`
      INSERT INTO member_voice_activity (guild_id, user_id, activity_seconds)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        activity_seconds = excluded.activity_seconds, manual_rank = NULL
    `).run(guildId, userId, Math.max(0, Math.floor(seconds)));
    this.database.prepare(`
      UPDATE active_voice_sessions SET started_at = ? WHERE guild_id = ? AND user_id = ?
    `).run(Math.floor(Date.now() / 1000), guildId, userId);
  }

  clearRoleRosterChannelIfMatches(guildId: string, channelId: string): boolean {
    const result = this.database
      .prepare(`
        UPDATE guild_config
        SET role_roster_channel_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND role_roster_channel_id = ?
      `)
      .run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  clearSquadRosterChannelIfMatches(guildId: string, channelId: string): boolean {
    const result = this.database
      .prepare(`
        UPDATE guild_config
        SET squad_roster_channel_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND squad_roster_channel_id = ?
      `)
      .run(guildId, channelId);
    return Number(result.changes) > 0;
  }

  moveRoleRosterChannelIfMatches(
    guildId: string,
    currentChannelId: string | null,
    nextChannelId: string,
  ): boolean {
    const result = this.database
      .prepare(`
        UPDATE guild_config
        SET role_roster_channel_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND role_roster_channel_id IS ?
      `)
      .run(nextChannelId, guildId, currentChannelId);
    return Number(result.changes) > 0;
  }

  moveSquadRosterChannelIfMatches(
    guildId: string,
    currentChannelId: string | null,
    nextChannelId: string,
  ): boolean {
    const result = this.database
      .prepare(`
        UPDATE guild_config
        SET squad_roster_channel_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND squad_roster_channel_id IS ?
      `)
      .run(nextChannelId, guildId, currentChannelId);
    return Number(result.changes) > 0;
  }

  deactivatePublication(
    guildId: string,
    rosterType: RosterType,
    expectedChannelId: string | null,
  ): number | null {
    this.ensureGuild(guildId);
    const channelColumn =
      rosterType === "role" ? "role_roster_channel_id" : "squad_roster_channel_id";
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const deactivated = this.database
        .prepare(`
          UPDATE guild_config
          SET ${channelColumn} = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE guild_id = ? AND ${channelColumn} IS ?
        `)
        .run(guildId, expectedChannelId);
      if (Number(deactivated.changes) === 0) {
        this.database.exec("ROLLBACK;");
        return null;
      }

      const pageCount = Number(
        (
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM published_messages
              WHERE guild_id = ? AND roster_type = ?
            `)
            .get(guildId, rosterType) as unknown as { count: number }
        ).count,
      );
      this.queueActivePublicationRows(guildId, rosterType);
      this.database.exec("COMMIT;");
      return pageCount;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  clearSquadLeaderRoleIfMatches(guildId: string, roleId: string): boolean {
    const result = this.database
      .prepare(`
        UPDATE guild_config
        SET squad_leader_role_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND squad_leader_role_id = ?
      `)
      .run(guildId, roleId);
    return Number(result.changes) > 0;
  }

  addTrackedRole(guildId: string, roleId: string): boolean {
    this.ensureGuild(guildId);
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO tracked_roles (guild_id, role_id, sort_order, page_id)
        SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1,
               (SELECT id FROM role_roster_pages WHERE guild_id = ? ORDER BY sort_order, id LIMIT 1)
        FROM tracked_roles
        WHERE guild_id = ?
      `)
      .run(guildId, roleId, guildId, guildId);
    return Number(result.changes) > 0;
  }

  removeTrackedRole(guildId: string, roleId: string): boolean {
    const result = this.database
      .prepare("DELETE FROM tracked_roles WHERE guild_id = ? AND role_id = ?")
      .run(guildId, roleId);
    return Number(result.changes) > 0;
  }

  replaceTrackedRoles(guildId: string, roleIds: readonly string[]): void {
    this.ensureGuild(guildId);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare("DELETE FROM tracked_roles WHERE guild_id = ?")
        .run(guildId);
      const insert = this.database.prepare(`
        INSERT INTO tracked_roles (guild_id, role_id, sort_order)
        VALUES (?, ?, ?)
      `);
      roleIds.forEach((roleId, index) => insert.run(guildId, roleId, index));
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  reorderTrackedRoles(guildId: string, roleIds: readonly string[]): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const update = this.database.prepare("UPDATE tracked_roles SET sort_order = ? WHERE guild_id = ? AND role_id = ?");
      roleIds.forEach((roleId, index) => update.run(index, guildId, roleId));
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  clearTrackedRoles(guildId: string): number {
    const result = this.database
      .prepare("DELETE FROM tracked_roles WHERE guild_id = ?")
      .run(guildId);
    return Number(result.changes);
  }

  listTrackedRoles(guildId: string): TrackedRole[] {
    const rows = this.database
      .prepare(`
        SELECT guild_id, role_id, sort_order, page_id, high_priority
        FROM tracked_roles
        WHERE guild_id = ?
        ORDER BY sort_order, role_id
      `)
      .all(guildId) as unknown as TrackedRoleRow[];

    return rows.map((row) => ({
      guildId: row.guild_id,
      roleId: row.role_id,
      sortOrder: row.sort_order,
      pageId: row.page_id,
      highPriority: row.high_priority === 1,
    }));
  }

  listRoleRosterPages(guildId: string): RoleRosterPage[] {
    const rows = this.database.prepare(`
      SELECT id, guild_id, name, sort_order FROM role_roster_pages
      WHERE guild_id = ? ORDER BY sort_order, id
    `).all(guildId) as unknown as Array<{ id: number; guild_id: string; name: string; sort_order: number }>;
    return rows.map((row) => ({ id: row.id, guildId: row.guild_id, name: row.name, sortOrder: row.sort_order }));
  }

  replaceRoleRosterSetup(
    guildId: string,
    channelId: string,
    pages: ReadonlyArray<{ name: string; roles: ReadonlyArray<{ roleId: string; highPriority: boolean }> }>,
  ): void {
    this.ensureGuild(guildId);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`UPDATE guild_config SET role_roster_channel_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`).run(channelId, guildId);
      this.database.prepare("DELETE FROM tracked_roles WHERE guild_id = ?").run(guildId);
      this.database.prepare("DELETE FROM role_roster_pages WHERE guild_id = ?").run(guildId);
      const insertPage = this.database.prepare(`INSERT INTO role_roster_pages (guild_id, name, sort_order) VALUES (?, ?, ?)`);
      const insertRole = this.database.prepare(`INSERT INTO tracked_roles (guild_id, role_id, sort_order, page_id, high_priority) VALUES (?, ?, ?, ?, ?)`);
      let roleOrder = 0;
      pages.forEach((page, pageIndex) => {
        const result = insertPage.run(guildId, page.name, pageIndex);
        const pageId = Number(result.lastInsertRowid);
        page.roles.forEach((role) => insertRole.run(guildId, role.roleId, roleOrder++, pageId, role.highPriority ? 1 : 0));
      });
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  createRoleRosterPage(guildId: string, name: string): RoleRosterPage | null {
    this.ensureGuild(guildId);
    const cleanName = name.trim();
    if (!cleanName || this.listRoleRosterPages(guildId).some((page) => page.name.toLocaleLowerCase("en-US") === cleanName.toLocaleLowerCase("en-US"))) return null;
    const result = this.database.prepare(`
      INSERT INTO role_roster_pages (guild_id, name, sort_order)
      SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1 FROM role_roster_pages WHERE guild_id = ?
    `).run(guildId, cleanName, guildId);
    this.database.prepare("UPDATE tracked_roles SET page_id = ? WHERE guild_id = ? AND page_id IS NULL")
      .run(Number(result.lastInsertRowid), guildId);
    return this.listRoleRosterPages(guildId).find((page) => page.id === Number(result.lastInsertRowid)) ?? null;
  }

  removeRoleRosterPage(guildId: string, pageId: number): boolean {
    const pages = this.listRoleRosterPages(guildId);
    if (pages.length <= 1 || !pages.some((page) => page.id === pageId)) return false;
    const fallback = pages.find((page) => page.id !== pageId)!;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("UPDATE tracked_roles SET page_id = ? WHERE guild_id = ? AND page_id = ?").run(fallback.id, guildId, pageId);
      this.database.prepare("DELETE FROM role_roster_pages WHERE guild_id = ? AND id = ?").run(guildId, pageId);
      this.database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  moveTrackedRoleToPage(guildId: string, roleId: string, pageId: number): boolean {
    const result = this.database.prepare(`
      UPDATE tracked_roles SET page_id = ?
      WHERE guild_id = ? AND role_id = ?
        AND EXISTS (SELECT 1 FROM role_roster_pages WHERE guild_id = ? AND id = ?)
    `).run(pageId, guildId, roleId, guildId, pageId);
    return Number(result.changes) > 0;
  }

  setTrackedRolePriority(guildId: string, roleId: string, highPriority: boolean): boolean {
    const result = this.database.prepare(`
      UPDATE tracked_roles SET high_priority = ? WHERE guild_id = ? AND role_id = ?
    `).run(highPriority ? 1 : 0, guildId, roleId);
    return Number(result.changes) > 0;
  }

  createSquad(guildId: string, rawName: string, createdByUserId: string): Squad {
    this.ensureGuild(guildId);
    const { name, normalizedName } = validateSquadName(rawName);

    try {
      const result = this.database
        .prepare(`
          INSERT INTO squads (
            guild_id, name, normalized_name, sort_order, created_by_user_id
          )
          SELECT ?, ?, ?, COALESCE(MAX(sort_order), -1) + 1, ?
          FROM squads
          WHERE guild_id = ?
        `)
        .run(guildId, name, normalizedName, createdByUserId, guildId);
      const squad = this.getSquad(guildId, Number(result.lastInsertRowid));
      if (!squad) {
        throw new Error("The newly created squad could not be loaded.");
      }
      return squad;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateSquadNameError(name);
      }
      throw error;
    }
  }

  renameSquad(guildId: string, squadId: number, rawName: string): Squad | null {
    const { name, normalizedName } = validateSquadName(rawName);

    try {
      const result = this.database
        .prepare(`
          UPDATE squads
          SET name = ?, normalized_name = ?
          WHERE guild_id = ? AND id = ?
        `)
        .run(name, normalizedName, guildId, squadId);
      if (Number(result.changes) === 0) {
        return null;
      }
      return this.getSquad(guildId, squadId);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateSquadNameError(name);
      }
      throw error;
    }
  }

  deleteSquad(guildId: string, squadId: number): boolean {
    for (const assignment of this.listSquadLoadoutAssignments(guildId, squadId)) {
      this.endLoadoutRoleActivity(guildId, assignment.userId);
    }
    const result = this.database
      .prepare("DELETE FROM squads WHERE guild_id = ? AND id = ?")
      .run(guildId, squadId);
    return Number(result.changes) > 0;
  }

  getSquad(guildId: string, squadId: number): Squad | null {
    const row = this.database
      .prepare(`
        SELECT id, guild_id, name, normalized_name, sort_order
        FROM squads
        WHERE guild_id = ? AND id = ?
      `)
      .get(guildId, squadId) as unknown as SquadRow | undefined;
    return row ? mapSquad(row) : null;
  }

  listSquads(guildId: string): Squad[] {
    const rows = this.database
      .prepare(`
        SELECT id, guild_id, name, normalized_name, sort_order
        FROM squads
        WHERE guild_id = ?
        ORDER BY sort_order, id
      `)
      .all(guildId) as unknown as SquadRow[];
    return rows.map(mapSquad);
  }

  setSquadLoadoutRole(
    guildId: string,
    squadId: number,
    rawName: string,
    percentage: number,
    instructions: string | null,
    discordRoleId: string | null = null,
  ): boolean {
    if (!this.getSquad(guildId, squadId)) return false;
    const name = rawName.trim();
    const normalizedName = name.toLocaleLowerCase("en-US");
    if (!name || name.length > 100 || !Number.isSafeInteger(percentage) || percentage < 0 || percentage > 100) return false;
    if (percentage === 0) {
      this.database.prepare("DELETE FROM squad_loadout_roles WHERE squad_id = ? AND normalized_name = ?")
        .run(squadId, normalizedName);
      return true;
    }
    this.database.prepare(`
      INSERT INTO squad_loadout_roles (squad_id, normalized_name, name, role_count, instructions, discord_role_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(squad_id, normalized_name) DO UPDATE SET
        name = excluded.name, role_count = excluded.role_count, instructions = excluded.instructions,
        discord_role_id = COALESCE(excluded.discord_role_id, squad_loadout_roles.discord_role_id)
    `).run(squadId, normalizedName, name, percentage, instructions?.trim() || null, discordRoleId);
    return true;
  }

  listSquadLoadoutRoles(guildId: string, squadId: number): SquadLoadoutRole[] {
    if (!this.getSquad(guildId, squadId)) return [];
    const rows = this.database.prepare(`
      SELECT squad_id, normalized_name, name, role_count, instructions, discord_role_id,
             first_preference_role_id, second_preference_role_id
      FROM squad_loadout_roles WHERE squad_id = ? ORDER BY normalized_name
    `).all(squadId) as unknown as Array<{ squad_id: number; normalized_name: string; name: string; role_count: number; instructions: string | null; discord_role_id: string | null; first_preference_role_id: string | null; second_preference_role_id: string | null }>;
    return rows.map((row) => ({ squadId: row.squad_id, normalizedName: row.normalized_name, name: row.name, percentage: row.role_count, instructions: row.instructions, discordRoleId: row.discord_role_id, firstPreferenceRoleId: row.first_preference_role_id, secondPreferenceRoleId: row.second_preference_role_id }));
  }

  setSquadLoadoutPreferenceRole(
    guildId: string,
    squadId: number,
    normalizedName: string,
    preference: "first" | "second",
    roleId: string,
  ): boolean {
    if (!this.getSquad(guildId, squadId)) return false;
    const column = preference === "first" ? "first_preference_role_id" : "second_preference_role_id";
    const result = this.database.prepare(`
      UPDATE squad_loadout_roles SET ${column} = ? WHERE squad_id = ? AND normalized_name = ?
    `).run(roleId, squadId, normalizedName);
    return Number(result.changes) > 0;
  }

  replaceSquadLoadoutAssignments(
    guildId: string,
    squadId: number,
    assignments: Array<{ userId: string; roleName: string }>,
  ): boolean {
    if (!this.getSquad(guildId, squadId)) return false;
    for (const assignment of this.listSquadLoadoutAssignments(guildId, squadId)) {
      this.endLoadoutRoleActivity(guildId, assignment.userId);
    }
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM squad_loadout_assignments WHERE guild_id = ? AND squad_id = ?")
        .run(guildId, squadId);
      const insert = this.database.prepare(`
        INSERT INTO squad_loadout_assignments (guild_id, squad_id, user_id, role_name)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          squad_id = excluded.squad_id, role_name = excluded.role_name
      `);
      for (const assignment of assignments) {
        insert.run(guildId, squadId, assignment.userId, assignment.roleName);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (const assignment of assignments) {
      const active = this.database.prepare(`
        SELECT started_at FROM active_voice_sessions
        WHERE guild_id = ? AND user_id = ? AND squad_id = ?
      `).get(guildId, assignment.userId, squadId) as unknown as { started_at: number } | undefined;
      if (active) this.beginLoadoutRoleActivity(guildId, assignment.userId, squadId, assignment.roleName);
    }
    return true;
  }

  listSquadLoadoutAssignments(guildId: string, squadId?: number): SquadLoadoutAssignment[] {
    const rows = (squadId === undefined
      ? this.database.prepare(`
          SELECT guild_id, squad_id, user_id, role_name
          FROM squad_loadout_assignments WHERE guild_id = ? ORDER BY squad_id, user_id
        `).all(guildId)
      : this.database.prepare(`
          SELECT guild_id, squad_id, user_id, role_name
          FROM squad_loadout_assignments WHERE guild_id = ? AND squad_id = ? ORDER BY user_id
        `).all(guildId, squadId)) as unknown as Array<{ guild_id: string; squad_id: number; user_id: string; role_name: string }>;
    return rows.map((row) => ({ guildId: row.guild_id, squadId: row.squad_id, userId: row.user_id, roleName: row.role_name }));
  }

  clearSquadLoadoutAssignments(guildId: string, squadId: number): number {
    for (const assignment of this.listSquadLoadoutAssignments(guildId, squadId)) {
      this.endLoadoutRoleActivity(guildId, assignment.userId);
    }
    const result = this.database.prepare(
      "DELETE FROM squad_loadout_assignments WHERE guild_id = ? AND squad_id = ?",
    ).run(guildId, squadId);
    return Number(result.changes);
  }

  removeSquadLoadoutAssignment(guildId: string, userId: string): boolean {
    this.endLoadoutRoleActivity(guildId, userId);
    const result = this.database.prepare(
      "DELETE FROM squad_loadout_assignments WHERE guild_id = ? AND user_id = ?",
    ).run(guildId, userId);
    return Number(result.changes) > 0;
  }

  assignMember(
    guildId: string,
    userId: string,
    squadId: number,
    assignedByUserId: string,
  ): boolean {
    if (!this.getSquad(guildId, squadId)) {
      return false;
    }

    this.ensureGuild(guildId);
    this.removeSquadLoadoutAssignment(guildId, userId);
    this.database
      .prepare(`
        INSERT INTO squad_memberships (
          guild_id, user_id, squad_id, assigned_by_user_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          squad_id = excluded.squad_id,
          assigned_by_user_id = excluded.assigned_by_user_id,
          assigned_at = CURRENT_TIMESTAMP
      `)
      .run(guildId, userId, squadId, assignedByUserId);
    return true;
  }

  unassignMember(guildId: string, userId: string): boolean {
    this.removeSquadLoadoutAssignment(guildId, userId);
    const result = this.database
      .prepare("DELETE FROM squad_memberships WHERE guild_id = ? AND user_id = ?")
      .run(guildId, userId);
    return Number(result.changes) > 0;
  }

  listMemberships(guildId: string): SquadMembership[] {
    const rows = this.database
      .prepare(`
        SELECT guild_id, user_id, squad_id
        FROM squad_memberships
        WHERE guild_id = ?
        ORDER BY user_id
      `)
      .all(guildId) as unknown as MembershipRow[];
    return rows.map((row) => ({
      guildId: row.guild_id,
      userId: row.user_id,
      squadId: row.squad_id,
    }));
  }

  getMembership(guildId: string, userId: string): SquadMembership | null {
    const row = this.database
      .prepare(`
        SELECT guild_id, user_id, squad_id
        FROM squad_memberships
        WHERE guild_id = ? AND user_id = ?
      `)
      .get(guildId, userId) as unknown as MembershipRow | undefined;
    return row
      ? { guildId: row.guild_id, userId: row.user_id, squadId: row.squad_id }
      : null;
  }

  listPublishedMessages(guildId: string, rosterType: RosterType): PublishedMessage[] {
    const rows = this.database
      .prepare(`
        SELECT guild_id, roster_type, ordinal, channel_id, message_id
        FROM published_messages
        WHERE guild_id = ? AND roster_type = ?
        ORDER BY ordinal
      `)
      .all(guildId, rosterType) as unknown as PublishedMessageRow[];
    return rows.map(mapPublishedMessage);
  }

  getPublishedMessageById(guildId: string, messageId: string): PublishedMessage | null {
    const row = this.database
      .prepare(`
        SELECT guild_id, roster_type, ordinal, channel_id, message_id
        FROM published_messages
        WHERE guild_id = ? AND message_id = ?
        ORDER BY roster_type, ordinal
        LIMIT 1
      `)
      .get(guildId, messageId) as unknown as PublishedMessageRow | undefined;
    return row ? mapPublishedMessage(row) : null;
  }

  upsertPublishedMessage(message: PublishedMessage): void {
    this.ensureGuild(message.guildId);
    this.database
      .prepare(`
        INSERT INTO published_messages (
          guild_id, roster_type, ordinal, channel_id, message_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, roster_type, ordinal) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id
      `)
      .run(
        message.guildId,
        message.rosterType,
        message.ordinal,
        message.channelId,
        message.messageId,
      );
  }

  removePublishedMessage(guildId: string, rosterType: RosterType, ordinal: number): void {
    this.database
      .prepare(`
        DELETE FROM published_messages
        WHERE guild_id = ? AND roster_type = ? AND ordinal = ?
      `)
      .run(guildId, rosterType, ordinal);
  }

  removePublishedMessagesForChannel(guildId: string, channelId: string): void {
    this.database
      .prepare("DELETE FROM published_messages WHERE guild_id = ? AND channel_id = ?")
      .run(guildId, channelId);
    this.database
      .prepare("DELETE FROM publication_cleanup WHERE guild_id = ? AND channel_id = ?")
      .run(guildId, channelId);
  }

  queueDisabledPublishedMessagesForCleanup(
    guildId: string,
    rosterType: RosterType,
  ): number {
    const config = this.getGuildConfig(guildId);
    const configuredChannelId =
      rosterType === "role"
        ? config.roleRosterChannelId
        : config.squadRosterChannelId;
    if (configuredChannelId !== null) {
      return 0;
    }

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      // Re-check under the write transaction so a newly configured roster is
      // never mistaken for an orphaned disabled publication.
      const channelColumn =
        rosterType === "role" ? "role_roster_channel_id" : "squad_roster_channel_id";
      const disabled = this.database
        .prepare(`
          SELECT 1 AS disabled
          FROM guild_config
          WHERE guild_id = ? AND ${channelColumn} IS NULL
        `)
        .get(guildId) as unknown as { disabled: number } | undefined;
      if (!disabled) {
        this.database.exec("COMMIT;");
        return 0;
      }
      const moved = this.queueActivePublicationRows(guildId, rosterType);
      this.database.exec("COMMIT;");
      return moved;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  queuePublishedMessageCleanup(message: PublishedMessage): void {
    this.ensureGuild(message.guildId);
    this.database
      .prepare(`
        INSERT OR IGNORE INTO publication_cleanup (
          guild_id, roster_type, ordinal, channel_id, message_id
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        message.guildId,
        message.rosterType,
        message.ordinal,
        message.channelId,
        message.messageId,
      );
  }

  listPublishedMessageCleanup(guildId: string, rosterType: RosterType): PublishedMessage[] {
    const rows = this.database
      .prepare(`
        SELECT guild_id, roster_type, ordinal, channel_id, message_id
        FROM publication_cleanup
        WHERE guild_id = ? AND roster_type = ?
        ORDER BY ordinal, channel_id, message_id
      `)
      .all(guildId, rosterType) as unknown as PublishedMessageRow[];
    return rows.map(mapPublishedMessage);
  }

  removePublishedMessageCleanup(message: PublishedMessage): void {
    this.database
      .prepare(`
        DELETE FROM publication_cleanup
        WHERE guild_id = ? AND roster_type = ? AND channel_id = ? AND message_id = ?
      `)
      .run(message.guildId, message.rosterType, message.channelId, message.messageId);
  }

  private queueActivePublicationRows(guildId: string, rosterType: RosterType): number {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO publication_cleanup (
          guild_id, roster_type, ordinal, channel_id, message_id
        )
        SELECT guild_id, roster_type, ordinal, channel_id, message_id
        FROM published_messages
        WHERE guild_id = ? AND roster_type = ?
      `)
      .run(guildId, rosterType);
    const removed = this.database
      .prepare(`
        DELETE FROM published_messages
        WHERE guild_id = ? AND roster_type = ?
      `)
      .run(guildId, rosterType);
    return Number(removed.changes);
  }
}

function mapSquad(row: SquadRow): Squad {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    normalizedName: row.normalized_name,
    sortOrder: row.sort_order,
  };
}

function mapPublishedMessage(row: PublishedMessageRow): PublishedMessage {
  return {
    guildId: row.guild_id,
    rosterType: row.roster_type,
    ordinal: row.ordinal,
    channelId: row.channel_id,
    messageId: row.message_id,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
