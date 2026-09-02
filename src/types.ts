export type RosterType = "role" | "squad";
export type RosterTarget = RosterType | "both";

export interface GuildConfig {
  guildId: string;
  roleRosterChannelId: string | null;
  squadRosterChannelId: string | null;
  squadCallChannelId: string | null;
  rankUpdateChannelId: string | null;
  squadLeaderRoleId: string | null;
  temporaryVoiceLobbyChannelId: string | null;
  includeBots: boolean;
}

export interface TemporaryVoiceChannel {
  guildId: string;
  channelId: string;
  ownerUserId: string;
  squadId: number | null;
}

export interface TrackedRole {
  guildId: string;
  roleId: string;
  sortOrder: number;
  pageId: number | null;
  highPriority: boolean;
}

export interface RoleRosterPage {
  id: number;
  guildId: string;
  name: string;
  sortOrder: number;
}

export interface Squad {
  id: number;
  guildId: string;
  name: string;
  normalizedName: string;
  sortOrder: number;
}

export interface SquadMembership {
  guildId: string;
  userId: string;
  squadId: number;
}

export interface SquadLoadoutRole {
  squadId: number;
  name: string;
  normalizedName: string;
  percentage: number;
  instructions: string | null;
  discordRoleId: string | null;
  firstPreferenceRoleId: string | null;
  secondPreferenceRoleId: string | null;
}

export interface SquadLoadoutAssignment {
  guildId: string;
  squadId: number;
  userId: string;
  roleName: string;
}

export interface PublishedMessage {
  guildId: string;
  rosterType: RosterType;
  ordinal: number;
  channelId: string;
  messageId: string;
}
