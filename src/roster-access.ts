import type { Guild, GuildMember } from "discord.js";
import type { RosterRepository } from "./database.js";
import type { GuildConfig } from "./types.js";

export type RosterAccess = "member" | "conscript";

export function rosterAccess(member: GuildMember, config: GuildConfig): RosterAccess | null {
  if (!config.memberRoleId && !config.conscriptRoleId) return "member";
  if (config.memberRoleId && member.roles.cache.has(config.memberRoleId)) return "member";
  if (config.conscriptRoleId && member.roles.cache.has(config.conscriptRoleId)) return "conscript";
  return null;
}

export function resolveRosterAccessConfig(guild: Guild, repository: RosterRepository): GuildConfig {
  let config = repository.getGuildConfig(guild.id);
  let changed = false;
  for (const roleId of [config.memberRoleId, config.conscriptRoleId]) {
    if (roleId && !guild.roles.cache.has(roleId)) {
      changed = repository.clearRosterAccessRoleIfMatches(guild.id, roleId) || changed;
    }
  }
  if (changed) config = repository.getGuildConfig(guild.id);
  return config;
}
