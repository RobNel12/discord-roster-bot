import { afterEach, expect, it, vi } from "vitest";
import { ChannelType, Collection, OverwriteType, PermissionsBitField, PermissionFlagsBits, type Guild, type VoiceState } from "discord.js";
import { RosterRepository } from "../src/database.js";
import { TemporaryVoiceService } from "../src/temporary-voice.js";
import type { RosterScheduler } from "../src/scheduler.js";

let repository: RosterRepository;
afterEach(() => repository.close());
function fixture() {
  repository = new RosterRepository(":memory:");
  const squad = repository.createSquad("g", "Alpha", "admin");
  repository.assignMember("g", "one", squad.id, "admin");
  const cache = new Collection<string, { allow: PermissionsBitField; deny: PermissionsBitField }>();
  cache.set("one", { allow: new PermissionsBitField(PermissionFlagsBits.Speak), deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel) });
  const edit = vi.fn(async (id: string, changes: Record<string, boolean | null>) => {
    const value = cache.get(id) ?? { allow: new PermissionsBitField(), deny: new PermissionsBitField() };
    for (const [name, enabled] of Object.entries(changes)) {
      const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
      value.allow.remove(flag); value.deny.remove(flag);
      if (enabled === true) value.allow.add(flag);
      if (enabled === false) value.deny.add(flag);
    }
    cache.set(id, value);
  });
  const channel = { id: "voice", type: ChannelType.GuildVoice, permissionOverwrites: { cache, edit }, delete: vi.fn(async () => undefined) };
  const guild = { id: "g", channels: { fetch: vi.fn(async () => channel), create: vi.fn(async () => channel) } };
  Object.assign(channel, { guild });
  const service = new TemporaryVoiceService(repository, { schedule: vi.fn() } as unknown as RosterScheduler);
  return { squad, channel, guild: guild as unknown as Guild, service, edit, cache };
}

it("grants current squad members access and restores prior permissions on departure", async () => {
  const f = fixture();
  repository.upsertTemporaryVoiceChannel("g", "voice", "one", f.squad.id);
  await f.service.syncGuildPermissions(f.guild);
  expect(f.edit).toHaveBeenCalledWith("one", { ViewChannel: true, Connect: true }, expect.objectContaining({ type: OverwriteType.Member }));
  expect(f.cache.get("one")?.allow.has(PermissionFlagsBits.Speak)).toBe(true);
  f.edit.mockClear();
  await f.service.syncGuildPermissions(f.guild);
  expect(f.edit).not.toHaveBeenCalled();
  repository.assignMember("g", "two", f.squad.id, "admin");
  repository.unassignMember("g", "one");
  await f.service.syncGuildPermissions(f.guild);
  expect(f.edit).toHaveBeenCalledWith("one", { ViewChannel: false, Connect: null }, expect.anything());
  expect(f.edit).toHaveBeenCalledWith("two", { ViewChannel: true, Connect: true }, expect.anything());
  expect(f.cache.get("one")?.allow.has(PermissionFlagsBits.Speak)).toBe(true);
  expect(repository.listVoiceAccessGrants("g", "voice").map(g => g.userId)).toEqual(["two"]);
});

it("sets access for the full squad before moving the creator into a new channel", async () => {
  const f = fixture();
  repository.setTemporaryVoiceLobbyChannel("g", "lobby");
  repository.assignMember("g", "two", f.squad.id, "admin");
  const setChannel = vi.fn(async () => {
    expect(f.cache.get("one")?.allow.has(PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(f.cache.get("two")?.allow.has(PermissionFlagsBits.Connect)).toBe(true);
  });
  const state = { guild: f.guild, channelId: "lobby", channel: { id: "lobby", parentId: "category" }, member: { id: "one", user: { bot: false, tag: "One" }, voice: { setChannel } } } as unknown as VoiceState;
  await f.service.handleVoiceStateUpdate({ guild: f.guild, channelId: null } as VoiceState, state);
  expect(setChannel).toHaveBeenCalledOnce();
  expect(repository.getTemporaryVoiceChannelForSquad("g", f.squad.id)?.channelId).toBe("voice");
});

it.each([false, true])("continues joining when permission editing fails (existing channel: %s)", async (existing) => {
  const f = fixture();
  repository.setTemporaryVoiceLobbyChannel("g", "lobby");
  if (existing) repository.upsertTemporaryVoiceChannel("g", "voice", "one", f.squad.id);
  f.edit.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const setChannel = vi.fn(async () => undefined);
    const state = { guild: f.guild, channelId: "lobby", channel: { id: "lobby", parentId: "category" }, member: { id: "one", user: { bot: false, tag: "One" }, voice: { setChannel } } } as unknown as VoiceState;
    await f.service.handleVoiceStateUpdate({ guild: f.guild, channelId: null } as VoiceState, state);
    expect(setChannel).toHaveBeenCalledOnce();
    expect(f.channel.delete).not.toHaveBeenCalled();
    expect(repository.getTemporaryVoiceChannelForSquad("g", f.squad.id)?.channelId).toBe("voice");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Manage Permissions"), expect.any(Error));
    // Keeping the channel tracked lets reconciliation repair access later.
    f.edit.mockReset();
    f.edit.mockResolvedValue(undefined);
    await f.service.syncGuildPermissions(f.guild);
    expect(f.edit).toHaveBeenCalledWith("one", { ViewChannel: true, Connect: true }, expect.anything());
  } finally { warning.mockRestore(); }
});
