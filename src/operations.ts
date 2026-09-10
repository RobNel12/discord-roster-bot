import type { RosterScheduler } from "./scheduler.js";
import { rankForSeconds, officerRankForSeconds } from "./ranks.js";
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, type Guild, type Interaction, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";
import type { RosterRepository } from "./database.js";
import type { SummonsPost } from "./operation-types.js";
import { buildRosterEmbeds, memberLine } from "./rosters/format.js";

export class SummonsError extends Error {}

const queues = new Map<string, Promise<unknown>>();
export async function serializeSummons<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

export function renderSummons(guild: Guild, repository: RosterRepository, post: SummonsPost) {
  const squad = post.squadId === null ? null : repository.getSquad(post.guildId, post.squadId);
  const loadouts = new Map(repository.listSquadLoadoutAssignments(post.guildId, post.squadId ?? -1).map(a => [a.userId, a.roleName]));
  const ids = [...post.memberIds].sort((a, b) => {
    const left = guild.members.cache?.get(a)?.displayName ?? a;
    const right = guild.members.cache?.get(b)?.displayName ?? b;
    return left.localeCompare(right, "en", { sensitivity: "base", numeric: true }) || a.localeCompare(b);
  });
  const readyCount = ids.filter(id => post.ready[id]).length;
  return buildRosterEmbeds({
    title: post.title,
    color: 0xfe_a5_1d,
    description: `${post.phase === "closed" ? "Closed — responses frozen" : "React ✅ or ❌ to change your readiness. Your latest reaction wins."}
${readyCount}/${ids.length} ready · ${post.phase !== "closed" && post.squadLocked ? "🔒" : "🔓"}`,
    emptyText: "No squad members were summoned.",
    sections: [{ name: `${squad?.name ?? "Summoned squad"} — ${ids.length}`, lines: ids.map(id => {
      const state = repository.getMemberRankState(post.guildId, id);
      const seconds = repository.getVoiceActivitySeconds(post.guildId, id);
      const member = guild.members.cache?.get(id);
      const general = id === guild.ownerId || Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild));
      const rank = state.manualRank ?? (state.rankTrack === "officer" ? officerRankForSeconds(seconds, general) : rankForSeconds(seconds));
      return `${memberLine({ id }, rank, loadouts.get(id))} — ${post.ready[id] ? "✅ Ready" : "❌ Not ready"}`;
    }) }],
  });
}

function controls(post: SummonsPost) {
  if (post.phase === "closed") return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  const add = (action: string, label: string, style = ButtonStyle.Secondary) => row.addComponents(new ButtonBuilder().setCustomId(`op:${post.id}:${action}`).setLabel(label).setStyle(style));
  row.addComponents(new ButtonBuilder()
    .setCustomId(`op:${post.id}:${post.squadLocked ? "unlock" : "lock"}`)
    .setEmoji(post.squadLocked ? "🔒" : "🔓")
    .setStyle(ButtonStyle.Primary));
  add("close", "Close squad summons", ButtonStyle.Danger);
  return [row];
}

export async function publishSummons(guild: Guild, repository: RosterRepository, post: SummonsPost): Promise<void> {
  const channel = await guild.channels.fetch(post.channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) throw new Error("The summons channel is unavailable.");
  if (post.phase !== "closed") {
    const squad = post.squadId === null ? null : repository.getSquad(post.guildId, post.squadId);
    if (squad) post.title = `${squad.name}, form up!`;
    post.memberIds = repository.listMemberships(post.guildId).filter(m => m.squadId === post.squadId).map(m => m.userId);
    const current = new Set(post.memberIds);
    for (const userId of Object.keys(post.ready)) if (!current.has(userId)) delete post.ready[userId];
    repository.saveSummonsPost(post);
  }
  const embeds = renderSummons(guild, repository, post);
  const pages = embeds.map(() => "");
  for (let i = 0; i < pages.length; i++) {
    const payload = { content: pages[i]!, embeds: embeds[i] ? [embeds[i]!] : [], components: controls(post), allowedMentions: { parse: [] as never[] } };
    const id = post.messageIds[i];
    let message;
    if (id) {
      message = await channel.messages.fetch(id).catch((error: unknown) => {
        if ((error as { code?: number }).code === 10008) return null;
        throw error;
      });
    }
    if (message) await message.edit(payload);
    else {
      message = await channel.send(payload);
      post.messageIds[i] = message.id;
      repository.saveSummonsPost(post);
    }
    if (post.phase === "ready") { await message.react("✅"); await message.react("❌"); }
  }
  for (const id of post.messageIds.slice(pages.length)) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) await message.edit({ content: "This page is no longer needed. Use the first page.", embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  post.messageIds = post.messageIds.slice(0, pages.length);
  repository.saveSummonsPost(post);
}

export async function createSummons(guild: Guild, repository: RosterRepository, squadId: number, channelId: string, callerId: string): Promise<void> {
  await serializeSummons(guild.id, async () => {
    const existing = repository.getSummonsPosts(guild.id).find(p => p.squadId === squadId && p.phase !== "closed");
    if (existing) {
      await publishSummons(guild, repository, existing);
      throw new SummonsError("This squad already has an open summons. Close it before calling again.");
    }
    const squad = repository.getSquad(guild.id, squadId);
    if (!squad) throw new Error("This squad no longer exists.");
    const memberIds = repository.listMemberships(guild.id).filter(m => m.squadId === squadId).map(m => m.userId);
    const post: SummonsPost = { id: randomUUID(), guildId: guild.id, channelId, messageIds: [], announcementMessageIds: [], kind: "summons", title: `${squad.name}, form up!`, squadId, memberIds, ready: {}, phase: "ready" };
    repository.saveSummonsPost(post);
    await publishSummons(guild, repository, post);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    for (let i = 0; i < memberIds.length; i += 50) {
      const batch = memberIds.slice(i, i + 50);
      const pingMessage = await channel.send({ content: `<@${callerId}> is calling the squad: ${batch.map(id => `<@${id}>`).join(" ")}\nhttps://discord.com/channels/${guild.id}/${channelId}/${post.messageIds[0]}`, allowedMentions: { parse: [], users: batch } });
      post.announcementMessageIds?.push(pingMessage.id);
    }
    repository.saveSummonsPost(post);
  });
}

export async function handleSummonsInteraction(interaction: Interaction, repository: RosterRepository, scheduler?: Pick<RosterScheduler, "schedule">): Promise<boolean> {
  const button = interaction.isButton() && interaction.customId.startsWith("op:");
  if (!button || !interaction.isButton()) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guild = interaction.guild;
    if (!guild) throw new Error("Use this inside a server.");
    await serializeSummons(guild.id, async () => {
      const member = await guild.members.fetch(interaction.user.id);
      const roleId = repository.getGuildConfig(guild.id).squadLeaderRoleId;
      const manager = member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(roleId && member.roles.cache.has(roleId));
      const [, id, action] = interaction.customId.split(":");
      const post = repository.getSummonsPosts(guild.id).find(p => p.id === id && p.channelId === interaction.channelId && p.messageIds.includes(interaction.message.id));
      if (!post) throw new Error("This squad summons is no longer active.");
      if (post.phase === "closed") {
        await publishSummons(guild, repository, post);
        throw new Error("This squad summons is closed.");
      }
      if (action === "lock" || action === "unlock") {
        if (!manager) throw new Error("Only squad managers can lock or unlock squads.");
        if (post.squadId === null || !repository.getSquad(guild.id, post.squadId)) throw new Error("This summons no longer has an active squad.");
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && repository.getMembership(guild.id, member.id)?.squadId !== post.squadId) throw new Error("You can only lock or unlock your own squad.");
        post.squadLocked = action === "lock";
      } else if (action === "close") {
        if (!manager) throw new Error("Only squad managers can close summons.");
        post.phase = "closed";
        post.squadLocked = false;
      } else throw new Error("Unknown control.");

      // Delete summon messages and ping messages if closing a squad summons
      if (action === "close") {
        const channel = await guild.channels.fetch(post.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const targets = [...post.messageIds, ...(post.announcementMessageIds ?? [])];
          for (const msgId of targets) {
            await channel.messages.delete(msgId).catch((err: unknown) => {
              console.error(`[summons] Failed to delete message ${msgId}:`, err);
            });
          }
        }
        post.messageIds = [];
        if (post.announcementMessageIds) post.announcementMessageIds = [];
      }

      repository.saveSummonsPost(post);
      scheduler?.schedule(guild.id, "squad");

      if (action !== "close") {
        await publishSummons(guild, repository, post);
      }

      await interaction.editReply(
        action === "lock" ? "🔒" :
        action === "unlock" ? "🔓" :
        "Squad summons closed and deleted."
      );
    });
  } catch (error) {
    console.error("[summons]", error);
    await interaction.editReply({ content: error instanceof Error ? error.message : "Could not update the summons.", allowedMentions: { parse: [] } });
  }
  return true;
}

export async function handleReadyReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, repository: RosterRepository): Promise<void> {
  if (user.bot || !["✅", "❌"].includes(reaction.emoji.name ?? "")) return;
  const guild = reaction.message.guild;
  if (!guild) return;
  await serializeSummons(guild.id, async () => {
    const post = repository.getSummonsPosts(guild.id).find(p => p.phase === "ready" && p.channelId === reaction.message.channelId && p.messageIds.includes(reaction.message.id));
    if (!post) return;
    const eligible = repository.getMembership(guild.id, user.id)?.squadId === post.squadId;
    if (!eligible || !await guild.members.fetch(user.id).catch(() => null)) return;
    post.ready[user.id] = reaction.emoji.name === "✅";
    repository.saveSummonsPost(post);
    await publishSummons(guild, repository, post);
    // Clearing the click permits repeated responses. The stored readiness is authoritative.
    await reaction.users.remove(user.id).catch(() => undefined);
  });
}

export async function reconcileSummons(guild: Guild, repository: RosterRepository): Promise<void> {
  await serializeSummons(guild.id, async () => {
    for (const post of repository.getSummonsPosts(guild.id).filter(p => p.phase !== "closed")) {
      try { await publishSummons(guild, repository, post); }
      catch (error) { console.error(`[summons] Could not refresh ${post.id}:`, error); }
    }
  });
}
