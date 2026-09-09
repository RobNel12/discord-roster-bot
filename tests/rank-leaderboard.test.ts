import { afterEach, expect, it, vi } from "vitest";
import { Collection, MessageFlags, type Guild, type GuildMember, type ChatInputCommandInteraction, type VoiceState } from "discord.js";
import { RosterRepository } from "../src/database.js";
import { rankLeaderboard } from "../src/rank-leaderboard.js";
import { handleChatInputCommand } from "../src/commands.js";
import { TemporaryVoiceService } from "../src/temporary-voice.js";
import type { RosterScheduler } from "../src/scheduler.js";

let repo: RosterRepository;
afterEach(() => { repo.close(); vi.useRealTimers(); });
function setup() {
  repo = new RosterRepository(":memory:");
  const members = new Collection<string, GuildMember>();
  const member = (id: string, officer = false, bot = false) => ({ id, user: { bot }, permissions: { has: () => false }, roles: { cache: { has: () => officer } }, send: vi.fn() }) as unknown as GuildMember;
  members.set("a", member("a")); members.set("b", member("b")); members.set("c", member("c", true)); members.set("bot", member("bot", false, true));
  const guild = { id: "g", ownerId: "owner", members: { cache: members, fetch: vi.fn(async (id: string) => members.get(id)) }, channels: { fetch: vi.fn() } } as unknown as Guild;
  repo.setSquadLeaderRole("g", "officers");
  return { guild, members };
}

it("orders by rank then live track time, supports tracks and excludes bots/departed members", () => {
  const { guild } = setup();
  repo.setVoiceActivitySeconds("g", "a", 3600);
  repo.setVoiceActivitySeconds("g", "b", 3600);
  repo.beginVoiceActivity("g", "b", 1, Math.floor(Date.now() / 1000) - 30);
  repo.setVoiceActivitySeconds("g", "departed", 1000000);
  repo.setVoiceActivitySeconds("other", "a", 1000000);
  expect(rankLeaderboard(guild, repo).map(entry => entry.id)).toEqual(["c", "b", "a"]);
  expect(rankLeaderboard(guild, repo, "enlisted").map(entry => entry.id)).toEqual(["b", "a"]);
  expect(rankLeaderboard(guild, repo, "officer").map(entry => entry.rank)).toEqual(["2LT"]);
  repo.setManualRank("g", "a", "SMA");
  expect(rankLeaderboard(guild, repo, "enlisted")[0]?.id).toBe("a");
});

it("responds privately with bounded leaderboard pages", async () => {
  const { guild, members } = setup();
  for (let i = 0; i < 20; i++) members.set(`member-${i}`, { ...members.get("a"), id: `member-${i}` } as GuildMember);
  const interaction = { inGuild: () => true, guild, commandName: "squad", options: { getSubcommand: () => "leaderboard", getString: () => "enlisted", getInteger: () => 2 }, deferReply: vi.fn(), editReply: vi.fn() };
  await handleChatInputCommand(interaction as unknown as ChatInputCommandInteraction, { repository: repo, scheduler: {} as RosterScheduler });
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  const payload = interaction.editReply.mock.calls[0]![0];
  expect(payload.content).toContain("Page 2/3");
  expect(payload.content.match(/<@/g)).toHaveLength(10);
  expect(payload.allowedMentions).toEqual({ parse: [] });
});

it("advances rank silently and still refreshes the roster at the threshold", async () => {
  vi.useFakeTimers();
  const { guild, members } = setup();
  const squad = repo.createSquad("g", "Alpha", "admin");
  repo.assignMember("g", "a", squad.id, "admin");
  repo.upsertTemporaryVoiceChannel("g", "voice", "a", squad.id);
  repo.setVoiceActivitySeconds("g", "a", 3599);
  repo.setRankUpdateChannel("g", "old-announcement-channel");
  const scheduler = { schedule: vi.fn() };
  const service = new TemporaryVoiceService(repo, scheduler as unknown as RosterScheduler);
  const before = { guild, channelId: null } as VoiceState;
  const after = { guild, channelId: "voice", member: members.get("a") } as VoiceState;
  await service.handleVoiceStateUpdate(before, after);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.schedule).toHaveBeenCalledWith("g", "squad");
  expect(rankLeaderboard(guild, repo).find(entry => entry.id === "a")?.rank).toBe("PV2");
  expect(guild.channels.fetch).not.toHaveBeenCalled();
  expect(members.get("a")!.send).not.toHaveBeenCalled();
  service.stop();
});
