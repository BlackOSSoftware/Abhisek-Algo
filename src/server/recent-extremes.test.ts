import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdaptiveMarket, resolveSessionAdaptiveMarket } from "@/lib/adaptive-market";
import { defaultSettings } from "@/lib/default-settings";
import { defaultConfig } from "@/lib/default-config";
import { settingsSchema } from "@/lib/validators";
import { evaluateStrategy } from "./strategy-engine";
import type { MarketState, Position } from "@/lib/types";

const settings = { ...defaultSettings, adaptiveHighLowMode: "recent" as const };
const raw: MarketState = {
  adaptiveHigh: 4350, adaptiveLow: 4300, todayHigh: 4350, todayLow: 4300,
  previousDayHigh: 4350, previousDayLow: 4300, day: "2026-09-11", brokerDay: "2026-09-11"
};
const now = new Date("2026-09-11T06:00:00Z");
const tick = { symbol: "GOLD.i#", bid: 4325, ask: 4325, last: 4325, time: now.toISOString() };
function evaluate(market: MarketState, price: number, positions: Position[] = []) {
  return evaluateStrategy({
    config: { ...defaultConfig, direction: "both", gridDistance: 5, gridType: "points", maxLegs: 3,
      legs: Array.from({ length: 3 }, () => ({ enabled: true, lotSize: 0.01 })),
      forceExitEnabled: false, enableSpreadFilter: false, stopLoss: 4200, individualTakeProfit: 5 },
    market, tick: { ...tick, bid: price, ask: price, last: price }, positions,
    account: { balance: 100000, equity: 100000, floatingPnl: 0, dailyRealizedPnl: 0 }, enabled: true, now
  });
}

test("Recent High / Low mode is accepted by settings validation", () => {
  assert.equal(settingsSchema.safeParse(settings).success, true);
});

test("touching previous extremes does not unlock either side", () => {
  const market = resolveAdaptiveMarket(raw, settings);
  assert.equal(market.recentHighReady, false);
  assert.equal(market.recentLowReady, false);
  assert.equal(evaluate(market, 4325).canEnter, false);
  assert.equal(evaluate(market, 4325).intents.filter(i => i.action === "OPEN").length, 0);
});

test("recent grid anchors use previous day extremes while today's range is inside them", () => {
  const market = resolveAdaptiveMarket({ ...raw, todayHigh: 4356.17, todayLow: 4307.97,
    previousDayHigh: 4402.41, previousDayLow: 4292.35 }, settings);
  assert.equal(market.adaptiveHigh, 4402.41);
  assert.equal(market.adaptiveLow, 4292.35);
  assert.equal(market.recentHighReady, false);
  assert.equal(market.recentLowReady, false);
  assert.equal(evaluate(market, 4330).intents.filter(i => i.action === "OPEN").length, 0);
});

test("recent anchors transition independently when only one side breaks out", () => {
  const market = resolveAdaptiveMarket({ ...raw, todayHigh: 4405, todayLow: 4307.97,
    previousDayHigh: 4402.41, previousDayLow: 4292.35 }, settings);
  assert.equal(market.adaptiveHigh, 4405);
  assert.equal(market.adaptiveLow, 4292.35);
  assert.equal(market.recentHighReady, true);
  assert.equal(market.recentLowReady, false);
});

test("high breakout places only BUY levels from today's high", () => {
  const market = resolveAdaptiveMarket({ ...raw, todayHigh: 4352 }, settings);
  assert.equal(market.adaptiveHigh, 4352);
  assert.equal(market.recentHighReady, true);
  const orders = evaluate(market, 4352).intents.filter(i => i.action === "OPEN");
  assert.deepEqual(orders.map(i => [i.side, i.levelPrice]), [["BUY", 4347], ["BUY", 4342], ["BUY", 4337]]);
});

test("low breakout places only SELL levels from today's low", () => {
  const market = resolveAdaptiveMarket({ ...raw, todayLow: 4298 }, settings);
  assert.equal(market.adaptiveLow, 4298);
  assert.equal(market.recentLowReady, true);
  const orders = evaluate(market, 4298).intents.filter(i => i.action === "OPEN");
  assert.deepEqual(orders.map(i => [i.side, i.levelPrice]), [["SELL", 4303], ["SELL", 4308], ["SELL", 4313]]);
});

test("both breakouts follow further extremes and remain unlocked on a pullback", () => {
  const market = resolveAdaptiveMarket({ ...raw, todayHigh: 4358, todayLow: 4292 }, settings);
  assert.equal(market.adaptiveHigh, 4358);
  assert.equal(market.adaptiveLow, 4292);
  assert.equal(market.recentHighReady, true);
  assert.equal(market.recentLowReady, true);
  assert.equal(evaluate(market, 4325).canEnter, true);
});

test("missing previous candle blocks entries without invalidating today's data", () => {
  const market = resolveAdaptiveMarket({ ...raw, previousDayHigh: undefined, previousDayLow: undefined }, settings);
  assert.equal(evaluate(market, 4325).canEnter, false);
  assert.equal(market.todayHigh, 4350);
});

test("new broker day resets breakout qualification", () => {
  const previous = resolveAdaptiveMarket({ ...raw, todayHigh: 4358, todayLow: 4292 }, settings);
  const next = resolveSessionAdaptiveMarket({ ...raw, day: "2026-09-12", brokerDay: "2026-09-12",
    previousDayHigh: 4358, previousDayLow: 4292 }, previous, tick, settings, now);
  assert.equal(next.resetTriggered, true);
  assert.equal(next.market.recentHighReady, false);
  assert.equal(next.market.recentLowReady, false);
});

test("switching from manual uses actual daily extremes and auto removes breakout locks", () => {
  const manual = resolveAdaptiveMarket(raw, { ...defaultSettings, adaptiveHighLowMode: "manual", manualAdaptiveHigh: 4400, manualAdaptiveLow: 4200 });
  assert.equal(resolveAdaptiveMarket(manual, settings).adaptiveHigh, 4350);
  assert.equal(resolveAdaptiveMarket(resolveAdaptiveMarket(raw, settings), defaultSettings).recentHighReady, undefined);
});

test("breakout wait does not suppress existing position exits", () => {
  const market = resolveAdaptiveMarket(raw, settings);
  const position: Position = { id: "existing", symbol: tick.symbol, side: "BUY", levelIndex: 1,
    levelPrice: 4320, entryPrice: 4320, volume: 0.01, status: "OPEN", openedAt: now.toISOString(), reEntryCount: 0 };
  assert.equal(evaluate(market, 4326, [position]).intents.some(i => i.action === "CLOSE"), true);
});
