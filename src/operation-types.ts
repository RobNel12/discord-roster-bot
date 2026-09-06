export interface OperationPost {
  id: string;
  guildId: string;
  channelId: string;
  messageIds: string[];
  announcementMessageIds?: string[];
  kind: "summons" | "operation";
  title: string;
  description: string;
  startsAt: number | null;
  squadId: number | null;
  memberIds: string[];
  responses: Record<string, "going" | "maybe" | "unavailable">;
  ready: Record<string, boolean>;
  squadLocked?: boolean;
  phase: "signup" | "ready" | "closed";
}
