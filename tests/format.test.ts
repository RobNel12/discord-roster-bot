import { describe, expect, it } from "vitest";
import type { APIEmbed } from "discord.js";

import { buildRosterEmbeds, escapeRosterText } from "../src/rosters/format.js";

describe("buildRosterEmbeds", () => {
  it("renders a useful empty roster", () => {
    const embeds = buildRosterEmbeds({
      title: "Role roster",
      emptyText: "Nothing configured.",
      sections: [],
      updatedAt: new Date("2026-08-31T12:00:00Z"),
    });

    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.toJSON().description).toContain("Nothing configured.");
  });

  it("splits large sections and paginates within Discord embed limits", () => {
    const sections = Array.from({ length: 80 }, (_, sectionIndex) => ({
      name: `Role ${sectionIndex}`,
      lines: Array.from(
        { length: 90 },
        (_, memberIndex) => `• <@${sectionIndex}${String(memberIndex).padStart(17, "0")}>`,
      ),
    }));
    const embeds = buildRosterEmbeds({
      title: "Very large roster",
      emptyText: "Empty",
      sections,
      updatedAt: new Date("2026-08-31T12:00:00Z"),
    });

    expect(embeds.length).toBeGreaterThan(1);
    for (const embed of embeds) {
      const json = embed.toJSON();
      expect(json.fields?.length ?? 0).toBeLessThanOrEqual(25);
      for (const field of json.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1_024);
      }
      expect(embedTextLength(json)).toBeLessThanOrEqual(6_000);
    }
  });

  it("neutralizes markdown and mass-mention text in headings", () => {
    expect(escapeRosterText("**@everyone**")).toBe("\\*\\*@\u200beveryone\\*\\*");
  });
});

function embedTextLength(embed: APIEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields ?? []).reduce(
      (total, field) => total + field.name.length + field.value.length,
      0,
    )
  );
}
