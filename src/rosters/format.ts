import { EmbedBuilder } from "discord.js";

export interface RosterSection {
  name: string;
  lines: string[];
}

export interface RosterEmbedOptions {
  title: string;
  description?: string;
  emptyText: string;
  sections: RosterSection[];
  updatedAt?: Date;
  color?: number;
}

interface EmbedFieldData {
  name: string;
  value: string;
  inline: false;
}

const FIELD_VALUE_LIMIT = 1_024;
const FIELD_COUNT_LIMIT = 25;
const SAFE_EMBED_TEXT_BUDGET = 5_500;
const DEFAULT_COLOR = 0x5865_f2;

export function buildRosterEmbeds(options: RosterEmbedOptions): EmbedBuilder[] {
  const updatedAt = options.updatedAt ?? new Date();
  const timestamp = Math.floor(updatedAt.getTime() / 1_000);
  const descriptionParts = [options.description, `Last updated <t:${timestamp}:R>`].filter(
    (part): part is string => Boolean(part),
  );
  const description = descriptionParts.join("\n");
  const allFields = options.sections.flatMap(sectionToFields);
  const pages: EmbedFieldData[][] = [];

  if (allFields.length === 0) {
    pages.push([]);
  } else {
    let currentPage: EmbedFieldData[] = [];
    let currentTextSize = options.title.length + description.length + 32;

    for (const field of allFields) {
      const fieldSize = field.name.length + field.value.length;
      const pageIsFull = currentPage.length >= FIELD_COUNT_LIMIT;
      const textBudgetExceeded =
        currentPage.length > 0 && currentTextSize + fieldSize > SAFE_EMBED_TEXT_BUDGET;

      if (pageIsFull || textBudgetExceeded) {
        pages.push(currentPage);
        currentPage = [];
        currentTextSize = options.title.length + description.length + 32;
      }

      currentPage.push(field);
      currentTextSize += fieldSize;
    }

    pages.push(currentPage);
  }

  return pages.map((fields, index) => {
    const embed = new EmbedBuilder()
      .setColor(options.color ?? DEFAULT_COLOR)
      .setTitle(options.title)
      .setDescription(
        fields.length === 0 ? `${description}\n\n${options.emptyText}` : description,
      )
      .setFooter({ text: `Page ${index + 1} of ${pages.length}` })
      .setTimestamp(updatedAt);

    if (fields.length > 0) {
      embed.addFields(fields);
    }
    return embed;
  });
}

export function escapeRosterText(input: string): string {
  return input
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|>~])/gu, "\\$1")
    .replaceAll("@", "@\u200b");
}

function sectionToFields(section: RosterSection): EmbedFieldData[] {
  const values = splitLines(section.lines.length > 0 ? section.lines : ["• No members"]);
  const escapedName = escapeRosterText(section.name).slice(0, 256);

  return values.map((value, index) => ({
    name: index === 0 ? escapedName : `${escapedName} (continued)`.slice(0, 256),
    value,
    inline: false,
  }));
}

function splitLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const rawLine of lines) {
    const lineParts = splitLongLine(rawLine);
    for (const line of lineParts) {
      const candidate = current.length === 0 ? line : `${current}\n${line}`;
      if (candidate.length > FIELD_VALUE_LIMIT) {
        if (current.length > 0) {
          chunks.push(current);
        }
        current = line;
      } else {
        current = candidate;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function splitLongLine(line: string): string[] {
  if (line.length <= FIELD_VALUE_LIMIT) {
    return [line];
  }

  const parts: string[] = [];
  for (let offset = 0; offset < line.length; offset += FIELD_VALUE_LIMIT) {
    parts.push(line.slice(offset, offset + FIELD_VALUE_LIMIT));
  }
  return parts;
}
