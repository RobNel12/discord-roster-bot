import {
  Collection,
  type Client,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RosterRepository } from "../src/database.js";
import type { MemberDirectory } from "../src/rosters/member-directory.js";
import { MissingRosterChannelError, type RosterPublisher } from "../src/rosters/publisher.js";
import { RosterService } from "../src/rosters/service.js";
import type { RosterType } from "../src/types.js";

describe("RosterService", () => {
  const openRepositories: RosterRepository[] = [];

  afterEach(() => {
    for (const repository of openRepositories.splice(0)) {
      repository.close();
    }
  });

  it("groups multi-role members, preserves role order, sorts names, and excludes bots", async () => {
    const alphaRoleId = "100000000000000001";
    const bravoRoleId = "100000000000000002";
    const members = new Collection<string, GuildMember>([
      [
        "200000000000000001",
        fakeMember("200000000000000001", "Zulu", [alphaRoleId, bravoRoleId]),
      ],
      [
        "200000000000000002",
        fakeMember("200000000000000002", "Alpha", [alphaRoleId, bravoRoleId]),
      ],
      [
        "200000000000000003",
        fakeMember("200000000000000003", "Bot", [alphaRoleId], true),
      ],
    ]);
    const roles = new Collection<string, Role>([
      [alphaRoleId, fakeRole(alphaRoleId, "Alpha Role")],
      [bravoRoleId, fakeRole(bravoRoleId, "Bravo Role")],
    ]);
    const harness = createHarness(members, roles);
    harness.repository.setRoleRosterChannel(harness.guild.id, "role-channel");
    harness.repository.addTrackedRole(harness.guild.id, bravoRoleId);
    harness.repository.addTrackedRole(harness.guild.id, alphaRoleId);

    await harness.service.syncRoleRoster(harness.guild.id);

    expect(harness.publications).toHaveLength(1);
    const fields = harness.publications[0]?.pages[0]?.toJSON().fields ?? [];
    expect(fields.map((field) => field.name)).toEqual(["Bravo Role — 2", "Alpha Role — 2"]);
    expect(fields[0]?.value).toBe("• <@200000000000000002>\n• <@200000000000000001>");
    expect(fields[1]?.value).not.toContain("200000000000000003");
  });

  it("publishes named role pages and highlights priority roles", async () => {
    const commandId = "100000000000000011";
    const supportId = "100000000000000012";
    const reserveId = "100000000000000013";
    const memberId = "200000000000000011";
    const members = new Collection<string, GuildMember>([[memberId, fakeMember(memberId, "Alpha", [commandId, supportId, reserveId])]]);
    const roles = new Collection<string, Role>([
      [commandId, fakeRole(commandId, "Command")],
      [supportId, fakeRole(supportId, "Support")],
      [reserveId, fakeRole(reserveId, "Reserve")],
    ]);
    const harness = createHarness(members, roles);
    harness.repository.replaceRoleRosterSetup(harness.guild.id, "role-channel", [
      { name: "Leadership", roles: [{ roleId: commandId, highPriority: true }] },
      { name: "Logistics", roles: [{ roleId: supportId, highPriority: false }] },
      { name: "Reserve", roles: [{ roleId: reserveId, highPriority: false }] },
    ]);
    await harness.service.syncRoleRoster(harness.guild.id);

    expect(harness.publications[0]?.pages[0]?.toJSON().title).toBe("Role roster — Leadership");
    expect(harness.publications[0]?.pages[0]?.toJSON().fields?.[0]?.name).toContain("⭐");
    await harness.service.turnRoleRosterPage(harness.guild.id, 1);
    expect(harness.publications[1]?.pages[0]?.toJSON().title).toBe("Role roster — Logistics");
    expect(harness.publications[1]?.pages[0]?.toJSON().fields?.[0]?.name).toBe("Support — 1");
    await harness.service.turnRoleRosterPage(harness.guild.id, 1);
    expect(harness.publications[2]?.pages[0]?.toJSON().title).toBe("Role roster — Reserve");
    await harness.service.turnRoleRosterPage(harness.guild.id, 1);
    expect(harness.publications[3]?.pages[0]?.toJSON().title).toBe("Role roster — Leadership");
  });

  it("continues with the squad roster when the role roster fails", async () => {
    const harness = createHarness();
    harness.repository.setRoleRosterChannel(harness.guild.id, "role-channel");
    harness.repository.setSquadRosterChannel(harness.guild.id, "squad-channel");
    const attempted: RosterType[] = [];
    harness.publisher.publish = vi.fn(async (_guild, _channel, rosterType) => {
      attempted.push(rosterType);
      if (rosterType === "role") {
        throw new Error("role channel denied");
      }
    });

    await expect(harness.service.syncBoth(harness.guild.id)).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(attempted).toEqual(["role", "squad"]);
  });

  it("retries queued message cleanup even when both publications are disabled", async () => {
    const harness = createHarness();
    harness.publisher.retryQueuedCleanup = vi.fn(async () => undefined);

    await harness.service.syncBoth(harness.guild.id);

    expect(harness.publisher.retryQueuedCleanup).toHaveBeenCalledTimes(2);
    expect(harness.publisher.retryQueuedCleanup).toHaveBeenNthCalledWith(
      1,
      harness.guild,
      "role",
    );
    expect(harness.publisher.retryQueuedCleanup).toHaveBeenNthCalledWith(
      2,
      harness.guild,
      "squad",
    );
    expect(harness.publications).toEqual([]);
  });

  it("publishes assigned squads separately from eligible unassigned members", async () => {
    const members = new Collection<string, GuildMember>([
      ["200000000000000001", fakeMember("200000000000000001", "Alice", [])],
      ["200000000000000002", fakeMember("200000000000000002", "Bob", [])],
      ["200000000000000003", fakeMember("200000000000000003", "Bot", [], true)],
    ]);
    const harness = createHarness(members);
    harness.repository.setSquadRosterChannel(harness.guild.id, "squad-channel");
    const alpha = harness.repository.createSquad(harness.guild.id, "Alpha", "admin");
    harness.repository.createSquad(harness.guild.id, "Bravo", "admin");
    harness.repository.assignMember(
      harness.guild.id,
      "200000000000000002",
      alpha.id,
      "leader",
    );
    harness.repository.replaceSquadLoadoutAssignments(harness.guild.id, alpha.id, [
      { userId: "200000000000000002", roleName: "Medic" },
    ]);

    await harness.service.syncSquadRoster(harness.guild.id);

    const fields = harness.publications[0]?.pages[0]?.toJSON().fields ?? [];
    expect(fields.map((field) => field.name)).toEqual([
      "Alpha — 1",
      "Bravo — 0",
      "Unassigned — 1",
    ]);
    expect(fields[0]?.value).toBe("• <@200000000000000002> — **Pvt.** · **Medic**");
    expect(fields[2]?.value).toBe("• <@200000000000000001>");
    expect(JSON.stringify(fields)).not.toContain("200000000000000003");
    const controls = harness.publications[0]?.components.map((row) => row.toJSON()) ?? [];
    expect(controls).toHaveLength(2);
    expect(controls[0]?.components[0]).toMatchObject({
      custom_id: "squad:v1:join:0",
      options: [
        expect.objectContaining({
          label: "Alpha",
          value: String(alpha.id),
        }),
        expect.objectContaining({
          label: "Bravo",
        }),
      ],
    });
    expect(controls[1]?.components[4]).toMatchObject({
      custom_id: "squad:v1:leave",
      label: "Leave current squad",
    });
  });

  it("clears a leader role that was deleted while the bot was offline", async () => {
    const harness = createHarness();
    harness.repository.setSquadRosterChannel(harness.guild.id, "squad-channel");
    harness.repository.setSquadLeaderRole(harness.guild.id, "missing-role");

    await harness.service.syncSquadRoster(harness.guild.id);

    expect(harness.repository.getGuildConfig(harness.guild.id).squadLeaderRoleId).toBeNull();
  });

  it("clears a roster channel that was deleted while the bot was offline", async () => {
    const harness = createHarness();
    harness.repository.setRoleRosterChannel(harness.guild.id, "missing-channel");
    harness.publisher.publish = vi.fn(async () => {
      throw new MissingRosterChannelError("missing-channel");
    });

    await harness.service.syncRoleRoster(harness.guild.id);

    expect(harness.repository.getGuildConfig(harness.guild.id).roleRosterChannelId).toBeNull();
  });

  it("does not clear a newer channel selected during an older refresh", async () => {
    const harness = createHarness();
    harness.repository.setRoleRosterChannel(harness.guild.id, "old-channel");
    harness.publisher.publish = vi.fn(async () => {
      harness.repository.setRoleRosterChannel(harness.guild.id, "new-channel");
      throw new MissingRosterChannelError("old-channel");
    });

    await harness.service.syncRoleRoster(harness.guild.id);

    expect(harness.repository.getGuildConfig(harness.guild.id).roleRosterChannelId).toBe(
      "new-channel",
    );
  });

  it("does not clear a newer leader role selected during member reconciliation", async () => {
    const currentLeaderRoleId = "100000000000000099";
    const roles = new Collection<string, Role>([
      [currentLeaderRoleId, fakeRole(currentLeaderRoleId, "Current Leaders")],
    ]);
    const harness = createHarness(new Collection(), roles);
    harness.repository.setSquadRosterChannel(harness.guild.id, "squad-channel");
    harness.repository.setSquadLeaderRole(harness.guild.id, "old-missing-role");
    harness.memberDirectory.getCompleteMembers = async () => {
      harness.repository.setSquadLeaderRole(harness.guild.id, currentLeaderRoleId);
      return harness.guild.members.cache;
    };

    await harness.service.syncSquadRoster(harness.guild.id);

    expect(harness.repository.getGuildConfig(harness.guild.id).squadLeaderRoleId).toBe(
      currentLeaderRoleId,
    );
  });

  function createHarness(
    members = new Collection<string, GuildMember>(),
    roles = new Collection<string, Role>(),
  ): {
    repository: RosterRepository;
    guild: Guild;
    service: RosterService;
    publisher: Pick<RosterPublisher, "publish" | "retryQueuedCleanup">;
    memberDirectory: Pick<MemberDirectory, "getCompleteMembers">;
    publications: Array<{
      type: RosterType;
      pages: EmbedBuilder[];
      components: NonNullable<Parameters<RosterPublisher["publish"]>[4]>;
    }>;
  } {
    const repository = new RosterRepository(":memory:");
    openRepositories.push(repository);
    const guild = {
      id: "guild-1",
      roles: { cache: roles },
      members: { cache: members },
    } as unknown as Guild;
    const client = {
      guilds: { cache: new Collection<string, Guild>([[guild.id, guild]]) },
    } as unknown as Client;
    const publications: Array<{
      type: RosterType;
      pages: EmbedBuilder[];
      components: NonNullable<Parameters<RosterPublisher["publish"]>[4]>;
    }> = [];
    const memberDirectory: Pick<MemberDirectory, "getCompleteMembers"> = {
      async getCompleteMembers() {
        return members;
      },
    };
    const publisher: Pick<RosterPublisher, "publish" | "retryQueuedCleanup"> = {
      async retryQueuedCleanup() {},
      async publish(_guild, _channelId, rosterType, pages, components = []) {
        publications.push({ type: rosterType, pages, components });
      },
    };
    const service = new RosterService(client, repository, {
      members: memberDirectory,
      publisher,
    });
    return { repository, guild, service, publisher, memberDirectory, publications };
  }
});

function fakeMember(
  id: string,
  displayName: string,
  roleIds: string[],
  bot = false,
): GuildMember {
  const roleIdSet = new Set(roleIds);
  return {
    id,
    displayName,
    user: { bot },
    permissions: { has: () => false },
    roles: { cache: { has: (roleId: string) => roleIdSet.has(roleId) } },
  } as unknown as GuildMember;
}

function fakeRole(id: string, name: string): Role {
  return { id, name } as Role;
}
