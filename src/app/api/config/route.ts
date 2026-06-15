import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { configSchema } from "@/lib/validators";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { clearMt5OrdersForSymbol } from "@/server/order-clear";
import { createEntryStartGate } from "@/server/strategy-engine";
import type { Position, Side, StrategyConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function PUT(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const body = await request.json();
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const previous = store.getConfig();
  if (previous.direction !== parsed.data.direction) {
    const settings = store.getSettings();
    store.setConfig(parsed.data);
    store.setEntryGate(null);
    await clearMt5OrdersForSymbol({
      adapter,
      symbol: previous.symbol,
      clearPendingOrders: settings.directionSwitchClearPendingOrders,
      closeLivePositions: settings.directionSwitchCloseLivePositions,
      eventType: "MT5_CLEARED_ON_DIRECTION_SWITCH"
    });
    return NextResponse.json({ ok: true, config: parsed.data });
  }
  const market = store.getMarket();
  const tick = store.getTick();
  const [brokerPendingOrders, brokerPositions] = await Promise.all([
    adapter.pendingOrders(previous.symbol).catch(() => store.getBrokerSnapshot().pendingOrders),
    adapter.positions(previous.symbol).catch(() => store.getBrokerSnapshot().positions)
  ]);
  const changedPendingLegs = store.listPositions("PENDING").filter((position) => {
    if (position.symbol !== previous.symbol) return false;
    const nextLeg = parsed.data.legs[position.levelIndex - 1];
    if (!nextLeg?.enabled) return true;
    const nextLevelPrice = market ? levelPriceFor(parsed.data, position.side, position.levelIndex, market.adaptiveHigh, market.adaptiveLow) : position.levelPrice;
    const brokerOrder = brokerPendingOrders.find((order) => matchesBrokerOrder(order, position));
    const expectedTp = takeProfitFor(position.side, nextLevelPrice, parsed.data.individualTakeProfit);
    return (
      Math.abs(nextLeg.lotSize - position.volume) > 1e-8 ||
      Math.abs(nextLevelPrice - position.levelPrice) > 1e-8 ||
      Math.abs(parsed.data.stopLoss - previous.stopLoss) > 1e-8 ||
      Math.abs(parsed.data.individualTakeProfit - previous.individualTakeProfit) > 1e-8 ||
      !brokerOrder ||
      !priceClose(brokerOrder.price, nextLevelPrice) ||
      !priceClose(brokerOrder.stopLoss ?? 0, parsed.data.stopLoss) ||
      !priceClose(brokerOrder.takeProfit ?? 0, expectedTp)
    );
  });
  for (const position of changedPendingLegs) {
    const nextLeg = parsed.data.legs[position.levelIndex - 1];
    const nextLevelPrice = market ? levelPriceFor(parsed.data, position.side, position.levelIndex, market.adaptiveHigh, market.adaptiveLow) : position.levelPrice;
    const nextLot = nextLeg?.lotSize ?? position.volume;
    if (!nextLeg?.enabled || (tick && !isPendingWaiting(position.side, nextLevelPrice, position.side === "BUY" ? tick.ask : tick.bid))) {
      const result = await adapter.close(position.symbol, position.side, position.volume, position.levelIndex, position.levelPrice);
      if (!result.ok) {
        throw new Error(result.error ?? `Could not cancel pending order for leg ${position.levelIndex}`);
      }
      store.closePosition(position.id, position.entryPrice, 0);
      store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
      store.event("PENDING_ORDER_CANCELLED_ON_CONFIG_SYNC", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        oldLevelPrice: position.levelPrice,
        nextLevelPrice,
        reason: nextLeg?.enabled ? "New level already reached" : "Leg disabled"
      });
      continue;
    }
    const result = await adapter.replacePending(
      position.symbol,
      position.side,
      position.levelIndex,
      position.levelPrice,
      nextLevelPrice,
      nextLot,
      parsed.data.stopLoss,
      parsed.data.individualTakeProfit
    );
    if (!result.ok || !result.brokerOrderId) {
      throw new Error(result.error ?? `Could not update pending order for leg ${position.levelIndex}`);
    }
    store.updatePendingPosition(position.id, {
      levelPrice: result.price ?? nextLevelPrice,
      entryPrice: result.price ?? nextLevelPrice,
      volume: result.volume ?? nextLot,
      brokerOrderId: result.brokerOrderId
    });
    store.event("PENDING_ORDER_SYNCED_TO_CONFIG", {
      symbol: position.symbol,
      side: position.side,
      levelIndex: position.levelIndex,
      oldVolume: position.volume,
      newVolume: result.volume ?? nextLot,
      oldLevelPrice: position.levelPrice,
      newLevelPrice: result.price ?? nextLevelPrice,
      oldBrokerOrderId: position.brokerOrderId,
      brokerOrderId: result.brokerOrderId
    });
  }
  {
    const openPositions = store.listPositions("OPEN").filter((position) => {
      if (position.symbol !== previous.symbol) return false;
      const brokerPosition = brokerPositions.find((broker) => matchesBrokerOrder(broker, position));
      const expectedTp = takeProfitFor(position.side, position.entryPrice, parsed.data.individualTakeProfit);
      return (
        Math.abs(parsed.data.stopLoss - previous.stopLoss) > 1e-8 ||
        Math.abs(parsed.data.individualTakeProfit - previous.individualTakeProfit) > 1e-8 ||
        !brokerPosition ||
        !priceClose(brokerPosition.stopLoss ?? 0, parsed.data.stopLoss) ||
        !priceClose(brokerPosition.takeProfit ?? 0, expectedTp)
      );
    });
    for (const position of openPositions) {
      const marketPrice = tick?.last ?? position.entryPrice;
      const takeProfitReached =
        parsed.data.individualTakeProfit > 0 &&
        (position.side === "BUY"
          ? marketPrice >= position.entryPrice + parsed.data.individualTakeProfit
          : marketPrice <= position.entryPrice - parsed.data.individualTakeProfit);
      if (takeProfitReached) {
        const result = await adapter.close(position.symbol, position.side, position.volume, position.levelIndex, position.levelPrice);
        if (!result.ok) {
          throw new Error(result.error ?? `Could not close open leg ${position.levelIndex} after config update`);
        }
        const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
        store.closePosition(position.id, marketPrice, pnl);
        store.releaseOpenLevel(position.symbol, position.side, position.levelIndex);
        store.event("OPEN_POSITION_CLOSED_ON_CONFIG_TP_SYNC", {
          symbol: position.symbol,
          side: position.side,
          levelIndex: position.levelIndex,
          brokerOrderId: result.brokerOrderId,
          takeProfitPoints: parsed.data.individualTakeProfit
        });
        continue;
      }
      const result = await adapter.updatePositionProtection(
        position.symbol,
        position.side,
        position.levelIndex,
        parsed.data.stopLoss,
        parsed.data.individualTakeProfit
      );
      if (!result.ok) {
        throw new Error(result.error ?? `Could not update protection for open leg ${position.levelIndex}`);
      }
      store.event("OPEN_POSITION_PROTECTION_SYNCED_TO_CONFIG", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        brokerOrderId: result.brokerOrderId,
        stopLoss: parsed.data.stopLoss,
        takeProfitPoints: parsed.data.individualTakeProfit
      });
    }
  }
  store.setConfig(parsed.data);
  if (store.getEnabled() && market && tick) {
    store.setEntryGate(createEntryStartGate(parsed.data, market, tick));
  }
  return NextResponse.json({ ok: true, config: parsed.data });
}

function levelPriceFor(config: StrategyConfig, side: Side, levelIndex: number, adaptiveHigh: number, adaptiveLow: number) {
  const anchor = side === "BUY" ? adaptiveHigh : adaptiveLow;
  const distance = config.gridType === "percentage" ? (anchor * config.gridDistance) / 100 : config.gridDistance;
  return side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
}

function isPendingWaiting(side: Position["side"], levelPrice: number, marketPrice: number) {
  return side === "BUY" ? levelPrice < marketPrice : levelPrice > marketPrice;
}

function takeProfitFor(side: Side, entryPrice: number, takeProfitPoints: number) {
  return side === "BUY" ? entryPrice + takeProfitPoints : entryPrice - takeProfitPoints;
}

function priceClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.05;
}

function matchesBrokerOrder(order: { brokerOrderId?: string; comment?: string; price?: number; entryPrice?: number }, position: Position) {
  const sideCode = position.side === "BUY" ? "B" : "S";
  return (
    (position.brokerOrderId && order.brokerOrderId === position.brokerOrderId) ||
    order.comment === `ag-${sideCode}-${position.levelIndex}` ||
    (order.price !== undefined && priceClose(order.price, position.levelPrice)) ||
    (order.entryPrice !== undefined && priceClose(order.entryPrice, position.entryPrice))
  );
}
