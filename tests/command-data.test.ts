import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import { commandJson } from "../src/command-data.js";

describe("application command definitions", () => {
  it("keeps roster setup restricted while leaving squad access to runtime role checks", () => {
    const roster = commandJson.find((command) => command.name === "roster");
    const squad = commandJson.find((command) => command.name === "squad");

    expect(roster?.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(squad?.default_member_permissions).toBeUndefined();
    expect(roster?.contexts).toEqual([InteractionContextType.Guild]);
    expect(squad?.contexts).toEqual([InteractionContextType.Guild]);
  });

  it("exposes the complete squad-management workflow", () => {
    const squad = commandJson.find((command) => command.name === "squad");
    const subcommandNames = squad?.options?.map((option) => option.name);

    expect(subcommandNames).toEqual([
      "set-call-channel",
      "clear-call-channel",
      "set-rank-channel",
      "clear-rank-channel",
      "rank-progress",
      "set-voice-lobby",
      "clear-voice-lobby",
      "set-rank",
      "set-channel",
      "set-leader-role",
      "clear-leader-role",
      "create",
      "rename",
      "delete",
      "assign",
      "unassign",
      "list",
      "refresh",
    ]);
  });

  it("supports deleting or moving an entire publication by any page message ID", () => {
    const roster = commandJson.find((command) => command.name === "roster");
    const deleteCommand = roster?.options?.find((option) => option.name === "delete");
    const moveCommand = roster?.options?.find((option) => option.name === "move");
    const deleteOptionNames =
      deleteCommand && "options" in deleteCommand
        ? deleteCommand.options?.map((option) => option.name)
        : undefined;
    const moveOptionNames =
      moveCommand && "options" in moveCommand
        ? moveCommand.options?.map((option) => option.name)
        : undefined;

    expect(deleteOptionNames).toEqual(["message-id", "confirm"]);
    expect(moveOptionNames).toEqual(["message-id", "channel"]);
  });

  it("offers setup, hierarchy sorting, and bulk role clearing", () => {
    const roster = commandJson.find((command) => command.name === "roster");
    expect(roster?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(["setup", "sort", "clear-roles"]),
    );
  });
});
