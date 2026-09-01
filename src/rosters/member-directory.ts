import type { Collection, Guild, GuildMember, Snowflake } from "discord.js";

const MINIMUM_FULL_FETCH_INTERVAL_MS = 35_000;

export class MemberDirectory {
  private readonly lastFullFetchAt = new Map<string, number>();
  private readonly inFlightFetches = new Map<
    string,
    Promise<Collection<Snowflake, GuildMember>>
  >();

  async getCompleteMembers(
    guild: Guild,
    reconcile = false,
  ): Promise<Collection<Snowflake, GuildMember>> {
    const lastFetchAt = this.lastFullFetchAt.get(guild.id);
    const canReconcile =
      lastFetchAt === undefined || Date.now() - lastFetchAt >= MINIMUM_FULL_FETCH_INTERVAL_MS;
    const needsFetch = lastFetchAt === undefined || (reconcile && canReconcile);

    if (!needsFetch) {
      return guild.members.cache;
    }

    const existingFetch = this.inFlightFetches.get(guild.id);
    if (existingFetch) {
      return existingFetch;
    }

    const fetch = guild.members
      .fetch()
      .then((members) => {
        this.lastFullFetchAt.set(guild.id, Date.now());
        return members;
      })
      .finally(() => {
        this.inFlightFetches.delete(guild.id);
      });

    this.inFlightFetches.set(guild.id, fetch);
    return fetch;
  }
}
