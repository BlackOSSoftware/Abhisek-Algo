import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { resolveAdaptiveMarket } from "@/lib/adaptive-market";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { clearMt5OrdersForSymbol } from "@/server/order-clear";
import { createEntryStartGate } from "@/server/strategy-engine";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function POST(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const body = (await request.json()) as { enabled?: boolean; action?: "close-all" };
  if (typeof body.enabled === "boolean") {
    if (body.enabled) {
      const config = store.getConfig();
      if (!config.stopLoss || config.stopLoss <= 0) {
        return NextResponse.json({ ok: false, error: "Stop loss is required before trading can start" }, { status: 400 });
      }
      const settings = store.getSettings();
      const [tick, rawMarket] = await Promise.all([adapter.tick(config.symbol), adapter.dayRange(config.symbol)]);
      const market = resolveAdaptiveMarket(rawMarket, settings);
      store.setTick(tick);
      store.setMarket(market);
      store.setEntryGate(createEntryStartGate(config, market, tick));
      store.setEnabled(true);
    } else {
      const config = store.getConfig();
      const settings = store.getSettings();
      store.setEnabled(false);
      store.setEntryGate(null);
      await clearMt5OrdersForSymbol({
        adapter,
        symbol: config.symbol,
        clearPendingOrders: settings.disableClearPendingOrders,
        closeLivePositions: settings.disableCloseLivePositions,
        eventType: "MT5_CLEARED_ON_DISABLE"
      });
    }
  }
  if (body.action === "close-all") {
    const config = store.getConfig();
    await clearMt5OrdersForSymbol({
      adapter,
      symbol: config.symbol,
      clearPendingOrders: true,
      closeLivePositions: true,
      eventType: "MANUAL_CLOSE_ALL_REQUESTED"
    });
    store.setEntryGate(null);
    store.setEnabled(false);
  }
  return NextResponse.json({ ok: true, enabled: store.getEnabled() });
}
