import type { RosterScheduler } from "./scheduler.js";
import { rankForSeconds, officerRankForSeconds } from "./ranks.js";
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, type Guild, type Interaction, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";
import type { RosterRepository } from "./database.js";
import type { OperationPost } from "./operation-types.js";
import { buildRosterEmbeds, memberLine, escapeRosterText } from "./rosters/format.js";

export class SummonsError extends Error {}

const queues = new Map<string, Promise<unknown>>();
export async function serializeOperation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

export function renderOperation(post: OperationPost): string[] {
  const header = `**${escapeRosterText(post.title)}** — ${post.phase === "closed" ? "Closed" : post.phase === "signup" ? "Sign-ups open" : "Ready check"}`;
  const info = `${post.description ? `\n${escapeRosterText(post.description)}` : ""}${post.startsAt ? `\nStarts <t:${post.startsAt}:F> (<t:${post.startsAt}:R>)` : ""}`;
  const ids = post.kind === "summons" ? post.memberIds : Object.keys(post.responses);
  const lines = ids.map(id => {
    const status = post.kind === "operation" ? `${post.responses[id]} · ` : "";
    return `${post.ready[id] ? "✅" : "❌"} <@${id}> — ${status}${post.ready[id] ? "Ready" : "Not ready"}`;
  });
  const pages: string[] = [];
  let page = `${header}${info}\n${post.phase === "ready" ? "React ✅ or ❌ to change your readiness. Your latest reaction wins.\n" : ""}`;
  for (const line of lines) {
    if (page.length + line.length + 1 > 1900) { pages.push(page); page = `${header}\n`; }
    page += `${line}\n`;
  }
  pages.push(page + (lines.length ? "" : "No responses yet."));
  return pages;
}

export function renderSummons(guild: Guild, repository: RosterRepository, post: OperationPost) {
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

function controls(post: OperationPost) {
  if (post.phase === "closed") return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  const add = (action: string, label: string, style = ButtonStyle.Secondary) => row.addComponents(new ButtonBuilder().setCustomId(`op:${post.id}:${action}`).setLabel(label).setStyle(style));
  if (post.phase === "signup") {
    add("going", "Going", ButtonStyle.Success); add("maybe", "Maybe"); add("unavailable", "Unavailable"); add("start", "Start ready check", ButtonStyle.Primary);
  }
  if (post.kind === "summons") row.addComponents(new ButtonBuilder()
    .setCustomId(`op:${post.id}:${post.squadLocked ? "unlock" : "lock"}`)
    .setEmoji(post.squadLocked ? "🔒" : "🔓")
    .setStyle(ButtonStyle.Primary));
  add("close", post.kind === "summons" ? "Close squad summons" : "Close operation", ButtonStyle.Danger);
  return [row];
}

export async function publishOperation(guild: Guild, repository: RosterRepository, post: OperationPost): Promise<void> {
  const channel = await guild.channels.fetch(post.channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) throw new Error("The operation channel is unavailable.");
  if (post.kind === "summons" && post.phase !== "closed") {
    post.memberIds = repository.listMemberships(post.guildId).filter(m => m.squadId === post.squadId).map(m => m.userId);
    const current = new Set(post.memberIds);
    for (const userId of Object.keys(post.ready)) if (!current.has(userId)) delete post.ready[userId];
    repository.saveOperationPost(post);
  }
  const embeds = post.kind === "summons" ? renderSummons(guild, repository, post) : [];
  const pages = post.kind === "summons" ? embeds.map(() => "") : renderOperation(post);
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
      repository.saveOperationPost(post);
    }
    if (post.phase === "ready") { await message.react("✅"); await message.react("❌"); }
  }
  for (const id of post.messageIds.slice(pages.length)) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) await message.edit({ content: "This page is no longer needed. Use the first page.", embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  post.messageIds = post.messageIds.slice(0, pages.length);
  repository.saveOperationPost(post);
}

export async function createSummons(guild: Guild, repository: RosterRepository, squadId: number, channelId: string, callerId: string): Promise<void> {
  await serializeOperation(guild.id, async () => {
    const existing = repository.getOperationPosts(guild.id).find(p => p.kind === "summons" && p.squadId === squadId && p.phase !== "closed");
    if (existing) {
      await publishOperation(guild, repository, existing);
      throw new SummonsError("This squad already has an open summons. Close it before calling again.");
    }
    const squad = repository.getSquad(guild.id, squadId);
    if (!squad) throw new Error("This squad no longer exists.");
    const memberIds = repository.listMemberships(guild.id).filter(m => m.squadId === squadId).map(m => m.userId);
    const post: OperationPost = { id: randomUUID(), guildId: guild.id, channelId, messageIds: [], announcementMessageIds: [], kind: "summons", title: `${squad.name}, form up!`, description: "", startsAt: null, squadId, memberIds, responses: {}, ready: {}, phase: "ready" };
    repository.saveOperationPost(post);
    await publishOperation(guild, repository, post);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    for (let i = 0; i < memberIds.length; i += 50) {
      const batch = memberIds.slice(i, i + 50);
      const pingMessage = await channel.send({ content: `<@${callerId}> is calling the squad: ${batch.map(id => `<@${id}>`).join(" ")}\nhttps://discord.com/channels/${guild.id}/${channelId}/${post.messageIds[0]}`, allowedMentions: { parse: [], users: batch } });
      post.announcementMessageIds?.push(pingMessage.id);
    }
    repository.saveOperationPost(post);
  });
}

export async function handleOperationInteraction(interaction: Interaction, repository: RosterRepository, scheduler?: Pick<RosterScheduler, "schedule">): Promise<boolean> {
  const button = interaction.isButton() && interaction.customId.startsWith("op:");
  const command = interaction.isChatInputCommand() && interaction.commandName === "operation";
  if (!button && !command) return false;
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guild = interaction.guild;
    if (!guild) throw new Error("Use this inside a server.");
    await serializeOperation(guild.id, async () => {
      const member = await guild.members.fetch(interaction.user.id);
      const roleId = repository.getGuildConfig(guild.id).squadLeaderRoleId;
      const manager = member.permissions.has(PermissionFlagsBits.ManageGuild) || Boolean(roleId && member.roles.cache.has(roleId));
      if (interaction.isChatInputCommand()) {
        if (!manager) throw new Error("Only squad managers can create operations.");
        const channel = interaction.options.getChannel("channel", true);
        const starts = interaction.options.getString("starts", true);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(starts)) throw new Error("Use a date with timezone, for example 2026-09-12T19:00:00-07:00.");
        const time = Date.parse(starts);
        if (!Number.isFinite(time) || time <= Date.now()) throw new Error("Choose a valid future start time.");
        const post: OperationPost = { id: randomUUID(), guildId: guild.id, channelId: channel.id, messageIds: [], kind: "operation", title: interaction.options.getString("name", true), description: interaction.options.getString("description") ?? "", startsAt: Math.floor(time / 1000), squadId: null, memberIds: [], responses: {}, ready: {}, phase: "signup" };
        await publishOperation(guild, repository, post);
        await interaction.editReply(`Operation sign-ups posted in <#${channel.id}>.`);
        return;
      }
      const [, id, action] = interaction.customId.split(":");
      const post = repository.getOperationPosts(guild.id).find(p => p.id === id && p.channelId === interaction.channelId && p.messageIds.includes(interaction.message.id));
      if (!post) throw new Error("This operation or summons is no longer active.");
      if (post.phase === "closed") {
        await publishOperation(guild, repository, post);
        throw new Error("This operation or summons is closed.");
      }
      if (action === "lock" || action === "unlock") {
        if (!manager) throw new Error("Only squad managers can lock or unlock squads.");
        if (post.kind !== "summons" || post.squadId === null || !repository.getSquad(guild.id, post.squadId)) throw new Error("This summons no longer has an active squad.");
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && repository.getMembership(guild.id, member.id)?.squadId !== post.squadId) throw new Error("You can only lock or unlock your own squad.");
        post.squadLocked = action === "lock";
      } else if (action === "close" || action === "start") {
        if (!manager) throw new Error("Only squad managers can start ready checks or close summons and operations.");
        if (action === "start" && post.phase !== "signup") throw new Error("The ready check has already started.");
        post.phase = action === "close" ? "closed" : "ready";
        if (action === "close") post.squadLocked = false;
      } else if (["going", "maybe", "unavailable"].includes(action ?? "")) {
        if (post.phase !== "signup") throw new Error("Sign-ups have closed; the ready check has started.");
        post.responses[member.id] = action as "going" | "maybe" | "unavailable";
      } else throw new Error("Unknown control.");

      // Delete the summon messages if closing a squad summons
      if (post.kind === "summons" && action === "close") {
        const channel = await guild.channels.fetch(post.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          for (const msgId of post.messageIds) {
            await channel.messages.delete(msgId).catch(() => null);
          }
        }
        post.messageIds = [];
      }

      repository.saveOperationPost(post);
      if (post.kind === "summons" && ["lock", "unlock", "close"].includes(action ?? "")) scheduler?.schedule(guild.id, "squad");

      if (!(post.kind === "summons" && action === "close")) {
        await publishOperation(guild, repository, post);
      }

      await interaction.editReply(
        action === "lock" ? "🔒" :
        action === "unlock" ? "🔓" :
        action === "close" ? (post.kind === "summons" ? "Squad summons closed and deleted." : "Closed. Responses are now frozen and any squad lock is released.") :
        action === "start" ? "Ready check started. Participants can react ✅ or ❌." :
        "Your sign-up was updated."
      );
    });
  } catch (error) {
    console.error("[operation]", error);
    await interaction.editReply({ content: error instanceof Error ? error.message : "Could not update the operation.", allowedMentions: { parse: [] } });
  }
  return true;
}

export async function handleReadyReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, repository: RosterRepository): Promise<void> {
  if (user.bot || !["✅", "❌"].includes(reaction.emoji.name ?? "")) return;
  const guild = reaction.message.guild;
  if (!guild) return;
  await serializeOperation(guild.id, async () => {
    const post = repository.getOperationPosts(guild.id).find(p => p.phase === "ready" && p.channelId === reaction.message.channelId && p.messageIds.includes(reaction.message.id));
    if (!post) return;
    const eligible = post.kind === "summons" ? repository.getMembership(guild.id, user.id)?.squadId === post.squadId : post.responses[user.id] === "going" || post.responses[user.id] === "maybe";
    if (!eligible || !await guild.members.fetch(user.id).catch(() => null)) return;
    post.ready[user.id] = reaction.emoji.name === "✅";
    repository.saveOperationPost(post);
    await publishOperation(guild, repository, post);
    // Clearing the click permits repeated responses. The stored readiness is authoritative.
    await reaction.users.remove(user.id).catch(() => undefined);
  });
}

export async function reconcileOperations(guild: Guild, repository: RosterRepository): Promise<void> {
  await serializeOperation(guild.id, async () => {
    for (const post of repository.getOperationPosts(guild.id).filter(p => p.phase !== "closed")) {
      try { await publishOperation(guild, repository, post); }
      catch (error) { console.error(`[operation] Could not refresh ${post.id}:`, error); }
    }
  });
}
