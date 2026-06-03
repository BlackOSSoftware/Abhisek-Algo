import type { AppSettings } from "@/lib/types";

export const defaultSettings: AppSettings = {
  disableClearPendingOrders: true,
  disableCloseLivePositions: true,
  directionSwitchClearPendingOrders: true,
  directionSwitchCloseLivePositions: false
};
