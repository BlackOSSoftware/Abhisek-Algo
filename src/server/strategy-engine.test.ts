import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/lib/default-config";
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
  assert.deepEqual(openLevels(config, market, gate, tickAt(97.9)), []);
  assert.deepEqual(openLevels(config, market, gate, tickAt(98.1)), [3]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(99.1), [pending("BUY", 3, 97)]), [1, 2]);
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
  assert.deepEqual(openLevels(config, market, gate, tickAt(102.1)), []);
  assert.deepEqual(openLevels(config, market, gate, tickAt(101.9)), [3]);
  assert.deepEqual(openLevels(config, market, gate, tickAt(100.9), [pending("SELL", 3, 103)]), [1, 2]);
});

test("recovered locks stay released after price moves back", () => {
  const config = testConfig("buy");
  const market = testMarket();
  const gate = createEntryStartGate(config, market, tickAt(96.5));
  const released = releaseRecoveredEntryLocks(config, market, tickAt(99.1), gate);

  assert.deepEqual(released?.lockedLevels, []);
  assert.deepEqual(openLevels(config, market, released, tickAt(98.5), [pending("BUY", 3, 97)]), [2]);
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
