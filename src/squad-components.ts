import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import type { Squad } from "./types.js";

export const SQUAD_JOIN_CUSTOM_ID_PREFIX = "squad:v1:join:";
export const SQUAD_LEAVE_CUSTOM_ID = "squad:v1:leave";
export const SQUAD_CALL_CUSTOM_ID = "squad:v1:call";
export const SQUAD_ASSIGN_LOADOUT_CUSTOM_ID = "squad:v1:assign-loadout";
export const SQUAD_CLEAR_LOADOUT_CUSTOM_ID = "squad:v1:clear-loadout";
export const SQUAD_CONFIG_LOADOUT_CUSTOM_ID = "squad:v1:config-loadout";
export const MAX_INTERACTIVE_SQUADS = 100;

const OPTIONS_PER_MENU = 25;
const MAX_JOIN_MENUS = 4;

export type SquadControlRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

export function buildSquadControlRows(squads: Squad[]): SquadControlRow[] {
  const visibleSquads = squads.slice(0, MAX_INTERACTIVE_SQUADS);
  if (visibleSquads.length === 0) {
    return [];
  }

  const chunks = chunk(visibleSquads, OPTIONS_PER_MENU).slice(0, MAX_JOIN_MENUS);
  const rows = chunks.map((squadChunk, index) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}${index}`)
      .setPlaceholder(
        chunks.length === 1
          ? "Join or move to a squad"
          : `Join or move to a squad (${index + 1}/${chunks.length})`,
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        squadChunk.map((squad) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(squad.name)
            .setValue(String(squad.id))
            .setDescription(`Join or move to ${squad.name}`),
        ),
      );
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
  });

  const leaveButton = new ButtonBuilder()
    .setCustomId(SQUAD_LEAVE_CUSTOM_ID)
    .setLabel("Leave current squad")
    .setStyle(ButtonStyle.Danger);
  const callButton = new ButtonBuilder()
    .setCustomId(SQUAD_CALL_CUSTOM_ID)
    .setLabel("Call my squad")
    .setStyle(ButtonStyle.Primary);
  const assignButton = new ButtonBuilder()
    .setCustomId(SQUAD_ASSIGN_LOADOUT_CUSTOM_ID)
    .setLabel("Assign loadouts")
    .setStyle(ButtonStyle.Secondary);
  const configButton = new ButtonBuilder()
    .setCustomId(SQUAD_CONFIG_LOADOUT_CUSTOM_ID)
    .setLabel("Configure loadout")
    .setStyle(ButtonStyle.Secondary);
  const clearButton = new ButtonBuilder()
    .setCustomId(SQUAD_CLEAR_LOADOUT_CUSTOM_ID)
    .setLabel("Clear assignments")
    .setStyle(ButtonStyle.Danger);
  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(callButton, configButton, assignButton, clearButton, leaveButton),
  );
  return rows;
}

export function isSquadJoinCustomId(customId: string): boolean {
  if (!customId.startsWith(SQUAD_JOIN_CUSTOM_ID_PREFIX)) {
    return false;
  }
  const menuIndex = Number(customId.slice(SQUAD_JOIN_CUSTOM_ID_PREFIX.length));
  return Number.isInteger(menuIndex) && menuIndex >= 0 && menuIndex < MAX_JOIN_MENUS;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
