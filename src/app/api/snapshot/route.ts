import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { secondsUntil, isPast, isTimeBetween } from "@/lib/time";
import { store } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const view = new URL(request.url).searchParams.get("view");
  const full = view !== "config" && view !== "settings";
  const config = store.getConfig();
  const tick = store.getTick();
  const enabled = store.getEnabled();
  const settings = store.getSettings();
  const now = new Date();
  const broker = full ? store.getBrokerSnapshot() : null;
  const snapshot = {
    config,
    market: store.getMarket(),
    tick,
    positions: full ? store.listActivePositions() : [],
    account: store.getAccount(),
    entryGate: store.getEntryGate(),
    settings,
    brokerPositions: broker?.positions ?? [],
    brokerPendingOrders: broker?.pendingOrders ?? [],
    brokerError: broker?.error,
    brokerUpdatedAt: broker?.updatedAt,
    events: full ? store.recentEvents(10) : [],
    recentIntents: full ? store.recentIntents(10) : [],
    status: {
      enabled,
      connected: Boolean(tick),
      canEnter: settings.tickExecutionEnabled && enabled && isTimeBetween(config.tradingStartTime, config.tradingEndTime, now) && !isPast(config.entryCutoffTime, now),
      forceExitCountdownSeconds: secondsUntil(config.forceExitTime, now),
      message: !enabled ? "Trading disabled" : settings.tickExecutionEnabled ? "MT5 order sync enabled" : "MT5 order sync disabled"
    }
  };
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}
