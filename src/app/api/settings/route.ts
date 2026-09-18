import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { settingsSchema } from "@/lib/validators";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { clearMt5OrdersForSymbol } from "@/server/order-clear";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  return NextResponse.json({ ok: true, settings: store.getSettings() });
}

export async function PUT(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const body = await request.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const previous = store.getSettings();
  const modeChanged = previous.adaptiveHighLowMode !== parsed.data.adaptiveHighLowMode;
  store.setSettings(parsed.data);
  if (
    modeChanged ||
    previous.manualAdaptiveHigh !== parsed.data.manualAdaptiveHigh ||
    previous.manualAdaptiveLow !== parsed.data.manualAdaptiveLow ||
    previous.adaptiveDailyResetTime !== parsed.data.adaptiveDailyResetTime ||
    previous.recentDailyResetTime !== parsed.data.recentDailyResetTime ||
    previous.recentLegCount !== parsed.data.recentLegCount
  ) {
    store.setEntryGate(null);
  }
  if (modeChanged) {
    const config = store.getConfig();
    await clearMt5OrdersForSymbol({
      adapter,
      symbol: config.symbol,
      clearPendingOrders: true,
      closeLivePositions: parsed.data.modeSwitchCloseLivePositions,
      eventType: "PENDING_ORDERS_CLEARED_ON_MODE_CHANGE"
    });
  }
  return NextResponse.json({ ok: true, settings: parsed.data });
}
