import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/lib/default-config";
import { defaultSettings } from "@/lib/default-settings";
import { resolveSessionAdaptiveMarket } from "@/lib/adaptive-market";
import type { MarketState, Position, Side, StrategyConfig, Tick } from "@/lib/types";
import { createEntryStartGate, evaluateStrategy, releaseRecoveredEntryLocks } from "@/server/strategy-engine";

const now = new Date("2026-06-15T06:00:00.000Z");
const account = { balance: 100000, equity: 100000, floatingPnl: 0, dailyRealizedPnl: 0 };

test("BUY start-locked levels unlock one at a time during upward recovery", () => {
  const config = testConfig("buy");
  const market = testMarket();
  const gate = createEntryStartGate(config, market, tickAt(96.5));

  assert.deepEqual(gate?.lockedLevels, [
    { side: "BUY", levelIndex: 1 },
    { side: "BUY", levelIndex: 2 },
    { side: "BUY", levelIndex: 3 }
  ]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(96.9)), []);
  assert.deepEqual(openLevels(config, market, gate, tickAt(97.1)), [3]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(98.1), [pending("BUY", 3, 97)]), [2]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(99.1), [pending("BUY", 2, 98), pending("BUY", 3, 97)]), [1]);
});

test("SELL start-locked levels unlock one at a time during downward recovery", () => {
  const config = testConfig("sell");
  const market = testMarket();
  const gate = createEntryStartGate(config, market, tickAt(103.5));

  assert.deepEqual(gate?.lockedLevels, [
    { side: "SELL", levelIndex: 1 },
    { side: "SELL", levelIndex: 2 },
    { side: "SELL", levelIndex: 3 }
  ]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(103.1)), []);
  assert.deepEqual(openLevels(config, market, gate, tickAt(102.9)), [3]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(101.9), [pending("SELL", 3, 103)]), [2]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(100.9), [pending("SELL", 2, 102), pending("SELL", 3, 103)]), [1]);
});

test("recovered locks stay released after price moves back", () => {
  const config = testConfig("buy");
  const market = testMarket();
  const gate = createEntryStartGate(config, market, tickAt(96.5));
  const released = releaseRecoveredEntryLocks(config, market, tickAt(99.1), gate);

  assert.deepEqual(released?.lockedLevels, []);
  assert.deepEqual(openLevels(config, market, released, tickAt(98.5), [pending("BUY", 3, 97)]), [2]);
});

test("adaptive high low continues inside the same 2:30 AM reset session", () => {
  const previous: MarketState = { adaptiveHigh: 110, adaptiveLow: 95, day: "2026-06-15", resetSession: "2026-06-15", resetTime: "02:30" };
  const rawMarket: MarketState = { adaptiveHigh: 112, adaptiveLow: 94, day: "2026-06-15" };
  const result = resolveSessionAdaptiveMarket(rawMarket, previous, tickAt(111), defaultSettings, new Date("2026-06-15T20:00:00.000Z"));

  assert.equal(result.resetTriggered, false);
  assert.equal(result.market.adaptiveHigh, 112);
  assert.equal(result.market.adaptiveLow, 94);
  assert.equal(result.market.day, "2026-06-15");
});

test("adaptive high low resets after the 2:30 AM reset session changes", () => {
  const previous: MarketState = { adaptiveHigh: 140, adaptiveLow: 90, day: "2026-06-15", resetSession: "2026-06-15", resetTime: "02:30" };
  const rawMarket: MarketState = { adaptiveHigh: 108, adaptiveLow: 96, day: "2026-06-16" };
  const result = resolveSessionAdaptiveMarket(rawMarket, previous, tickAt(101), defaultSettings, new Date("2026-06-15T21:05:00.000Z"));

  assert.equal(result.resetTriggered, true);
  assert.equal(result.market.adaptiveHigh, 108);
  assert.equal(result.market.adaptiveLow, 96);
  assert.equal(result.market.day, "2026-06-16");
});

test("adaptive high low uses broker D1 range instead of only current price", () => {
  const rawMarket: MarketState = { adaptiveHigh: 112, adaptiveLow: 96, day: "2026-06-15" };
  const result = resolveSessionAdaptiveMarket(rawMarket, null, tickAt(101), defaultSettings, new Date("2026-06-15T20:00:00.000Z"));

  assert.equal(result.resetTriggered, false);
  assert.equal(result.market.adaptiveHigh, 112);
  assert.equal(result.market.adaptiveLow, 96);
});

function openLevels(
  config: StrategyConfig,
  market: MarketState,
  entryGate: ReturnType<typeof createEntryStartGate>,
  tick: Tick,
  positions: Position[] = []
) {
  return evaluateStrategy({ config, market, entryGate, tick, positions, account, enabled: true, now }).intents
    .filter((intent) => intent.action === "OPEN")
    .map((intent) => intent.levelIndex);
}

function testConfig(direction: "buy" | "sell"): StrategyConfig {
  return {
    ...defaultConfig,
    direction,
    gridDistance: 1,
    maxLegs: 3,
    legs: Array.from({ length: 3 }, () => ({ enabled: true, lotSize: 0.01 })),
    stopLoss: direction === "buy" ? 90 : 110,
    enableSpreadFilter: false,
    forceExitEnabled: false
  };
}

function testMarket(): MarketState {
  return { adaptiveHigh: 100, adaptiveLow: 100, day: "2026-06-15" };
}

function tickAt(price: number): Tick {
  return { symbol: "GOLD.i#", bid: price, ask: price, last: price, time: now.toISOString() };
}

function pending(side: Side, levelIndex: number, levelPrice: number): Position {
  return {
    id: `${side}-${levelIndex}`,
    symbol: "GOLD.i#",
    side,
    levelIndex,
    levelPrice,
    entryPrice: levelPrice,
    volume: 0.01,
    status: "PENDING",
    openedAt: now.toISOString(),
    reEntryCount: 0
  };
}
