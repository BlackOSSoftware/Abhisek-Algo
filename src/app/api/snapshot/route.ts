import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { secondsUntil, isPast, isTimeBetween } from "@/lib/time";
import { store } from "@/server/db";
import { isEntrySideReady, recentBreakoutMessage, resolveAdaptiveMarket } from "@/lib/adaptive-market";

export const dynamic = "force-dynamic";

const serverStartedAt = Date.now();
const startupGraceMs = positiveMs(process.env.MT5_STARTUP_GRACE_SECONDS, 90_000);
const maxTickAgeMs = positiveMs(process.env.MAX_TICK_AGE_SECONDS, 10_000);
const maxBrokerAgeMs = positiveMs(process.env.MAX_BROKER_SNAPSHOT_AGE_SECONDS, 15_000);

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const view = new URL(request.url).searchParams.get("view");
  const full = view !== "config" && view !== "settings";
  const config = store.getConfig();
  const tick = store.getTick();
  const tickUpdatedAt = store.getTickUpdatedAt();
  const enabled = store.getEnabled();
  const settings = store.getSettings();
  const storedMarket = store.getMarket();
  const market = storedMarket ? resolveAdaptiveMarket(storedMarket, settings) : null;
  const buyReady = isEntrySideReady(market, "BUY");
  const sellReady = isEntrySideReady(market, "SELL");
  const entryReady = config.direction === "both" ? buyReady || sellReady : config.direction === "buy" ? buyReady : sellReady;
  const now = new Date();
  const broker = full ? store.getBrokerSnapshot() : null;
  const health = getLiveHealth(tickUpdatedAt, broker?.updatedAt, broker?.error);
  const snapshot = {
    config,
    market,
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
      connected: health.live,
      live: health.live,
      issue: health.issue,
      state: health.state,
      tickAgeSeconds: health.tickAgeSeconds,
      canEnter: health.live && entryReady && settings.tickExecutionEnabled && enabled && isTimeBetween(config.tradingStartTime, config.tradingEndTime, now) && !isPast(config.entryCutoffTime, now),
      forceExitCountdownSeconds: secondsUntil(config.forceExitTime, now),
      message: health.issue ?? (!enabled ? "Trading disabled" : !entryReady ? recentBreakoutMessage(market, config.direction === "sell" ? "SELL" : "BUY") : settings.tickExecutionEnabled ? "MT5 order sync enabled" : "MT5 order sync disabled")
    }
  };
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

function getLiveHealth(tickUpdatedAt: string | undefined, brokerUpdatedAt: string | undefined, brokerError: string | undefined) {
  const now = Date.now();
  const tickAgeMs = ageMs(tickUpdatedAt, now);
  const brokerAgeMs = ageMs(brokerUpdatedAt, now);
  const tickAgeSeconds = Number.isFinite(tickAgeMs) ? Math.max(0, Math.floor(tickAgeMs / 1000)) : undefined;

  if (!tickUpdatedAt && now - serverStartedAt < startupGraceMs) {
    return { live: false, state: "starting" as const, issue: "MT5 starting, waiting for first live price", tickAgeSeconds };
  }
  if (brokerError) return { live: false, state: "offline" as const, issue: `MT5 worker issue: ${brokerError}`, tickAgeSeconds };
  if (!Number.isFinite(tickAgeMs)) return { live: false, state: "offline" as const, issue: "No live MT5 price received yet", tickAgeSeconds };
  if (tickAgeMs > maxTickAgeMs) {
    return {
      live: false,
      state: "stale" as const,
      issue: `Trading engine stopped. MT5 was closed or the MT5 worker is not running. Restart the full system from Start Trader.cmd before enabling the engine again. Last live update was ${Math.floor(tickAgeMs / 1000)} seconds ago.`,
      tickAgeSeconds
    };
  }
  if (brokerUpdatedAt && Number.isFinite(brokerAgeMs) && brokerAgeMs > maxBrokerAgeMs) {
    return {
      live: false,
      state: "stale" as const,
      issue: `Trading engine stopped. MT5 broker sync is not updating because the MT5 worker is not running. Restart the full system from Start Trader.cmd before enabling the engine again. Last broker sync was ${Math.floor(brokerAgeMs / 1000)} seconds ago.`,
      tickAgeSeconds
    };
  }
  return { live: true, state: "connected" as const, issue: undefined, tickAgeSeconds };
}

function ageMs(value: string | undefined, now: number) {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? now - timestamp : Number.NaN;
}

function positiveMs(value: string | undefined, fallback: number) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}
