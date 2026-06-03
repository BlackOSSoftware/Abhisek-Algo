import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { secondsUntil, isPast, isTimeBetween } from "@/lib/time";
import { store } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const config = store.getConfig();
  const tick = store.getTick();
  const enabled = store.getEnabled();
  const now = new Date();
  const snapshot = {
    config,
    market: store.getMarket(),
    tick,
    positions: store.listActivePositions(),
    account: store.getAccount(),
    entryGate: store.getEntryGate(),
    settings: store.getSettings(),
    events: [],
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
