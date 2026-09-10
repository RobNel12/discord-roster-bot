import type {
  ButtonInteraction,
  Guild,
  StringSelectMenuInteraction,
} from "discord.js";
import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosterRepository } from "../src/database.js";
import type { RosterScheduler } from "../src/scheduler.js";
import {
  handleSquadComponentInteraction,
  type SquadInteractionContext,
} from "../src/squad-interactions.js";
import {
  SQUAD_JOIN_CUSTOM_ID_PREFIX,
  SQUAD_CALL_CUSTOM_ID,
  SQUAD_LEAVE_CUSTOM_ID,
} from "../src/squad-components.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "squad-channel";
const MESSAGE_ID = "squad-roster-message";
const BOT_ID = "bot-user";
const USER_ID = "member-1";

type SquadInteraction = ButtonInteraction | StringSelectMenuInteraction;

interface InteractionMock {
  interaction: SquadInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
}

describe("squad component interactions", () => {
  let repository: RosterRepository;
  let guild: Guild;
  let schedule: ReturnType<typeof vi.fn>;
  let context: SquadInteractionContext;

  beforeEach(() => {
    repository = new RosterRepository(":memory:");
    repository.setSquadRosterChannel(GUILD_ID, CHANNEL_ID);
    repository.upsertPublishedMessage({
      guildId: GUILD_ID,
      rosterType: "squad",
      ordinal: 0,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    });
    guild = {
      id: GUILD_ID,
      members: {
        fetch: vi.fn(async (userId: string) => ({
          id: userId,
          user: { bot: false },
        })),
      },
      channels: { fetch: vi.fn(async () => null) },
    } as unknown as Guild;
    schedule = vi.fn();
    context = {
      repository,
      scheduler: { schedule } as unknown as RosterScheduler,
    };
  });

  afterEach(() => {
    repository.close();
  });

  it.each([
    ["join", false, false],
    ["move into locked squad", false, false],
    ["move out", true, false],
    ["move between locked squads", false, true],
    ["leave", true, false],
  ] as const)("handles %s with an entry-only lock", async (action, allowed, lockDestination) => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    const bravo = repository.createSquad(GUILD_ID, "Bravo", "admin");
    const initial = action === "join" ? undefined : action === "move into locked squad" ? bravo.id : alpha.id;
    if (initial) repository.assignMember(GUILD_ID, USER_ID, initial, "admin");
    for (const squadId of lockDestination ? [alpha.id, bravo.id] : [alpha.id]) {
      repository.saveSummonsPost({ id: `lock-${squadId}`, guildId: GUILD_ID, channelId: "calls", messageIds: [], kind: "summons", title: "Squad", squadId, memberIds: [], ready: {}, phase: "ready", squadLocked: true });
    }
    const destination = action === "join" || action === "move into locked squad" ? alpha.id : bravo.id;
    const mock = action === "leave" ? interactionMock("leave", guild) : joinInteraction(guild, String(destination));
    await handleSquadComponentInteraction(mock.interaction, context);
    expect(repository.getMembership(GUILD_ID, USER_ID)?.squadId).toBe(allowed ? action === "leave" ? undefined : destination : initial);
    if (allowed) expect(schedule).toHaveBeenCalledWith(GUILD_ID, "squad");
    else {
      expect(schedule).not.toHaveBeenCalled();
      expect(JSON.stringify(mock.editReply.mock.calls)).toContain("locked to new members");
    }
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "admin");
    expect(repository.getMembership(GUILD_ID, USER_ID)?.squadId).toBe(alpha.id);
  });

  it("joins a squad from the select menu", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    const mock = joinInteraction(guild, String(alpha.id));

    await expect(handleSquadComponentInteraction(mock.interaction, context)).resolves.toBe(
      true,
    );

    expect(repository.getMembership(GUILD_ID, USER_ID)).toEqual({
      guildId: GUILD_ID,
      userId: USER_ID,
      squadId: alpha.id,
    });
    expect(repository.listMemberships(GUILD_ID)).toHaveLength(1);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(GUILD_ID, "squad");
    expect(lastReply(mock)).toContain("You joined **Alpha**");
  });

  it("allows conscripts to join squads and rejects users outside both access roles", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    repository.setRosterAccessRoles(GUILD_ID, "member-role", "conscript-role");
    (guild.members.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: USER_ID,
      user: { bot: false },
      roles: { cache: { has: (roleId: string) => roleId === "conscript-role" } },
    });
    await handleSquadComponentInteraction(joinInteraction(guild, String(alpha.id)).interaction, context);
    expect(repository.getMembership(GUILD_ID, USER_ID)?.squadId).toBe(alpha.id);

    repository.unassignMember(GUILD_ID, USER_ID);
    (guild.members.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: USER_ID,
      user: { bot: false },
      roles: { cache: { has: () => false } },
    });
    const rejected = joinInteraction(guild, String(alpha.id));
    await handleSquadComponentInteraction(rejected.interaction, context);
    expect(repository.getMembership(GUILD_ID, USER_ID)).toBeNull();
    expect(lastReply(rejected)).toContain("Member or Conscript role");
  });

  it("moves between squads while preserving exactly one membership", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    const bravo = repository.createSquad(GUILD_ID, "Bravo", "admin");
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "leader");
    const mock = joinInteraction(guild, String(bravo.id));

    await handleSquadComponentInteraction(mock.interaction, context);

    expect(repository.listMemberships(GUILD_ID)).toEqual([
      { guildId: GUILD_ID, userId: USER_ID, squadId: bravo.id },
    ]);
    expect(lastReply(mock)).toContain("Any previous squad assignment was replaced");
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("treats joining the current squad as a no-op", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "leader");
    const mock = joinInteraction(guild, String(alpha.id));

    await handleSquadComponentInteraction(mock.interaction, context);

    expect(repository.listMemberships(GUILD_ID)).toEqual([
      { guildId: GUILD_ID, userId: USER_ID, squadId: alpha.id },
    ]);
    expect(schedule).not.toHaveBeenCalled();
    expect(lastReply(mock)).toContain("already assigned to **Alpha**");
  });

  it("leaves a squad and treats leaving again as a no-op", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "leader");

    const first = leaveInteraction(guild);
    await handleSquadComponentInteraction(first.interaction, context);
    expect(repository.getMembership(GUILD_ID, USER_ID)).toBeNull();
    expect(schedule).toHaveBeenCalledOnce();
    expect(lastReply(first)).toContain("now Unassigned");

    const second = leaveInteraction(guild);
    await handleSquadComponentInteraction(second.interaction, context);
    expect(repository.getMembership(GUILD_ID, USER_ID)).toBeNull();
    expect(schedule).toHaveBeenCalledOnce();
    expect(lastReply(second)).toContain("already Unassigned");
  });

  it("lets an assigned squad manager publicly call the other squad members", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    repository.setSquadLeaderRole(GUILD_ID, "leader-role");
    repository.setSquadCallChannel(GUILD_ID, "calls-channel");
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "admin");
    repository.assignMember(GUILD_ID, "member-2", alpha.id, "admin");
    repository.assignMember(GUILD_ID, "member-3", alpha.id, "admin");
    (guild.members.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: USER_ID,
      user: { bot: false },
      permissions: { has: () => false },
      roles: { cache: { has: (roleId: string) => roleId === "leader-role" } },
    });
    const send = vi.fn(async (_payload: unknown) => ({ id: "summons-1", react: vi.fn() }));
    (guild.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "calls-channel",
      isTextBased: () => true,
      type: ChannelType.GuildText,
      send,
    });
    const mock = interactionMock("call", guild);

    await handleSquadComponentInteraction(mock.interaction, context);

    expect(mock.deferReply).toHaveBeenCalledWith({ flags: expect.anything() });
    const payload = send.mock.calls[0]?.[0] as { content: string; embeds: Array<{ toJSON(): { title?: string; fields?: Array<{ value: string }> } }>; allowedMentions: unknown };
    expect(payload.content).toBe("");
    expect(payload.embeds[0]?.toJSON().title).toContain("Alpha, form up");
    const roster = payload.embeds[0]?.toJSON().fields?.map(field => field.value).join("\n");
    expect(roster).toContain("<@member-2>");
    expect(roster).toContain("<@member-3>");
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ allowedMentions: { users: [USER_ID, "member-2", "member-3"] } });
    expect(repository.getSummonsPosts(GUILD_ID)[0]?.messageIds).toEqual(["summons-1"]);
  });

  it.each([
    ["stale channel", { channelId: "old-squad-channel" }],
    ["stale message", { messageId: "old-squad-message" }],
    ["message not authored by this bot", { authorId: "different-bot" }],
  ])("rejects a %s panel without changing membership", async (_label, overrides) => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    const mock = joinInteraction(guild, String(alpha.id), overrides);

    await handleSquadComponentInteraction(mock.interaction, context);

    expect(repository.getMembership(GUILD_ID, USER_ID)).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
    expect(lastReply(mock)).toContain("panel is no longer active");
  });

  it("does not replace an assignment when the selected squad no longer exists", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    repository.assignMember(GUILD_ID, USER_ID, alpha.id, "leader");
    const mock = joinInteraction(guild, "999999");

    await handleSquadComponentInteraction(mock.interaction, context);

    expect(repository.listMemberships(GUILD_ID)).toEqual([
      { guildId: GUILD_ID, userId: USER_ID, squadId: alpha.id },
    ]);
    expect(schedule).toHaveBeenCalledWith(GUILD_ID, "squad");
    expect(lastReply(mock)).toContain("squad no longer exists");
  });

  it("ignores an obsolete unversioned join control", async () => {
    const alpha = repository.createSquad(GUILD_ID, "Alpha", "admin");
    const mock = joinInteraction(guild, String(alpha.id), { customId: "squad:join:0" });

    await expect(handleSquadComponentInteraction(mock.interaction, context)).resolves.toBe(
      false,
    );

    expect(mock.deferReply).not.toHaveBeenCalled();
    expect(mock.editReply).not.toHaveBeenCalled();
    expect(repository.getMembership(GUILD_ID, USER_ID)).toBeNull();
  });
});

function joinInteraction(
  guild: Guild,
  selectedSquadId: string,
  overrides: {
    customId?: string;
    channelId?: string;
    messageId?: string;
    authorId?: string;
  } = {},
): InteractionMock {
  return interactionMock("join", guild, {
    ...overrides,
    values: [selectedSquadId],
  });
}

function leaveInteraction(guild: Guild): InteractionMock {
  return interactionMock("leave", guild);
}

function interactionMock(
  kind: "join" | "leave" | "call",
  guild: Guild,
  overrides: {
    customId?: string;
    channelId?: string;
    messageId?: string;
    authorId?: string;
    values?: string[];
  } = {},
): InteractionMock {
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const interaction = {
    customId:
      overrides.customId ??
      (kind === "join" ? `${SQUAD_JOIN_CUSTOM_ID_PREFIX}0` : kind === "call" ? SQUAD_CALL_CUSTOM_ID : SQUAD_LEAVE_CUSTOM_ID),
    channelId: overrides.channelId ?? CHANNEL_ID,
    guildId: GUILD_ID,
    guild,
    client: { user: { id: BOT_ID } },
    message: {
      id: overrides.messageId ?? MESSAGE_ID,
      author: { id: overrides.authorId ?? BOT_ID },
    },
    user: { id: USER_ID },
    values: overrides.values ?? [],
    isStringSelectMenu: () => kind === "join",
    isButton: () => kind === "leave" || kind === "call",
    inGuild: () => true,
    deferReply,
    editReply,
    followUp,
    reply: vi.fn(async () => undefined),
  } as unknown as SquadInteraction;
  return { interaction, deferReply, editReply, followUp };
}

function lastReply(mock: InteractionMock): string {
  const payload = mock.editReply.mock.calls.at(-1)?.[0] as { content?: unknown } | undefined;
  expect(payload).toMatchObject({ allowedMentions: { parse: [] } });
  return String(payload?.content);
}
