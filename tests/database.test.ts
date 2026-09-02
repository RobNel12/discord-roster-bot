import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuplicateSquadNameError, RosterRepository } from "../src/database.js";

describe("RosterRepository", () => {
  let repository: RosterRepository;

  beforeEach(() => {
    repository = new RosterRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
  });

  it("stores per-guild configuration and tracked-role order", () => {
    const initial = repository.getGuildConfig("guild-1");
    expect(initial.roleRosterChannelId).toBeNull();
    expect(initial.squadLeaderRoleId).toBeNull();
    expect(initial.squadCallChannelId).toBeNull();
    expect(initial.temporaryVoiceLobbyChannelId).toBeNull();

    repository.setRoleRosterChannel("guild-1", "roles-channel");
    repository.setSquadRosterChannel("guild-1", "squads-channel");
    repository.setSquadLeaderRole("guild-1", "leader-role");
    expect(repository.addTrackedRole("guild-1", "role-b")).toBe(true);
    expect(repository.addTrackedRole("guild-1", "role-a")).toBe(true);
    expect(repository.addTrackedRole("guild-1", "role-b")).toBe(false);

    expect(repository.getGuildConfig("guild-1")).toMatchObject({
      roleRosterChannelId: "roles-channel",
      squadRosterChannelId: "squads-channel",
      squadLeaderRoleId: "leader-role",
    });
    expect(repository.listTrackedRoles("guild-1").map((role) => role.roleId)).toEqual([
      "role-b",
      "role-a",
    ]);
  });

  it("stores the voice lobby and temporary channel ownership", () => {
    repository.setTemporaryVoiceLobbyChannel("guild-1", "voice-lobby");
    repository.upsertTemporaryVoiceChannel("guild-1", "voice-a", "member-a");
    expect(repository.getGuildConfig("guild-1").temporaryVoiceLobbyChannelId).toBe("voice-lobby");
    expect(repository.getTemporaryVoiceChannelForOwner("guild-1", "member-a")).toMatchObject({
      channelId: "voice-a",
      ownerUserId: "member-a",
    });

    repository.upsertTemporaryVoiceChannel("guild-1", "voice-b", "member-a");
    expect(repository.listTemporaryVoiceChannels("guild-1")).toEqual([
      expect.objectContaining({ channelId: "voice-b", ownerUserId: "member-a" }),
    ]);
    expect(repository.removeTemporaryVoiceChannel("guild-1", "voice-b")).toBe(true);
    expect(repository.listTemporaryVoiceChannels("guild-1")).toEqual([]);
  });

  it("persists elapsed squad voice activity", () => {
    repository.beginVoiceActivity("guild-1", "member-a", 4, 1_000);
    expect(repository.listActiveVoiceSessions("guild-1")).toEqual([{ userId: "member-a", squadId: 4 }]);
    expect(repository.endVoiceActivity("guild-1", "member-a", 1_125)).toBe(125);
    expect(repository.getVoiceActivitySeconds("guild-1", "member-a")).toBe(125);
    expect(repository.endVoiceActivity("guild-1", "member-a", 2_000)).toBe(0);

    repository.setVoiceActivitySeconds("guild-1", "member-a", 3_600);
    expect(repository.getVoiceActivitySeconds("guild-1", "member-a")).toBe(3_600);
    expect(repository.ensureMemberRankTrack("guild-1", "member-a", "officer")).toBe(0);
    expect(repository.getMemberRankState("guild-1", "member-a").rankTrack).toBe("officer");
    repository.setManualRank("guild-1", "member-a", "SMA");
    expect(repository.getMemberRankState("guild-1", "member-a").manualRank).toBe("SMA");
  });

  it("includes an active voice session in live rank time before the member leaves", () => {
    const now = Math.floor(Date.now() / 1_000);
    repository.beginVoiceActivity("guild-live-rank", "member-live", 1, now - 120);
    expect(repository.getVoiceActivitySeconds("guild-live-rank", "member-live")).toBeGreaterThanOrEqual(120);
    repository.endVoiceActivity("guild-live-rank", "member-live", now);
  });

  it("stores and safely clears the rank update channel", () => {
    repository.setRankUpdateChannel("guild-ranks", "rank-channel");
    expect(repository.getGuildConfig("guild-ranks").rankUpdateChannelId).toBe("rank-channel");
    expect(repository.clearRankUpdateChannelIfMatches("guild-ranks", "other-channel")).toBe(false);
    expect(repository.clearRankUpdateChannelIfMatches("guild-ranks", "rank-channel")).toBe(true);
    expect(repository.getGuildConfig("guild-ranks").rankUpdateChannelId).toBeNull();
  });

  it("configures an exact six-slot squad loadout", () => {
    const squad = repository.createSquad("guild-loadout", "Alpha", "admin");
    expect(repository.setSquadLoadoutRole("guild-loadout", squad.id, "Medic", 1, "Bring medical supplies")).toBe(true);
    expect(repository.setSquadLoadoutPreferenceRole("guild-loadout", squad.id, "medic", "first", "first-medic-role")).toBe(true);
    expect(repository.setSquadLoadoutPreferenceRole("guild-loadout", squad.id, "medic", "second", "second-medic-role")).toBe(true);
    expect(repository.setSquadLoadoutRole("guild-loadout", squad.id, "Rifleman", 5, null)).toBe(true);
    expect(repository.setSquadLoadoutRole("guild-loadout", squad.id, "Grenadier", 10, null)).toBe(true);
    expect(repository.listSquadLoadoutRoles("guild-loadout", squad.id)).toEqual([
      expect.objectContaining({ name: "Grenadier", percentage: 10 }),
      expect.objectContaining({
        name: "Medic",
        percentage: 1,
        instructions: "Bring medical supplies",
        firstPreferenceRoleId: "first-medic-role",
        secondPreferenceRoleId: "second-medic-role",
      }),
      expect.objectContaining({ name: "Rifleman", percentage: 5 }),
    ]);
    expect(repository.setSquadLoadoutRole("guild-loadout", squad.id, "Medic", 0, null)).toBe(true);
    expect(repository.listSquadLoadoutRoles("guild-loadout", squad.id).map((role) => role.name)).toEqual(["Grenadier", "Rifleman"]);
  });

  it("stores loadout assignments and removes them when membership changes", () => {
    const alpha = repository.createSquad("guild-assignments", "Alpha", "admin");
    const bravo = repository.createSquad("guild-assignments", "Bravo", "admin");
    repository.assignMember("guild-assignments", "member-a", alpha.id, "admin");
    repository.assignMember("guild-assignments", "member-b", alpha.id, "admin");
    expect(repository.replaceSquadLoadoutAssignments("guild-assignments", alpha.id, [
      { userId: "member-a", roleName: "Medic" },
      { userId: "member-b", roleName: "Rifleman" },
    ])).toBe(true);
    expect(repository.listSquadLoadoutAssignments("guild-assignments", alpha.id)).toHaveLength(2);

    repository.assignMember("guild-assignments", "member-a", bravo.id, "admin");
    expect(repository.listSquadLoadoutAssignments("guild-assignments").map((item) => item.userId)).toEqual(["member-b"]);
    repository.unassignMember("guild-assignments", "member-b");
    expect(repository.listSquadLoadoutAssignments("guild-assignments")).toEqual([]);

    repository.assignMember("guild-assignments", "member-a", bravo.id, "admin");
    repository.replaceSquadLoadoutAssignments("guild-assignments", bravo.id, [{ userId: "member-a", roleName: "Leader" }]);
    expect(repository.clearSquadLoadoutAssignments("guild-assignments", bravo.id)).toBe(1);
  });

  it("tracks time spent on each assigned loadout role while squad voice is active", () => {
    const squad = repository.createSquad("guild-role-time", "Alpha", "admin");
    repository.assignMember("guild-role-time", "member-a", squad.id, "admin");
    repository.replaceSquadLoadoutAssignments("guild-role-time", squad.id, [{ userId: "member-a", roleName: "Engineer" }]);
    repository.beginVoiceActivity("guild-role-time", "member-a", squad.id, 1_000);
    expect(repository.getLoadoutRoleActivitySeconds("guild-role-time", "member-a", "Engineer", 1_120)).toBe(120);
    repository.endVoiceActivity("guild-role-time", "member-a", 1_300);
    expect(repository.getLoadoutRoleActivitySeconds("guild-role-time", "member-a", "Engineer", 2_000)).toBe(300);

    repository.beginVoiceActivity("guild-role-time", "member-a", squad.id, 2_000);
    repository.replaceSquadLoadoutAssignments("guild-role-time", squad.id, [{ userId: "member-a", roleName: "Medic" }]);
    repository.endVoiceActivity("guild-role-time", "member-a", 2_200);
    expect(repository.getLoadoutRoleActivitySeconds("guild-role-time", "member-a", "Engineer", 2_200)).toBeGreaterThanOrEqual(300);
    expect(repository.getLoadoutRoleActivitySeconds("guild-role-time", "member-a", "Medic", 2_200)).toBeGreaterThanOrEqual(0);
  });

  it("atomically stores named roster pages and priority roles", () => {
    repository.replaceRoleRosterSetup("guild-pages", "roster-channel", [
      { name: "Command", roles: [{ roleId: "commander", highPriority: true }] },
      { name: "Support", roles: [{ roleId: "medic", highPriority: false }] },
    ]);
    const pages = repository.listRoleRosterPages("guild-pages");
    expect(pages.map((page) => page.name)).toEqual(["Command", "Support"]);
    expect(repository.getGuildConfig("guild-pages").roleRosterChannelId).toBe("roster-channel");
    expect(repository.listTrackedRoles("guild-pages")).toEqual([
      expect.objectContaining({ roleId: "commander", pageId: pages[0]?.id, highPriority: true }),
      expect.objectContaining({ roleId: "medic", pageId: pages[1]?.id, highPriority: false }),
    ]);
  });

  it("adds, removes, moves, and reprioritizes live roster pages", () => {
    repository.addTrackedRole("guild-live-pages", "role-a");
    const first = repository.createRoleRosterPage("guild-live-pages", "First");
    const second = repository.createRoleRosterPage("guild-live-pages", "Second");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(repository.createRoleRosterPage("guild-live-pages", "first")).toBeNull();
    expect(repository.moveTrackedRoleToPage("guild-live-pages", "role-a", second!.id)).toBe(true);
    expect(repository.setTrackedRolePriority("guild-live-pages", "role-a", true)).toBe(true);
    expect(repository.listTrackedRoles("guild-live-pages")[0]).toMatchObject({ pageId: second!.id, highPriority: true });
    expect(repository.removeRoleRosterPage("guild-live-pages", second!.id)).toBe(true);
    expect(repository.listTrackedRoles("guild-live-pages")[0]?.pageId).toBe(first!.id);
    expect(repository.removeRoleRosterPage("guild-live-pages", first!.id)).toBe(false);
  });

  it("moves roster channels only when the expected publication is still current", () => {
    repository.replaceTrackedRoles("guild-replace", ["role-c", "role-a", "role-b"]);
    expect(repository.listTrackedRoles("guild-replace").map((role) => role.roleId)).toEqual([
      "role-c", "role-a", "role-b",
    ]);
    expect(repository.clearTrackedRoles("guild-replace")).toBe(3);
    expect(repository.clearTrackedRoles("guild-replace")).toBe(0);

    repository.setRoleRosterChannel("guild-1", "role-old");
    repository.setSquadRosterChannel("guild-1", "squad-old");

    expect(
      repository.moveRoleRosterChannelIfMatches("guild-1", "stale", "role-new"),
    ).toBe(false);
    expect(
      repository.moveRoleRosterChannelIfMatches("guild-1", "role-old", "role-new"),
    ).toBe(true);
    expect(
      repository.moveSquadRosterChannelIfMatches("guild-1", "squad-old", "squad-new"),
    ).toBe(true);
    expect(repository.getGuildConfig("guild-1")).toMatchObject({
      roleRosterChannelId: "role-new",
      squadRosterChannelId: "squad-new",
    });

    repository.setRoleRosterChannel("guild-2", null);
    expect(
      repository.moveRoleRosterChannelIfMatches("guild-2", null, "recovered-channel"),
    ).toBe(true);
    expect(repository.getGuildConfig("guild-2").roleRosterChannelId).toBe(
      "recovered-channel",
    );
  });

  it("atomically disables a publication and moves every page into cleanup", () => {
    repository.setSquadRosterChannel("guild-1", "squad-channel");
    for (const [ordinal, messageId] of ["page-1", "page-2"].entries()) {
      repository.upsertPublishedMessage({
        guildId: "guild-1",
        rosterType: "squad",
        ordinal,
        channelId: "squad-channel",
        messageId,
      });
    }

    expect(
      repository.deactivatePublication("guild-1", "squad", "wrong-channel"),
    ).toBeNull();
    expect(repository.listPublishedMessages("guild-1", "squad")).toHaveLength(2);

    expect(
      repository.deactivatePublication("guild-1", "squad", "squad-channel"),
    ).toBe(2);
    expect(repository.getGuildConfig("guild-1").squadRosterChannelId).toBeNull();
    expect(repository.listPublishedMessages("guild-1", "squad")).toEqual([]);
    expect(
      repository
        .listPublishedMessageCleanup("guild-1", "squad")
        .map((message) => message.messageId),
    ).toEqual(["page-1", "page-2"]);
  });

  it("recovers active rows left behind while a publication is disabled", () => {
    repository.setRoleRosterChannel("guild-1", null);
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "old-channel",
      messageId: "orphan-page",
    });

    expect(repository.queueDisabledPublishedMessagesForCleanup("guild-1", "role")).toBe(
      1,
    );
    expect(repository.listPublishedMessages("guild-1", "role")).toEqual([]);
    expect(repository.listPublishedMessageCleanup("guild-1", "role")).toEqual([
      expect.objectContaining({ messageId: "orphan-page" }),
    ]);

    repository.upsertPublishedMessage({
      guildId: "guild-2",
      rosterType: "squad",
      ordinal: 0,
      channelId: "failed-destination",
      messageId: "failed-move-page",
    });
    expect(repository.deactivatePublication("guild-2", "squad", null)).toBe(1);
    expect(repository.listPublishedMessages("guild-2", "squad")).toEqual([]);
  });

  it("enforces case-insensitive squad names", () => {
    const squad = repository.createSquad("guild-1", " Alpha ", "admin-1");
    expect(squad.name).toBe("Alpha");

    expect(() => repository.createSquad("guild-1", "ALPHA", "admin-1")).toThrow(
      DuplicateSquadNameError,
    );
  });

  it("moves a member atomically and cascades assignments on squad deletion", () => {
    const alpha = repository.createSquad("guild-1", "Alpha", "admin-1");
    const bravo = repository.createSquad("guild-1", "Bravo", "admin-1");

    expect(repository.assignMember("guild-1", "user-1", alpha.id, "leader-1")).toBe(true);
    expect(repository.assignMember("guild-1", "user-1", bravo.id, "leader-1")).toBe(true);
    expect(repository.listMemberships("guild-1")).toEqual([
      { guildId: "guild-1", userId: "user-1", squadId: bravo.id },
    ]);

    expect(repository.deleteSquad("guild-1", bravo.id)).toBe(true);
    expect(repository.listMemberships("guild-1")).toEqual([]);
  });

  it("upserts and orders published roster message IDs", () => {
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 1,
      channelId: "channel-1",
      messageId: "message-2",
    });
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "channel-1",
      messageId: "message-1",
    });
    repository.upsertPublishedMessage({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "channel-2",
      messageId: "replacement",
    });

    expect(repository.listPublishedMessages("guild-1", "role")).toEqual([
      {
        guildId: "guild-1",
        rosterType: "role",
        ordinal: 0,
        channelId: "channel-2",
        messageId: "replacement",
      },
      {
        guildId: "guild-1",
        rosterType: "role",
        ordinal: 1,
        channelId: "channel-1",
        messageId: "message-2",
      },
    ]);

    expect(repository.getPublishedMessageById("guild-1", "replacement")).toEqual({
      guildId: "guild-1",
      rosterType: "role",
      ordinal: 0,
      channelId: "channel-2",
      messageId: "replacement",
    });
    expect(repository.getPublishedMessageById("guild-2", "replacement")).toBeNull();
    expect(repository.getPublishedMessageById("guild-1", "unknown-message")).toBeNull();
  });
});
