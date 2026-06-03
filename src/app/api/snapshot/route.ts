import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { secondsUntil, isPast, isTimeBetween } from "@/lib/time";
import type { BrokerPendingOrder, BrokerPosition } from "@/lib/types";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const config = store.getConfig();
  const tick = store.getTick();
  const enabled = store.getEnabled();
  const now = new Date();
  let brokerPositions: BrokerPosition[] = [];
  let brokerPendingOrders: BrokerPendingOrder[] = [];
  let brokerError: string | undefined;
  try {
    [brokerPositions, brokerPendingOrders] = await Promise.all([
      adapter.positions(config.symbol),
      adapter.pendingOrders(config.symbol)
    ]);
  } catch (error) {
    brokerError = error instanceof Error ? error.message : String(error);
  }
  const snapshot = {
    config,
    market: store.getMarket(),
    tick,
    positions: store.listActivePositions(),
    account: store.getAccount(),
    entryGate: store.getEntryGate(),
    settings: store.getSettings(),
    brokerPositions,
    brokerPendingOrders,
    brokerError,
    events: store.recentEvents(40),
    recentIntents: store.recentIntents(40),
    status: {
      enabled,
      connected: Boolean(tick),
      canEnter: enabled && isTimeBetween(config.tradingStartTime, config.tradingEndTime, now) && !isPast(config.entryCutoffTime, now),
      forceExitCountdownSeconds: secondsUntil(config.forceExitTime, now),
      message: enabled ? "Live engine enabled" : "Trading disabled"
    }
  };
  return NextResponse.json(snapshot);
}
