/** Persisted squad-summons state. The backing table retains its historical name for upgrades. */
export interface SummonsPost {
  id: string;
  guildId: string;
  channelId: string;
  messageIds: string[];
  announcementMessageIds?: string[];
  kind: "summons";
  title: string;
  squadId: number | null;
  memberIds: string[];
  ready: Record<string, boolean>;
  squadLocked?: boolean;
  phase: "ready" | "closed";
}
