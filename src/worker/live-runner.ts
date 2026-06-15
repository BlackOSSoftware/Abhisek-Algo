import "@/server/env";
import { randomUUID } from "node:crypto";
import { store } from "@/server/db";
import { withLock } from "@/server/locks";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { rotateLogFiles } from "@/server/maintenance";
import { createEntryStartGate, evaluateStrategy, releaseRecoveredEntryLocks } from "@/server/strategy-engine";
import { resolveAdaptiveMarket } from "@/lib/adaptive-market";
import type { MarketState, Position, Side, StrategyConfig, Tick, TradeIntent } from "@/lib/types";
import type { Mt5BrokerPendingOrder, Mt5BrokerPosition } from "@/server/mt5-adapter";

const adapter = new Mt5Adapter();
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
const maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 300000);
let lastMaintenanceAt = 0;
let lastTickExecutionSkippedAt = 0;

async function loop() {
  const config = store.getConfig();
  const settings = store.getSettings();
  try {
    const live = await adapter.liveSnapshot(config.symbol);
    const { tick, account } = live;
    const market = resolveAdaptiveMarket(live.market, settings);
    const brokerPositions = live.positions;
    const brokerPendingOrders = live.pendingOrders;
    store.setTick(tick);
    store.setAccount(account);
    store.setMarket(market);
    store.setBrokerSnapshot({ positions: brokerPositions, pendingOrders: brokerPendingOrders });
    let activePositions = store.listActivePositions();
    promoteFilledPendingPositions(activePositions, brokerPositions);
    activePositions = store.listActivePositions();
    reconcileRemovedPendingOrders(activePositions, brokerPendingOrders);
    reconcileClosedBrokerPositions(activePositions, brokerPositions, tick.last);
    if (!settings.tickExecutionEnabled) {
      if (Date.now() - lastTickExecutionSkippedAt > 60000) {
        lastTickExecutionSkippedAt = Date.now();
        store.event("MT5_ORDER_SYNC_SKIPPED", { symbol: config.symbol });
      }
      return;
    }
    await syncPendingGridToMarket(config, market, tick);
    let entryGate = store.getEntryGate();
    if (store.getEnabled() && !entryGate) {
      entryGate = createEntryStartGate(config, market, tick);
      store.setEntryGate(entryGate);
    }
    if (entryGate) {
      const releasedGate = releaseRecoveredEntryLocks(config, market, tick, entryGate);
      if (releasedGate && releasedGate.lockedLevels.length !== entryGate.lockedLevels.length) {
        entryGate = releasedGate;
        store.setEntryGate(entryGate);
      }
    }
    const strategyPositions = store.listPositions(undefined, 500);
    const result = evaluateStrategy({
      config,
      tick,
      market,
      positions: strategyPositions,
      account,
      enabled: store.getEnabled(),
      entryGate
    });
    for (const intent of result.intents) {
      await executeIntent(intent, tick.last);
    }
  } catch (error) {
    const broker = store.getBrokerSnapshot();
    store.setBrokerSnapshot({
      positions: broker.positions,
      pendingOrders: broker.pendingOrders,
      error: error instanceof Error ? error.message : String(error)
    });
    store.event("WORKER_ERROR", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    runMaintenance();
    setTimeout(loop, intervalMs).unref();
  }
}

async function syncPendingGridToMarket(config: StrategyConfig, market: MarketState, tick: Tick) {
  const pendingPositions = store.listPositions("PENDING").filter((position) => position.symbol === config.symbol);
  for (const position of pendingPositions) {
    const leg = config.legs[position.levelIndex - 1];
    const nextLevelPrice = levelPriceFor(config, position.side, position.levelIndex, market);
    const nextLot = leg?.lotSize ?? position.volume;
    const triggerPrice = position.side === "BUY" ? tick.ask : tick.bid;
    const shouldCancel = !leg?.enabled || !isPendingWaiting(position.side, nextLevelPrice, triggerPrice);

    try {
      if (shouldCancel) {
        const result = await adapter.close(position.symbol, position.side, position.volume, position.levelIndex, position.levelPrice);
        if (!result.ok) throw new Error(result.error ?? `Could not cancel pending order for leg ${position.levelIndex}`);
        store.closePosition(position.id, position.entryPrice, 0);
        store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
        store.event("PENDING_ORDER_CANCELLED_ON_ADAPTIVE_SYNC", {
          symbol: position.symbol,
          side: position.side,
          levelIndex: position.levelIndex,
          oldLevelPrice: position.levelPrice,
          nextLevelPrice,
          reason: leg?.enabled ? "New adaptive level already reached" : "Leg disabled"
        });
        continue;
      }

      if (Math.abs(nextLevelPrice - position.levelPrice) <= 1e-8 && Math.abs(nextLot - position.volume) <= 1e-8) continue;
      const result = await adapter.replacePending(
        position.symbol,
        position.side,
        position.levelIndex,
        position.levelPrice,
        nextLevelPrice,
        nextLot,
        config.stopLoss,
        config.individualTakeProfit
      );
      if (!result.ok || !result.brokerOrderId) throw new Error(result.error ?? `Could not update pending order for leg ${position.levelIndex}`);
      store.updatePendingPosition(position.id, {
        levelPrice: result.price ?? nextLevelPrice,
        entryPrice: result.price ?? nextLevelPrice,
        volume: result.volume ?? nextLot,
        brokerOrderId: result.brokerOrderId
      });
      store.event("PENDING_ORDER_SYNCED_TO_ADAPTIVE_MARKET", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        oldLevelPrice: position.levelPrice,
        newLevelPrice: result.price ?? nextLevelPrice,
        oldVolume: position.volume,
        newVolume: result.volume ?? nextLot
      });
    } catch (error) {
      store.event("PENDING_ORDER_ADAPTIVE_SYNC_FAILED", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function levelPriceFor(config: StrategyConfig, side: Side, levelIndex: number, market: MarketState) {
  const anchor = side === "BUY" ? market.adaptiveHigh : market.adaptiveLow;
  const distance = config.gridType === "percentage" ? (anchor * config.gridDistance) / 100 : config.gridDistance;
  return side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
}

function isPendingWaiting(side: Side, levelPrice: number, marketPrice: number) {
  return side === "BUY" ? levelPrice < marketPrice : levelPrice > marketPrice;
}

function runMaintenance() {
  const nowMs = Date.now();
  if (nowMs - lastMaintenanceAt < maintenanceIntervalMs) return;
  lastMaintenanceAt = nowMs;
  try {
    store.maintenance();
    rotateLogFiles();
  } catch (error) {
    store.event("MAINTENANCE_ERROR", { message: error instanceof Error ? error.message : String(error) });
  }
}

function reconcileClosedBrokerPositions(activePositions: Position[], brokerPositions: Mt5BrokerPosition[], marketPrice: number) {
  const brokerIds = new Set(brokerPositions.map((position) => position.brokerOrderId));
  for (const position of activePositions) {
    if (position.status !== "OPEN") continue;
    if ((position.brokerOrderId && brokerIds.has(position.brokerOrderId)) || findBrokerPosition(position, brokerPositions)) continue;
    const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
    store.closePosition(position.id, marketPrice, pnl);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
    store.event("BROKER_POSITION_RECONCILED_CLOSED", position);
  }
}

function promoteFilledPendingPositions(activePositions: Position[], brokerPositions: Mt5BrokerPosition[]) {
  for (const position of activePositions) {
    if (position.status !== "PENDING") continue;
    const brokerPosition = brokerPositions.find(
      (broker) =>
        broker.side === position.side &&
        isLevelComment(broker.comment, position.side, position.levelIndex, broker.entryPrice, position.levelPrice)
    );
    if (!brokerPosition) continue;
    store.markPositionOpen(position.id, brokerPosition.entryPrice, brokerPosition.brokerOrderId);
    store.event("PENDING_ORDER_FILLED", { position, brokerPosition });
  }
}

function findBrokerPosition(position: Position, brokerPositions: Mt5BrokerPosition[]) {
  return brokerPositions.find(
    (broker) =>
      broker.side === position.side &&
      ((position.brokerOrderId && broker.brokerOrderId === position.brokerOrderId) ||
        isLevelComment(broker.comment, position.side, position.levelIndex, broker.entryPrice, position.levelPrice))
  );
}

function isLevelComment(comment: string, side: "BUY" | "SELL", levelIndex: number, brokerPrice: number, levelPrice: number) {
  const sideCode = side === "BUY" ? "B" : "S";
  if (comment === `ag-${sideCode}-${levelIndex}`) return true;
  return comment === `adaptive-grid-${side}`.slice(0, 15) && Math.abs(brokerPrice - levelPrice) <= 0.5;
}

function reconcileRemovedPendingOrders(activePositions: Position[], brokerPendingOrders: Mt5BrokerPendingOrder[]) {
  const brokerPendingIds = new Set(brokerPendingOrders.map((order) => order.brokerOrderId));
  for (const position of activePositions) {
    if (position.status !== "PENDING") continue;
    if (
      (position.brokerOrderId && brokerPendingIds.has(position.brokerOrderId)) ||
      brokerPendingOrders.some(
        (order) =>
          order.side === position.side &&
          isLevelComment(order.comment, position.side, position.levelIndex, order.price, position.levelPrice)
      )
    ) {
      continue;
    }
    store.closePosition(position.id, position.entryPrice, 0);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
    store.event("PENDING_ORDER_RECONCILED_REMOVED", position);
  }
}

async function executeIntent(intent: TradeIntent, marketPrice: number) {
  await withLock(`intent:${intent.idempotencyKey}`, 5000, async () => {
    const config = store.getConfig();
    const created = store.createIntent(intent);
    if (!created) return;
    let reservedOpenLevel = false;
    let brokerAcceptedOpen = false;
    try {
      if (intent.action === "OPEN") {
        reservedOpenLevel = store.reserveOpenLevel(intent.symbol, intent.side!, intent.levelIndex!);
        if (!reservedOpenLevel) {
          store.completeIntent(intent.idempotencyKey);
          store.event("ORDER_OPEN_SKIPPED", { ...intent, reason: "Level already open or reserved" });
          return;
        }
        const result = await adapter.open(
          intent.symbol,
          intent.side!,
          intent.volume!,
          intent.levelIndex,
          intent.levelPrice!,
          config.stopLoss,
          config.individualTakeProfit
        );
        if (!result.ok) throw new Error(result.error ?? "Broker rejected open order");
        if (result.skipped && !result.brokerOrderId) {
          store.releaseOpenLevel(intent.symbol, intent.side!, intent.levelIndex!);
          store.completeIntent(intent.idempotencyKey);
          store.event("ORDER_OPEN_SKIPPED", { ...intent, reason: result.reason ?? "Broker skipped open order" });
          return;
        }
        brokerAcceptedOpen = true;
        const position: Position = {
          id: randomUUID(),
          symbol: intent.symbol,
          side: intent.side!,
          levelIndex: intent.levelIndex!,
          levelPrice: intent.levelPrice!,
          entryPrice: result.price ?? marketPrice,
          volume: intent.volume!,
          status: result.pending ? "PENDING" : "OPEN",
          openedAt: new Date().toISOString(),
          brokerOrderId: result.brokerOrderId,
          reEntryCount: intent.reEntryCount ?? 0
        };
        store.insertOpenPosition(position);
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ORDER_OPENED", position);
      }
      if (intent.action === "CLOSE") {
        const result = await adapter.close(intent.symbol, intent.side, intent.volume, intent.levelIndex, intent.levelPrice);
        if (!result.ok) throw new Error(result.error ?? "Broker rejected close order");
        const position = store
          .listPositions()
          .find((p) => (p.status === "OPEN" || p.status === "PENDING") && p.side === intent.side && p.levelIndex === intent.levelIndex);
        if (position) {
          const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
          store.closePosition(position.id, marketPrice, pnl);
          store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
        }
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ORDER_CLOSED", intent);
      }
      if (intent.action === "CLOSE_ALL") {
        const result = await adapter.close(intent.symbol);
        if (!result.ok) throw new Error(result.error ?? "Broker rejected close all");
        for (const position of store.listPositions("OPEN")) {
          const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
          store.closePosition(position.id, marketPrice, pnl);
        }
        store.releaseAllOpenLevels(intent.symbol);
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ALL_CLOSED", intent);
      }
      if (intent.action === "DISABLE_DAY") {
        store.setEnabled(false);
        store.setEntryGate(null);
        store.completeIntent(intent.idempotencyKey);
      }
    } catch (error) {
      if (reservedOpenLevel && !brokerAcceptedOpen) {
        store.releaseOpenLevel(intent.symbol, intent.side!, intent.levelIndex!);
      }
      store.failIntent(intent.idempotencyKey, error instanceof Error ? error.message : String(error));
    }
  });
}

loop();
