import { NextResponse } from "next/server";
import { isAdminAuthenticated, adminUnauthorized } from "@/lib/auth";
import { resolveSessionAdaptiveMarket } from "@/lib/adaptive-market";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { store } from "@/server/db";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function POST(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();

  const config = store.getConfig();
  const settings = store.getSettings();

  try {
    const live = await adapter.liveSnapshot(config.symbol);
    const previousMarket = store.getMarket();
    const { market, resetTriggered } = resolveSessionAdaptiveMarket(live.market, previousMarket, live.tick, settings);

    store.setTick(live.tick);
    store.setAccount(live.account);
    store.setMarket(market);
    store.setBrokerSnapshot({ positions: live.positions, pendingOrders: live.pendingOrders });

    if (resetTriggered) {
      store.clearDailyRuntimeCache(config.symbol);
      store.event("ADAPTIVE_DAILY_RESET", {
        symbol: config.symbol,
        resetTime: market.resetTime,
        resetSession: market.resetSession,
        previousHigh: previousMarket?.adaptiveHigh,
        previousLow: previousMarket?.adaptiveLow,
        nextHigh: market.adaptiveHigh,
        nextLow: market.adaptiveLow
      });
    }

    store.event("MT5_MANUAL_REFRESH_OK", { symbol: config.symbol, brokerSymbol: live.tick.symbol });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const broker = store.getBrokerSnapshot();
    store.setBrokerSnapshot({
      positions: broker.positions,
      pendingOrders: broker.pendingOrders,
      error: message
    });
    store.event("MT5_MANUAL_REFRESH_FAILED", { symbol: config.symbol, message });
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
