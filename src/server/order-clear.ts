import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";

export async function clearMt5OrdersForSymbol({
  adapter,
  symbol,
  clearPendingOrders,
  closeLivePositions,
  eventType
}: {
  adapter: Mt5Adapter;
  symbol: string;
  clearPendingOrders: boolean;
  closeLivePositions: boolean;
  eventType: string;
}) {
  if (!clearPendingOrders && !closeLivePositions) {
    store.event(eventType, { symbol, clearPendingOrders, closeLivePositions, skipped: true });
    return;
  }

  const tick = await adapter.tick(symbol).catch(() => store.getTick());
  const broker = await adapter.clear(symbol, clearPendingOrders, closeLivePositions);
  if (!broker.ok) throw new Error(broker.error ?? "Broker rejected clear request");
  clearLocalActiveOrders(symbol, tick?.last, clearPendingOrders, closeLivePositions);
  store.event(eventType, { symbol, brokerOrderId: broker.brokerOrderId, clearPendingOrders, closeLivePositions });
}

function clearLocalActiveOrders(symbol: string, marketPrice: number | undefined, clearPendingOrders: boolean, closeLivePositions: boolean) {
  const active = store
    .listPositions()
    .filter(
      (position) =>
        position.symbol === symbol &&
        ((clearPendingOrders && position.status === "PENDING") || (closeLivePositions && position.status === "OPEN"))
    );
  for (const position of active) {
    const closePrice = position.status === "OPEN" ? marketPrice ?? position.entryPrice : position.entryPrice;
    const pnl = position.status === "OPEN" ? (position.side === "BUY" ? closePrice - position.entryPrice : position.entryPrice - closePrice) * position.volume : 0;
    store.closePosition(position.id, closePrice, pnl);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
  }
}
