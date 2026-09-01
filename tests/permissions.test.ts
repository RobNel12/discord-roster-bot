import {
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import { afterEach, describe, expect, it } from "vitest";

import { RosterRepository } from "../src/database.js";
import {
  canManageSquads,
  isServerManager,
  missingRosterChannelPermissions,
} from "../src/permissions.js";

describe("squad permissions", () => {
  const repositories: RosterRepository[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      repository.close();
    }
  });

  it("allows the configured leader role and revokes access when it is cleared", async () => {
    const repository = makeRepository();
    repository.setSquadLeaderRole("guild-1", "leader-role");
    const leader = fakeInteraction(0n, ["leader-role"]);
    const ordinaryMember = fakeInteraction(0n, []);

    await expect(canManageSquads(leader, repository)).resolves.toBe(true);
    await expect(canManageSquads(ordinaryMember, repository)).resolves.toBe(false);

    repository.setSquadLeaderRole("guild-1", null);
    await expect(canManageSquads(leader, repository)).resolves.toBe(false);
  });

  it("always allows Manage Server and Administrator permissions", async () => {
    const repository = makeRepository();
    const manager = fakeInteraction(PermissionFlagsBits.ManageGuild, []);
    const administrator = fakeInteraction(PermissionFlagsBits.Administrator, []);

    expect(isServerManager(manager)).toBe(true);
    expect(isServerManager(administrator)).toBe(true);
    await expect(canManageSquads(manager, repository)).resolves.toBe(true);
    await expect(canManageSquads(administrator, repository)).resolves.toBe(true);
  });

  it("checks every permission needed to maintain persistent roster messages", async () => {
    const botMember = { id: "bot-user" };
    const guild = { members: { me: botMember } } as unknown as Guild;
    const granted = new PermissionsBitField(
      PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.EmbedLinks,
    );
    const channel = {
      permissionsFor: () => granted,
    } as unknown as GuildBasedChannel;

    await expect(missingRosterChannelPermissions(guild, channel)).resolves.toEqual([
      "Read Message History",
    ]);
  });

  function makeRepository(): RosterRepository {
    const repository = new RosterRepository(":memory:");
    repositories.push(repository);
    return repository;
  }
});

function fakeInteraction(
  permissionBits: bigint,
  roleIds: string[],
): ChatInputCommandInteraction {
  const assignedRoles = new Set(roleIds);
  const guild = {
    members: {
      async fetch() {
        return { roles: { cache: { has: (roleId: string) => assignedRoles.has(roleId) } } };
      },
    },
  } as unknown as Guild;

  return {
    memberPermissions: new PermissionsBitField(permissionBits),
    guildId: "guild-1",
    guild,
    user: { id: "user-1" },
  } as ChatInputCommandInteraction;
}
