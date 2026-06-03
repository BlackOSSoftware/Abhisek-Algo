import type { DashboardSnapshot } from "@/lib/types";

export type Snapshot = DashboardSnapshot & {
  events: Array<{ id: number; type: string; payload: string; created_at: string }>;
};
