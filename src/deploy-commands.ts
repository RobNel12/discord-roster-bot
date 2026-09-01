import { REST, Routes } from "discord.js";

import { commandJson } from "./command-data.js";
import { loadConfig } from "./config.js";

async function deploy(): Promise<void> {
  const config = loadConfig();
  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = config.commandGuildId
    ? Routes.applicationGuildCommands(config.applicationId, config.commandGuildId)
    : Routes.applicationCommands(config.applicationId);

  console.info(
    config.commandGuildId
      ? `[commands] Deploying ${commandJson.length} command(s) to guild ${config.commandGuildId}.`
      : `[commands] Deploying ${commandJson.length} command(s) globally.`,
  );
  await rest.put(route, { body: commandJson });
  console.info("[commands] Deployment complete.");
}

deploy().catch((error: unknown) => {
  console.error("[commands] Deployment failed:", error);
  process.exitCode = 1;
});
