import type { AppSettings, MarketState, Side } from "@/lib/types";
import type { Tick } from "@/lib/types";
import { resetSessionKey } from "@/lib/time";

export function resolveAdaptiveMarket(rawMarket: MarketState, settings: AppSettings): MarketState {
  const market = {
    ...rawMarket,
    adaptiveHigh: rawMarket.todayHigh ?? rawMarket.adaptiveHigh,
    adaptiveLow: rawMarket.todayLow ?? rawMarket.adaptiveLow,
    recentHighReady: undefined,
    recentLowReady: undefined
  };
  if (settings.adaptiveHighLowMode === "auto") return market;
  if (settings.adaptiveHighLowMode === "recent") {
    return {
      ...market,
      adaptiveHigh: isPositiveNumber(rawMarket.previousDayHigh) ? rawMarket.previousDayHigh : market.adaptiveHigh,
      adaptiveLow: isPositiveNumber(rawMarket.previousDayLow) ? rawMarket.previousDayLow : market.adaptiveLow,
      recentHighReady: isPositiveNumber(rawMarket.previousDayHigh),
      recentLowReady: isPositiveNumber(rawMarket.previousDayLow)
    };
  }

  const manualHigh = settings.manualAdaptiveHigh;
  const manualLow = settings.manualAdaptiveLow;
  if (!isPositiveNumber(manualHigh) || !isPositiveNumber(manualLow)) {
    throw new Error("Manual adaptive high and low are required in manual mode.");
  }
  if (manualHigh <= manualLow) {
    throw new Error("Manual adaptive high must be greater than manual adaptive low.");
  }

  return {
    ...market,
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
  if (settings.adaptiveHighLowMode === "recent") {
    const resetTime = settings.recentDailyResetTime || "03:30";
    const resetSession = resetSessionKey(resetTime, now);
    const market = resolveAdaptiveMarket(rawMarket, settings);
    return {
      market: { ...market, day: resetSession, resetSession, resetTime },
      resetTriggered: didSessionReset(previousMarket, resetSession, resetTime)
    };
  }
  if (settings.adaptiveHighLowMode !== "auto") {
    return { market: resolveAdaptiveMarket(rawMarket, settings), resetTriggered: false };
  }

  const resetTime = settings.adaptiveDailyResetTime || "02:30";
  const resetSession = resetSessionKey(resetTime, now);
  const price = tick.last || (tick.bid + tick.ask) / 2;
  const rawHigh = isPositiveNumber(rawMarket.adaptiveHigh) ? rawMarket.adaptiveHigh : price;
  const rawLow = isPositiveNumber(rawMarket.adaptiveLow) ? rawMarket.adaptiveLow : price;

  return {
    market: {
      ...resolveAdaptiveMarket(rawMarket, settings),
      adaptiveHigh: rawHigh,
      adaptiveLow: rawLow,
      day: resetSession,
      resetSession,
      resetTime
    },
    resetTriggered: didSessionReset(previousMarket, resetSession, resetTime)
  };
}

function didSessionReset(
  previousMarket: MarketState | null | undefined,
  resetSession: string,
  resetTime: string
) {
  // Only a real previous session can trigger reset. Missing resetSession (enable/restart
  // paths that stored a raw market) must not wipe the day cache mid-session.
  if (!previousMarket?.resetSession || !previousMarket.resetTime) return false;
  return previousMarket.resetSession !== resetSession || previousMarket.resetTime !== resetTime;
}

export function isEntrySideReady(market: MarketState | null | undefined, side: Side) {
  return Boolean(market) && (side === "BUY" ? market?.recentHighReady !== false : market?.recentLowReady !== false);
}

export function recentBreakoutMessage(market: MarketState | null | undefined, side: Side) {
  const high = side === "BUY";
  const previous = high ? market?.previousDayHigh : market?.previousDayLow;
  if (!isPositiveNumber(previous)) return `Waiting for previous day ${high ? "high" : "low"} from MT5`;
  return `Previous day ${high ? "high" : "low"} ready at ${previous.toFixed(2)}`;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
