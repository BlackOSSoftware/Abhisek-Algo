import type { AppSettings, MarketState } from "@/lib/types";
import type { Tick } from "@/lib/types";
import { resetSessionKey } from "@/lib/time";

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

export function resolveSessionAdaptiveMarket(
  rawMarket: MarketState,
  previousMarket: MarketState | null,
  tick: Tick,
  settings: AppSettings,
  now = new Date()
): { market: MarketState; resetTriggered: boolean } {
  if (settings.adaptiveHighLowMode !== "auto") {
    return { market: resolveAdaptiveMarket(rawMarket, settings), resetTriggered: false };
  }

  const resetTime = settings.adaptiveDailyResetTime || "02:30";
  const resetSession = resetSessionKey(resetTime, now);
  const price = tick.last || (tick.bid + tick.ask) / 2;
  const canContinueSession = previousMarket?.resetSession === resetSession && previousMarket.resetTime === resetTime;
  const seedHigh = canContinueSession ? previousMarket.adaptiveHigh : price;
  const seedLow = canContinueSession ? previousMarket.adaptiveLow : price;

  return {
    market: {
      ...rawMarket,
      adaptiveHigh: Math.max(seedHigh, price),
      adaptiveLow: Math.min(seedLow, price),
      day: resetSession,
      resetSession,
      resetTime
    },
    resetTriggered: Boolean(previousMarket && !canContinueSession)
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
