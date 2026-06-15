import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { todayKey } from "@/lib/time";
import type { Position, Side } from "@/lib/types";
import { store } from "@/server/db";
import { withLock } from "@/server/locks";
import { Mt5Adapter } from "@/server/mt5-adapter";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function POST(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const body = (await request.json()) as {
    action?: "place" | "unplace";
    symbol?: string;
    side?: Side;
    levelIndex?: number;
    levelPrice?: number;
    volume?: number;
  };

  if (!body.action || !body.symbol || !body.side || !body.levelIndex) {
    return NextResponse.json({ error: "Missing manual order fields" }, { status: 400 });
  }
  const action = body.action;
  const symbol = body.symbol;
  const side = body.side;
  const levelIndex = body.levelIndex;
  const config = store.getConfig();

  const result = await withLock(`manual:${symbol}:${side}:${levelIndex}`, 8000, async () => {
    const open = store
      .listPositions()
      .find(
        (position) =>
          (position.status === "OPEN" || position.status === "PENDING") &&
          position.symbol === symbol &&
          position.side === side &&
          position.levelIndex === levelIndex
      );

    if (action === "place") {
      if (open) return { ok: true, skipped: true, reason: "Position already open" };
      if (!body.volume || !body.levelPrice) return { ok: false, error: "Missing volume or level price" };
      if (!store.reserveOpenLevel(symbol, side, levelIndex)) {
        return { ok: true, skipped: true, reason: "Level already open or reserved" };
      }

      const intentKey = `${todayKey()}:${symbol}:${side}:${levelIndex}:manual-place:${Date.now()}`;
      store.createIntent({
        idempotencyKey: intentKey,
        symbol,
        action: "OPEN",
        side,
        levelIndex,
        levelPrice: body.levelPrice,
        volume: body.volume,
        reason: "Manual place from trade level chart"
      });

      let brokerAccepted = false;
      try {
        const tick = await adapter.tick(symbol);
        const triggerPrice = side === "BUY" ? tick.ask : tick.bid;
        const levelIsWaiting = side === "BUY" ? body.levelPrice < triggerPrice : body.levelPrice > triggerPrice;
        const broker = levelIsWaiting
          ? await adapter.open(symbol, side, body.volume, levelIndex, body.levelPrice, config.stopLoss, config.individualTakeProfit)
          : await adapter.openMarket(symbol, side, body.volume, levelIndex, config.stopLoss, config.individualTakeProfit);
        if (!broker.ok) throw new Error(broker.error ?? "Manual order rejected");
        if (broker.skipped && !broker.brokerOrderId) {
          store.releaseOpenLevel(symbol, side, levelIndex);
          store.completeIntent(intentKey);
          store.event("MANUAL_ORDER_SKIPPED", {
            symbol,
            side,
            levelIndex,
            levelPrice: body.levelPrice,
            reason: broker.reason ?? "Broker skipped manual order"
          });
          return { ok: true, skipped: true, reason: broker.reason ?? "Broker skipped manual order" };
        }
        brokerAccepted = true;

        const position: Position = {
          id: randomUUID(),
          symbol,
          side,
          levelIndex,
          levelPrice: body.levelPrice,
          entryPrice: broker.price ?? body.levelPrice,
          volume: body.volume,
          status: broker.pending ? "PENDING" : "OPEN",
          openedAt: new Date().toISOString(),
          brokerOrderId: broker.brokerOrderId,
          reEntryCount: 0
        };
        store.insertOpenPosition(position);
        store.setLegEnabled(symbol, levelIndex, true);
        store.completeIntent(intentKey, broker.brokerOrderId);
        store.event("MANUAL_ORDER_PLACED", { ...position, execution: broker.pending ? "pending" : "market" });
        return { ok: true, execution: broker.pending ? "pending" : "market" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!brokerAccepted) store.releaseOpenLevel(symbol, side, levelIndex);
        store.failIntent(intentKey, message);
        throw error;
      }
    }

    if (!open) return { ok: true, skipped: true, reason: "No open position on this leg" };
    const intentKey = `${todayKey()}:${symbol}:${side}:${levelIndex}:manual-unplace:${Date.now()}`;
    store.createIntent({
      idempotencyKey: intentKey,
      symbol,
      action: "CLOSE",
      side,
      levelIndex,
      levelPrice: open.entryPrice,
      volume: open.volume,
      reason: "Manual unplace from trade level chart"
    });

    const broker = await adapter.close(symbol, side, open.volume, levelIndex, open.levelPrice);
    if (!broker.ok) throw new Error(broker.error ?? "Manual close rejected");
    const tick = store.getTick();
    const closePrice = tick?.last ?? open.entryPrice;
    const pnl = (open.side === "BUY" ? closePrice - open.entryPrice : open.entryPrice - closePrice) * open.volume;
    store.closePosition(open.id, closePrice, pnl);
    store.releaseOpenLevel(open.symbol, open.side, open.levelIndex);
    store.disableLeg(open.symbol, open.levelIndex);
    store.completeIntent(intentKey, broker.brokerOrderId);
    store.event("MANUAL_ORDER_UNPLACED", open);
    return { ok: true };
  });

  return NextResponse.json(result ?? { ok: false, error: "Manual order is locked" });
}
