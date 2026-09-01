import type {
  ButtonInteraction,
  Guild,
  StringSelectMenuInteraction,
} from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosterRepository } from "../src/database.js";
import type { RosterScheduler } from "../src/scheduler.js";
import {
  handleSquadComponentInteraction,
  type SquadInteractionContext,
} from "../src/squad-interactions.js";
import {
  SQUAD_JOIN_CUSTOM_ID_PREFIX,
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
  kind: "join" | "leave",
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
  const interaction = {
    customId:
      overrides.customId ??
      (kind === "join" ? `${SQUAD_JOIN_CUSTOM_ID_PREFIX}0` : SQUAD_LEAVE_CUSTOM_ID),
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
    isButton: () => kind === "leave",
    inGuild: () => true,
    deferReply,
    editReply,
    reply: vi.fn(async () => undefined),
  } as unknown as SquadInteraction;
  return { interaction, deferReply, editReply };
}

function lastReply(mock: InteractionMock): string {
  const payload = mock.editReply.mock.calls.at(-1)?.[0] as { content?: unknown } | undefined;
  expect(payload).toMatchObject({ allowedMentions: { parse: [] } });
  return String(payload?.content);
}
