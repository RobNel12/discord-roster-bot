import { Collection, type Guild, type GuildMember } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberDirectory } from "../src/rosters/member-directory.js";

describe("MemberDirectory", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the complete member list once and rate-limits reconciliation fetches", async () => {
    vi.useFakeTimers();
    const members = new Collection<string, GuildMember>();
    const fetch = vi.fn(async () => members);
    const guild = {
      id: "guild-1",
      members: { cache: members, fetch },
    } as unknown as Guild;
    const directory = new MemberDirectory();

    await directory.getCompleteMembers(guild);
    await directory.getCompleteMembers(guild);
    await directory.getCompleteMembers(guild, true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(35_001);
    await directory.getCompleteMembers(guild, true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
