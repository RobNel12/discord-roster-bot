import { ButtonStyle, ComponentType } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  buildSquadControlRows,
  isSquadJoinCustomId,
  MAX_INTERACTIVE_SQUADS,
  SQUAD_JOIN_CUSTOM_ID_PREFIX,
  SQUAD_LEAVE_CUSTOM_ID,
} from "../src/squad-components.js";
import type { Squad } from "../src/types.js";

interface RawComponent {
  type: number;
  custom_id?: string;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  style?: number;
  label?: string;
  emoji?: { name?: string };
  options?: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: { name?: string };
  }>;
}

interface RawRow {
  type: number;
  components: RawComponent[];
}

describe("squad component builders", () => {
  it("builds a versioned join menu and a red leave button", () => {
    const rows = toRawRows(buildSquadControlRows([squad(1, "Alpha")]));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: `${SQUAD_JOIN_CUSTOM_ID_PREFIX}0`,
          placeholder: "✅ Join or move to a squad",
          min_values: 1,
          max_values: 1,
          options: [
            {
              label: "Alpha",
              value: "1",
              description: "Join or move to Alpha",
              emoji: { name: "✅" },
            },
          ],
        },
      ],
    });
    expect(rows[1]).toMatchObject({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          custom_id: SQUAD_LEAVE_CUSTOM_ID,
          label: "Leave current squad",
          emoji: { name: "❌" },
          style: ButtonStyle.Danger,
        },
      ],
    });
    expect(SQUAD_JOIN_CUSTOM_ID_PREFIX).toContain(":v1:");
    expect(SQUAD_LEAVE_CUSTOM_ID).toContain(":v1:");
  });

  it("uses four 25-option menus and never exposes more than 100 squads", () => {
    const squads = Array.from({ length: MAX_INTERACTIVE_SQUADS + 1 }, (_, index) =>
      squad(index + 1, `Squad ${index + 1}`),
    );
    const rows = toRawRows(buildSquadControlRows(squads));
    const menus = rows.slice(0, -1).map((row) => row.components[0]);
    const options = menus.flatMap((menu) => menu?.options ?? []);

    expect(rows).toHaveLength(5);
    expect(menus).toHaveLength(4);
    expect(menus.map((menu) => menu?.options?.length)).toEqual([25, 25, 25, 25]);
    expect(menus.map((menu) => menu?.custom_id)).toEqual([
      `${SQUAD_JOIN_CUSTOM_ID_PREFIX}0`,
      `${SQUAD_JOIN_CUSTOM_ID_PREFIX}1`,
      `${SQUAD_JOIN_CUSTOM_ID_PREFIX}2`,
      `${SQUAD_JOIN_CUSTOM_ID_PREFIX}3`,
    ]);
    expect(options).toHaveLength(MAX_INTERACTIVE_SQUADS);
    expect(options.map((option) => option.value)).toEqual(
      Array.from({ length: MAX_INTERACTIVE_SQUADS }, (_, index) => String(index + 1)),
    );
    expect(options.some((option) => option.value === "101")).toBe(false);
  });

  it("omits controls when no squads exist", () => {
    expect(buildSquadControlRows([])).toEqual([]);
  });

  it("accepts only current-version menu IDs within the supported row range", () => {
    expect(isSquadJoinCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}0`)).toBe(true);
    expect(isSquadJoinCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}3`)).toBe(true);
    expect(isSquadJoinCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}4`)).toBe(false);
    expect(isSquadJoinCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}-1`)).toBe(false);
    expect(isSquadJoinCustomId(`${SQUAD_JOIN_CUSTOM_ID_PREFIX}1.5`)).toBe(false);
    expect(isSquadJoinCustomId("squad:join:0")).toBe(false);
    expect(isSquadJoinCustomId("squad:v0:join:0")).toBe(false);
  });
});

function squad(id: number, name: string): Squad {
  return {
    id,
    guildId: "guild-1",
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
    sortOrder: id - 1,
  };
}

function toRawRows(rows: ReturnType<typeof buildSquadControlRows>): RawRow[] {
  return rows.map((row) => row.toJSON()) as unknown as RawRow[];
}
