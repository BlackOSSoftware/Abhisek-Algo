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
  const wasEnabled = store.getEnabled();
  store.setConfig(parsed.data);
  await clearMt5OrdersForSymbol({
    adapter,
    symbol: previous.symbol,
    clearPendingOrders: true,
    closeLivePositions: false,
    eventType: "PENDING_ORDERS_CLEARED_ON_CONFIG_SAVE"
  });
  const cleanCounts = store.cleanRuntimeState();
  store.setConfig(parsed.data);
  if (wasEnabled) store.setEnabled(true);
  store.event("DATABASE_RUNTIME_CLEANED_ON_CONFIG_SAVE", cleanCounts);
  return NextResponse.json({ ok: true, config: parsed.data });
}
