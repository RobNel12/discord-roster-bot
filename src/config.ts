import { resolve } from "node:path";

export interface AppConfig {
  token: string;
  applicationId: string;
  commandGuildId?: string;
  databasePath: string;
  rosterDebounceMs: number;
  reconcileIntervalMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const commandGuildId = env.DISCORD_GUILD_ID?.trim() || undefined;
  const reconcileMinutes = positiveInteger(env, "RECONCILE_INTERVAL_MINUTES", 15);

  return {
    token: required(env, "DISCORD_TOKEN"),
    applicationId: required(env, "DISCORD_APPLICATION_ID"),
    ...(commandGuildId ? { commandGuildId } : {}),
    databasePath: resolve(env.DATABASE_PATH?.trim() || "./data/roster.sqlite"),
    rosterDebounceMs: positiveInteger(env, "ROSTER_DEBOUNCE_MS", 2_000),
    reconcileIntervalMs: reconcileMinutes * 60_000,
  };
}
