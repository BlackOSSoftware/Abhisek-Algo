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
      day: rawMarket.brokerDay ?? rawMarket.day,
      recentHighReady: isPositiveNumber(rawMarket.todayHigh) && isPositiveNumber(rawMarket.previousDayHigh) && rawMarket.todayHigh > rawMarket.previousDayHigh,
      recentLowReady: isPositiveNumber(rawMarket.todayLow) && isPositiveNumber(rawMarket.previousDayLow) && rawMarket.todayLow < rawMarket.previousDayLow
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
  if (settings.adaptiveHighLowMode !== "auto") {
    const market = resolveAdaptiveMarket(rawMarket, settings);
    return { market, resetTriggered: settings.adaptiveHighLowMode === "recent" && Boolean(previousMarket && previousMarket.day !== market.day) };
  }

  const resetTime = settings.adaptiveDailyResetTime || "02:30";
  const resetSession = resetSessionKey(resetTime, now);
  const price = tick.last || (tick.bid + tick.ask) / 2;
  const rawHigh = isPositiveNumber(rawMarket.adaptiveHigh) ? rawMarket.adaptiveHigh : price;
  const rawLow = isPositiveNumber(rawMarket.adaptiveLow) ? rawMarket.adaptiveLow : price;
  const canContinueSession = previousMarket?.resetSession === resetSession && previousMarket.resetTime === resetTime;

  return {
    market: {
      ...resolveAdaptiveMarket(rawMarket, settings),
      adaptiveHigh: rawHigh,
      adaptiveLow: rawLow,
      day: resetSession,
      resetSession,
      resetTime
    },
    resetTriggered: Boolean(previousMarket && !canContinueSession)
  };
}

export function isEntrySideReady(market: MarketState | null | undefined, side: Side) {
  return Boolean(market) && (side === "BUY" ? market?.recentHighReady !== false : market?.recentLowReady !== false);
}

export function recentBreakoutMessage(market: MarketState | null | undefined, side: Side) {
  const high = side === "BUY";
  const previous = high ? market?.previousDayHigh : market?.previousDayLow;
  if (!isPositiveNumber(previous)) return `Waiting for previous day ${high ? "high" : "low"} from MT5`;
  return `Waiting for today's ${high ? "high to break above" : "low to break below"} ${previous.toFixed(2)}`;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
