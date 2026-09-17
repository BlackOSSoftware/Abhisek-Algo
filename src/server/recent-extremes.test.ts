import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdaptiveMarket, resolveSessionAdaptiveMarket } from "@/lib/adaptive-market";
import { defaultSettings } from "@/lib/default-settings";
import { defaultConfig } from "@/lib/default-config";
import { settingsSchema } from "@/lib/validators";
import { resetSessionKey } from "@/lib/time";
import { evaluateStrategy } from "./strategy-engine";
import type { MarketState, Position } from "@/lib/types";

const settings = { ...defaultSettings, adaptiveHighLowMode: "recent" as const, recentDailyResetTime: "03:30", recentLegCount: 2 };
const raw: MarketState = {
  adaptiveHigh: 4352, adaptiveLow: 4298, todayHigh: 4352, todayLow: 4298,
  previousDayHigh: 4350, previousDayLow: 4300, day: "2026-09-11", brokerDay: "2026-09-11"
};
const now = new Date("2026-09-11T06:00:00Z");
const tick = { symbol: "GOLD.i#", bid: 4325, ask: 4325, last: 4325, time: now.toISOString() };

function evaluate(market: MarketState, price: number, positions: Position[] = [], recentLegCount = 2) {
  return evaluateStrategy({
    config: { ...defaultConfig, direction: "both", gridDistance: 5, gridType: "points", maxLegs: 3,
      legs: Array.from({ length: 3 }, () => ({ enabled: true, lotSize: 0.01 })), maxLots: 10, maxExposure: 10,
      forceExitEnabled: false, enableSpreadFilter: false, stopLoss: 4200, individualTakeProfit: 5 },
    settings: { ...settings, recentLegCount },
    market, tick: { ...tick, bid: price, ask: price, last: price }, positions,
    account: { balance: 100000, equity: 100000, floatingPnl: 0, dailyRealizedPnl: 0 }, enabled: true, now
  });
}

test("Recent High / Low settings accept reset time and zero auto legs", () => {
  assert.equal(settingsSchema.safeParse({ ...settings, recentLegCount: 0 }).success, true);
});

test("recent mode uses fixed previous-day anchors without waiting for breakout", () => {
  const market = resolveAdaptiveMarket(raw, settings);
  assert.equal(market.adaptiveHigh, 4350);
  assert.equal(market.adaptiveLow, 4300);
  assert.equal(market.recentHighReady, true);
  assert.equal(market.recentLowReady, true);
  assert.equal(evaluate(market, 4325).canEnter, true);
});

test("fixed recent count creates LIMIT and STOP orders on both sides of previous anchors", () => {
  const orders = evaluate(resolveAdaptiveMarket(raw, settings), 4325).intents.filter((intent) => intent.action === "OPEN");
  const buys = orders.filter((intent) => intent.side === "BUY").map((intent) => [intent.levelPrice, intent.pendingOrderType]);
  const sells = orders.filter((intent) => intent.side === "SELL").map((intent) => [intent.levelPrice, intent.pendingOrderType]);
  assert.deepEqual(buys, [[4340, "STOP"], [4345, "STOP"], [4355, "STOP"], [4360, "STOP"]]);
  assert.deepEqual(sells, [[4290, "STOP"], [4295, "STOP"], [4305, "STOP"], [4310, "STOP"]]);
});

test("zero recent count expands to next free levels around current price", () => {
  const market = resolveAdaptiveMarket(raw, settings);
  const first = evaluate(market, 4325, [], 0).intents.filter((intent) => intent.action === "OPEN" && intent.side === "BUY");
  assert.deepEqual(first.map((intent) => [intent.levelPrice, intent.pendingOrderType]), [[4320, "LIMIT"], [4330, "STOP"]]);
  const pendingOnly: Position[] = first.map((intent, index) => ({
    id: `pending-${index}`, symbol: tick.symbol, side: "BUY", levelIndex: intent.levelIndex!, levelPrice: intent.levelPrice!,
    entryPrice: intent.levelPrice!, volume: intent.volume!, status: "PENDING", openedAt: now.toISOString(), reEntryCount: 0
  }));
  const whilePending = evaluate(market, 4325, pendingOnly, 0).intents.filter((intent) => intent.action === "OPEN" && intent.side === "BUY");
  assert.deepEqual(whilePending.map((intent) => intent.levelPrice), []);
  const filledBelow: Position[] = [
    { ...pendingOnly[0], id: "filled-below", status: "OPEN" },
    pendingOnly[1]
  ];
  const next = evaluate(market, 4325, filledBelow, 0).intents.filter((intent) => intent.action === "OPEN" && intent.side === "BUY");
  assert.deepEqual(next.map((intent) => intent.levelPrice), [4315]);
});

test("carried position at a new-day grid price prevents duplicate entry", () => {
  const market = resolveAdaptiveMarket({ ...raw, previousDayHigh: 4360 }, settings);
  const carried: Position = {
    id: "old-day", symbol: tick.symbol, side: "BUY", levelIndex: 99, levelPrice: 4355, entryPrice: 4355,
    volume: 0.01, status: "OPEN", openedAt: now.toISOString(), reEntryCount: 0
  };
  const prices = evaluate(market, 4362, [carried], 2).intents
    .filter((intent) => intent.action === "OPEN" && intent.side === "BUY")
    .map((intent) => intent.levelPrice);
  assert.equal(prices.includes(4355), false);
});

test("recent reset follows configurable session time and adopts new previous anchors", () => {
  const previous = resolveSessionAdaptiveMarket(raw, null, tick, settings, new Date("2026-09-10T22:01:00Z")).market;
  const nextRaw = { ...raw, previousDayHigh: 4352, previousDayLow: 4298 };
  const before = resolveSessionAdaptiveMarket(nextRaw, previous, tick, settings, new Date("2026-09-11T21:59:00Z"));
  const after = resolveSessionAdaptiveMarket(nextRaw, previous, tick, settings, new Date("2026-09-11T22:01:00Z"));
  assert.equal(before.resetTriggered, false);
  assert.equal(after.resetTriggered, true);
  assert.equal(after.market.adaptiveHigh, 4352);
  assert.equal(after.market.adaptiveLow, 4298);
});

test("missing previous resetSession does not false-trigger a mid-day reset", () => {
  const previous = resolveAdaptiveMarket(raw, settings); // no resetSession/resetTime
  const result = resolveSessionAdaptiveMarket(raw, previous, tick, settings, new Date("2026-09-11T10:00:00Z"));
  assert.equal(result.resetTriggered, false);
  assert.equal(result.market.resetSession, resetSessionKey("03:30", new Date("2026-09-11T10:00:00Z")));
});

test("missing previous candle blocks only its unavailable side", () => {
  const market = resolveAdaptiveMarket({ ...raw, previousDayHigh: undefined }, settings);
  assert.equal(market.recentHighReady, false);
  assert.equal(market.recentLowReady, true);
});

test("manual and auto modes retain their anchor behavior", () => {
  const manual = resolveAdaptiveMarket(raw, { ...defaultSettings, adaptiveHighLowMode: "manual", manualAdaptiveHigh: 4400, manualAdaptiveLow: 4200 });
  const auto = resolveAdaptiveMarket(raw, defaultSettings);
  assert.equal(manual.adaptiveHigh, 4400);
  assert.equal(manual.adaptiveLow, 4200);
  assert.equal(auto.adaptiveHigh, raw.todayHigh);
  assert.equal(auto.adaptiveLow, raw.todayLow);
  assert.equal(auto.recentHighReady, undefined);
});
