import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { configSchema } from "@/lib/validators";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { clearMt5OrdersForSymbol } from "@/server/order-clear";

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
  const changedPendingLegs = store.listPositions("PENDING").filter((position) => {
    if (position.symbol !== previous.symbol) return false;
    const nextLot = parsed.data.legs[position.levelIndex - 1]?.lotSize;
    return nextLot !== undefined && Math.abs(nextLot - position.volume) > 1e-8;
  });
  for (const position of changedPendingLegs) {
    const nextLot = parsed.data.legs[position.levelIndex - 1].lotSize;
    const result = await adapter.replacePending(position.symbol, position.side, position.levelIndex, position.levelPrice, nextLot);
    if (!result.ok || !result.brokerOrderId) {
      throw new Error(result.error ?? `Could not update pending order for leg ${position.levelIndex}`);
    }
    store.updatePendingPosition(position.id, result.volume ?? nextLot, result.brokerOrderId);
    store.event("PENDING_ORDER_VOLUME_UPDATED", {
      symbol: position.symbol,
      side: position.side,
      levelIndex: position.levelIndex,
      oldVolume: position.volume,
      newVolume: result.volume ?? nextLot,
      oldBrokerOrderId: position.brokerOrderId,
      brokerOrderId: result.brokerOrderId
    });
  }
  store.setConfig(parsed.data);
  return NextResponse.json({ ok: true, config: parsed.data });
}
