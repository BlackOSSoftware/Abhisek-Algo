import type { AppSettings } from "@/lib/types";

export const defaultSettings: AppSettings = {
  tickExecutionEnabled: true,
  disableClearPendingOrders: true,
  disableCloseLivePositions: true,
  directionSwitchClearPendingOrders: true,
  directionSwitchCloseLivePositions: false
};
