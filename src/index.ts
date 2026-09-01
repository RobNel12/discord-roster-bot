import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { RosterBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { RosterRepository } from "./database.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const repository = new RosterRepository(config.databasePath);
  const bot = new RosterBot(config, repository);
  let stopping = false;
  let repositoryClosed = false;

  const closeRepository = (): void => {
    if (!repositoryClosed) {
      repository.close();
      repositoryClosed = true;
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`[bot] ${signal} received; shutting down.`);
    try {
      await bot.stop();
    } finally {
      closeRepository();
    }
  };

  const reportShutdownFailure = (error: unknown): void => {
    console.error("[bot] Graceful shutdown failed:", error);
    process.exitCode = 1;
  };
  process.once("SIGINT", () => void shutdown("SIGINT").catch(reportShutdownFailure));
  process.once("SIGTERM", () => void shutdown("SIGTERM").catch(reportShutdownFailure));

  try {
    await bot.start();
  } catch (error) {
    try {
      await bot.stop();
    } finally {
      closeRepository();
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("[bot] Fatal startup error:", error);
  process.exitCode = 1;
});
