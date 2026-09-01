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
