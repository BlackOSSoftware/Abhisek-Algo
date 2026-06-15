import type { AppSettings, MarketState } from "@/lib/types";

export function resolveAdaptiveMarket(rawMarket: MarketState, settings: AppSettings): MarketState {
  if (settings.adaptiveHighLowMode === "auto") return rawMarket;

  const manualHigh = settings.manualAdaptiveHigh;
  const manualLow = settings.manualAdaptiveLow;
  if (!isPositiveNumber(manualHigh) || !isPositiveNumber(manualLow)) {
    throw new Error("Manual adaptive high and low are required in manual mode.");
  }
  if (manualHigh <= manualLow) {
    throw new Error("Manual adaptive high must be greater than manual adaptive low.");
  }

  return {
    ...rawMarket,
    adaptiveHigh: manualHigh,
    adaptiveLow: manualLow
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
