import "@/server/env";
import { randomUUID } from "node:crypto";
import { store } from "@/server/db";
import { withLock } from "@/server/locks";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { createEntryStartGate, evaluateStrategy } from "@/server/strategy-engine";
import { todayKey } from "@/lib/time";
import type { MarketState, Position, TradeIntent } from "@/lib/types";
import type { Mt5BrokerPendingOrder, Mt5BrokerPosition } from "@/server/mt5-adapter";

const adapter = new Mt5Adapter();
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
const dayRangeRefreshMs = Number(process.env.DAY_RANGE_REFRESH_MS ?? 30000);
let cachedDayRange: MarketState | null = null;
let lastDayRangeAt = 0;

async function loop() {
  const config = store.getConfig();
  try {
    const [tick, account, brokerPositions, brokerPendingOrders] = await Promise.all([
      adapter.tick(config.symbol),
      adapter.account(),
      adapter.positions(config.symbol),
      adapter.pendingOrders(config.symbol)
    ]);
    store.setTick(tick);
    store.setAccount(account);
    promoteFilledPendingPositions(brokerPositions);
    reconcileRemovedPendingOrders(brokerPendingOrders);
    reconcileClosedBrokerPositions(brokerPositions, tick.last);
    const existingMarket = store.getMarket();
    const nowMs = Date.now();
    const shouldRefreshDayRange = !cachedDayRange || !existingMarket || existingMarket.day !== todayKey() || nowMs - lastDayRangeAt >= dayRangeRefreshMs;
    if (shouldRefreshDayRange) {
      cachedDayRange = await adapter.dayRange(config.symbol);
      lastDayRangeAt = nowMs;
    }
    const market = existingMarket?.day === todayKey()
      ? cachedDayRange
        ? mergeMarket(existingMarket, cachedDayRange)
        : existingMarket
      : cachedDayRange ?? { adaptiveHigh: tick.last, adaptiveLow: tick.last, day: todayKey() };
    let entryGate = store.getEntryGate();
    if (store.getEnabled() && !entryGate) {
      entryGate = createEntryStartGate(config, market, tick);
      store.setEntryGate(entryGate);
    }
    const result = evaluateStrategy({
      config,
      tick,
      market,
      positions: store.listPositions().filter((position) => position.status === "OPEN" || position.status === "PENDING"),
      account,
      enabled: store.getEnabled(),
      entryGate
    });
    store.setMarket(result.market);
    for (const intent of result.intents) {
      await executeIntent(intent, tick.last);
    }
  } catch (error) {
    store.event("WORKER_ERROR", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    setTimeout(loop, intervalMs).unref();
  }
}

function mergeMarket(current: MarketState, dayRange: MarketState) {
  return {
    day: dayRange.day,
    adaptiveHigh: Math.max(current.adaptiveHigh, dayRange.adaptiveHigh),
    adaptiveLow: Math.min(current.adaptiveLow, dayRange.adaptiveLow),
    dayOpen: dayRange.dayOpen ?? current.dayOpen
  };
}

function reconcileClosedBrokerPositions(brokerPositions: Mt5BrokerPosition[], marketPrice: number) {
  const brokerIds = new Set(brokerPositions.map((position) => position.brokerOrderId));
  for (const position of store.listPositions("OPEN")) {
    if ((position.brokerOrderId && brokerIds.has(position.brokerOrderId)) || findBrokerPosition(position, brokerPositions)) continue;
    const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
    store.closePosition(position.id, marketPrice, pnl);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
    store.event("BROKER_POSITION_RECONCILED_CLOSED", position);
  }
}

function promoteFilledPendingPositions(brokerPositions: Mt5BrokerPosition[]) {
  for (const position of store.listPositions("PENDING")) {
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

function reconcileRemovedPendingOrders(brokerPendingOrders: Mt5BrokerPendingOrder[]) {
  const brokerPendingIds = new Set(brokerPendingOrders.map((order) => order.brokerOrderId));
  for (const position of store.listPositions("PENDING")) {
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
          reEntryCount: 0
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
