import { afterEach, describe, expect, it, vi } from "vitest";
import type { Guild, Interaction, MessageReaction, User } from "discord.js";
import { ChannelType } from "discord.js";
import { RosterRepository } from "../src/database.js";
import { handleOperationInteraction, handleReadyReaction, renderOperation, renderSummons, reconcileOperations, serializeOperation } from "../src/operations.js";
import type { OperationPost } from "../src/operation-types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositories: RosterRepository[] = [];
afterEach(() => { for (const r of repositories.splice(0)) r.close(); });
function fixture() {
  const repository = new RosterRepository(":memory:"); repositories.push(repository);
  const squad = repository.createSquad("g", "Alpha", "manager");
  repository.assignMember("g", "member", squad.id, "manager");
  const post: OperationPost = { id: "post", guildId: "g", channelId: "c", messageIds: ["m"], kind: "summons", title: "Alpha", description: "", startsAt: null, squadId: squad.id, memberIds: ["member"], responses: {}, ready: {}, phase: "ready" };
  repository.saveOperationPost(post);
  const message = { id: "m", edit: vi.fn(async (_payload: unknown) => undefined), react: vi.fn() };
  const guild = { id: "g", members: { fetch: vi.fn(async (id: string) => ({ id, permissions: { has: () => id === "manager" }, roles: { cache: { has: () => false } } })) }, channels: { fetch: vi.fn(async () => ({ type: ChannelType.GuildText, messages: { fetch: vi.fn(async () => message) } })) } } as unknown as Guild;
  const reaction = (emoji: string) => ({ emoji: { name: emoji }, message: { id: "m", channelId: "c", guild }, users: { remove: vi.fn(async () => undefined) } }) as unknown as MessageReaction;
  const click = (userId: string, action: string) => ({ isButton: () => true, isChatInputCommand: () => false, customId: `op:post:${action}`, guild, channelId: "c", message: { id: "m" }, user: { id: userId }, deferReply: vi.fn(), editReply: vi.fn() });
  return { repository, post, guild, reaction, click, message };
}

describe("operations and summons", () => {
  it("restricts locking to managers, persists it, and releases it on close", async () => {
    const f = fixture();
    await handleOperationInteraction(f.click("member", "lock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(false);
    await handleOperationInteraction(f.click("manager", "lock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(true);
    expect(f.repository.isSquadLocked("other", f.post.squadId!)).toBe(false);
    expect(f.message.edit).toHaveBeenLastCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    await handleReadyReaction(f.reaction("✅"), { id: "member" } as User, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.ready.member).toBe(true);
    await handleOperationInteraction(f.click("manager", "unlock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(false);
    await handleOperationInteraction(f.click("manager", "lock") as unknown as Interaction, f.repository);
    await handleOperationInteraction(f.click("manager", "close") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(false);
    await handleOperationInteraction(f.click("manager", "lock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(false);
  });

  it("allows squad-role managers to lock only their own squad", async () => {
    const f = fixture();
    f.repository.setSquadLeaderRole("g", "leader");
    vi.mocked(f.guild.members.fetch).mockResolvedValue({ id: "leader-user", permissions: { has: () => false }, roles: { cache: { has: (id: string) => id === "leader" } } } as never);
    await handleOperationInteraction(f.click("leader-user", "lock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(false);
    f.repository.assignMember("g", "leader-user", f.post.squadId!, "manager");
    await handleOperationInteraction(f.click("leader-user", "lock") as unknown as Interaction, f.repository);
    expect(f.repository.isSquadLocked("g", f.post.squadId!)).toBe(true);
  });

  it("renders squad-style embeds with ranks, loadouts, readiness and safe pagination", () => {
    const f = fixture();
    f.repository.replaceSquadLoadoutAssignments("g", f.post.squadId!, [{ userId: "member", roleName: "Medic" }]);
    f.post.ready.member = true;
    const embed = renderSummons(f.guild, f.repository, f.post)[0]!.toJSON();
    expect(embed.color).toBe(0xfe_a5_1d);
    expect(embed.fields?.[0]?.name).toBe("Alpha — 1");
    expect(embed.fields?.[0]?.value).toContain("• <@member> — **Pvt.** · **Medic** — ✅ Ready");
    f.post.memberIds = Array.from({ length: 500 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const pages = renderSummons(f.guild, f.repository, f.post).map(e => e.toJSON());
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.fields!.length).toBeLessThanOrEqual(25);
      expect(page.fields!.every(field => field.value.length <= 1024)).toBe(true);
      const length = (page.title?.length ?? 0) + (page.description?.length ?? 0) + (page.footer?.text.length ?? 0) + page.fields!.reduce((n, field) => n + field.name.length + field.value.length, 0);
      expect(length).toBeLessThanOrEqual(6000);
    }
    for (const id of f.post.memberIds) expect(JSON.stringify(pages)).toContain(`<@${id}>`);
  });

  it("refreshes open summons membership without another ping and preserves existing readiness", async () => {
    const f = fixture();
    f.post.ready.member = true; f.repository.saveOperationPost(f.post);
    f.repository.assignMember("g", "new-member", f.post.squadId!, "manager");
    await reconcileOperations(f.guild, f.repository);
    expect(f.repository.getOperationPosts("g")[0]).toMatchObject({ memberIds: ["member", "new-member"], ready: { member: true } });
    const payload = f.message.edit.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({ content: "", allowedMentions: { parse: [] } });
    expect(JSON.stringify(payload)).toContain("<@new-member>");
    expect(JSON.stringify(payload)).toContain("❌ Not ready");
    f.repository.unassignMember("g", "member");
    await reconcileOperations(f.guild, f.repository);
    expect(f.repository.getOperationPosts("g")[0]).toMatchObject({ memberIds: ["new-member"], ready: {} });
    await handleOperationInteraction(f.click("manager", "close") as unknown as Interaction, f.repository);
    f.repository.assignMember("g", "later", f.post.squadId!, "manager");
    await reconcileOperations(f.guild, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.memberIds).toEqual(["new-member"]);
  });

  it("accepts latest readiness only from current summoned squad members and freezes on close", async () => {
    const f = fixture();
    await handleReadyReaction(f.reaction("✅"), { id: "outsider" } as User, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.ready).toEqual({});
    await handleReadyReaction(f.reaction("✅"), { id: "member" } as User, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.ready.member).toBe(true);
    await handleReadyReaction(f.reaction("❌"), { id: "member" } as User, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.ready.member).toBe(false);
    await handleOperationInteraction(f.click("member", "close") as unknown as Interaction, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.phase).toBe("ready");
    await handleOperationInteraction(f.click("manager", "close") as unknown as Interaction, f.repository);
    await handleReadyReaction(f.reaction("✅"), { id: "member" } as User, f.repository);
    expect(f.repository.getOperationPosts("g")[0]).toMatchObject({ phase: "closed", ready: { member: false } });
    expect(f.message.edit).toHaveBeenLastCalledWith(expect.objectContaining({ components: [] }));
  });

  it("supports changing sign-ups and a manager-started ready check", async () => {
    const f = fixture(); f.post.kind = "operation"; f.post.phase = "signup"; f.repository.saveOperationPost(f.post);
    for (const action of ["going", "maybe"]) await handleOperationInteraction(f.click("member", action) as unknown as Interaction, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.responses.member).toBe("maybe");
    await handleOperationInteraction(f.click("member", "start") as unknown as Interaction, f.repository);
    expect(f.repository.getOperationPosts("g")[0]?.phase).toBe("signup");
    await handleOperationInteraction(f.click("manager", "start") as unknown as Interaction, f.repository);
    await handleReadyReaction(f.reaction("✅"), { id: "member" } as User, f.repository);
    await handleOperationInteraction(f.click("member", "unavailable") as unknown as Interaction, f.repository);
    expect(f.repository.getOperationPosts("g")[0]).toMatchObject({ phase: "ready", responses: { member: "maybe" }, ready: { member: true } });
  });

  it("rejects stale messages and members who have left the squad", async () => {
    const f = fixture(); f.repository.unassignMember("g", "member");
    await handleReadyReaction(f.reaction("✅"), { id: "member" } as User, f.repository);
    const click = f.click("manager", "close"); click.message.id = "old";
    await handleOperationInteraction(click as unknown as Interaction, f.repository);
    expect(f.repository.getOperationPosts("g")[0]).toMatchObject({ phase: "ready", ready: {} });
  });

  it("paginates without losing members or exceeding message limits", () => {
    const f = fixture(); f.post.memberIds = Array.from({ length: 500 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const pages = renderOperation(f.post);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(p => p.length <= 2000)).toBe(true);
    for (const id of f.post.memberIds) expect(pages.join("\n")).toContain(`<@${id}>`);
  });

  it("persists responses across reopening and isolates servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "operations-"));
    try {
      const post = fixture().post; post.squadLocked = true;
      const first = new RosterRepository(join(dir, "test.sqlite")); first.saveOperationPost(post); first.close();
      const second = new RosterRepository(join(dir, "test.sqlite"));
      expect(second.isSquadLocked("g", post.squadId!)).toBe(true);
      expect(second.getOperationPosts("g")).toEqual([post]); expect(second.getOperationPosts("other")).toEqual([]); second.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("serializes concurrent mutations even after a failed action", async () => {
    const order: number[] = [];
    await Promise.allSettled([
      serializeOperation("test", async () => { await Promise.resolve(); order.push(1); throw new Error("failure"); }),
      serializeOperation("test", async () => { order.push(2); }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
