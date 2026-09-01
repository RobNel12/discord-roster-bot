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
} from "./types.js";

interface GuildConfigRow {
  guild_id: string;
  role_roster_channel_id: string | null;
  squad_roster_channel_id: string | null;
  squad_leader_role_id: string | null;
  temporary_voice_lobby_channel_id: string | null;
  include_bots: number;
}

interface TrackedRoleRow {
  guild_id: string;
  role_id: string;
  sort_order: number;
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
        PRIMARY KEY (guild_id, role_id),
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
        SELECT guild_id, role_roster_channel_id, squad_roster_channel_id,
               squad_leader_role_id, temporary_voice_lobby_channel_id, include_bots
        FROM guild_config
        WHERE guild_id = ?
      `)
      .get(guildId) as unknown as GuildConfigRow;

    return {
      guildId: row.guild_id,
      roleRosterChannelId: row.role_roster_channel_id,
      squadRosterChannelId: row.squad_roster_channel_id,
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
    return row?.activity_seconds ?? 0;
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
        INSERT OR IGNORE INTO tracked_roles (guild_id, role_id, sort_order)
        SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1
        FROM tracked_roles
        WHERE guild_id = ?
      `)
      .run(guildId, roleId, guildId);
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

  clearTrackedRoles(guildId: string): number {
    const result = this.database
      .prepare("DELETE FROM tracked_roles WHERE guild_id = ?")
      .run(guildId);
    return Number(result.changes);
  }

  listTrackedRoles(guildId: string): TrackedRole[] {
    const rows = this.database
      .prepare(`
        SELECT guild_id, role_id, sort_order
        FROM tracked_roles
        WHERE guild_id = ?
        ORDER BY sort_order, role_id
      `)
      .all(guildId) as unknown as TrackedRoleRow[];

    return rows.map((row) => ({
      guildId: row.guild_id,
      roleId: row.role_id,
      sortOrder: row.sort_order,
    }));
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
