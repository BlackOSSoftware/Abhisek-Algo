import { brokerTakeProfit } from "@/lib/take-profit";
import "@/server/env";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { store } from "@/server/db";
import { withLock } from "@/server/locks";
import { Mt5Adapter } from "@/server/mt5-adapter";
import { matchesBrokerPending, matchesBrokerPosition } from "@/server/broker-matching";
import { rotateLogFiles } from "@/server/maintenance";
import { createEntryStartGate, evaluateStrategy, releaseRecoveredEntryLocks } from "@/server/strategy-engine";
import { isEntrySideReady, resolveSessionAdaptiveMarket } from "@/lib/adaptive-market";
import type { MarketState, Position, Side, StrategyConfig, Tick, TradeIntent } from "@/lib/types";
import type { Mt5BrokerPendingOrder, Mt5BrokerPosition } from "@/server/mt5-adapter";

const adapter = new Mt5Adapter();
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 500);
const maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 300000);
let lastMaintenanceAt = 0;
let lastTickExecutionSkippedAt = 0;
let consecutiveWorkerFailures = 0;
const browserRequired = process.env.TRADER_BROWSER_REQUIRED === "true";
const browserProfileDir = process.env.TRADER_BROWSER_PROFILE_DIR;
const browserGraceMs = Number(process.env.TRADER_BROWSER_GRACE_SECONDS ?? 180) * 1000;
const workerStartedAt = Date.now();
const launcherPid = Number(process.env.TRADER_LAUNCHER_PID);

async function loop() {
  if (shouldStopWithLauncher()) {
    stopWorker("Launcher or Chrome UI was closed. Stopping MT5 worker.");
    return;
  }

  const config = store.getConfig();
  const settings = store.getSettings();
  try {
    const live = await adapter.liveSnapshot(config.symbol);
    const { tick, account } = live;
    assertUsableTick(tick);
    const previousMarket = store.getMarket();
    const { market, resetTriggered } = resolveSessionAdaptiveMarket(live.market, previousMarket, tick, settings);
    const brokerPositions = live.positions;
    const brokerPendingOrders = live.pendingOrders;
    store.setTick(tick);
    store.setAccount(account);
    store.setMarket(market);
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
    store.setBrokerSnapshot({ positions: brokerPositions, pendingOrders: brokerPendingOrders });
    let activePositions = store.listActivePositions();
    promoteFilledPendingPositions(activePositions, brokerPositions);
    activePositions = store.listActivePositions();
    reconcileRemovedPendingOrders(activePositions, brokerPendingOrders);
    reconcileClosedBrokerPositions(activePositions, brokerPositions, tick.last);
    await reconcileOpenPositionProtection(config, store.listActivePositions(), brokerPositions);
    if (!settings.tickExecutionEnabled) {
      if (Date.now() - lastTickExecutionSkippedAt > 60000) {
        lastTickExecutionSkippedAt = Date.now();
        store.event("MT5_ORDER_SYNC_SKIPPED", { symbol: config.symbol });
      }
      return;
    }
    await syncPendingGridToMarket(config, market, tick, settings.adaptiveHighLowMode === "recent");
    let entryGate = store.getEntryGate();
    if (store.getEnabled() && !entryGate) {
      entryGate = createEntryStartGate(config, market, tick);
      store.setEntryGate(entryGate);
    }
    if (entryGate) {
      const releasedGate = releaseRecoveredEntryLocks(config, market, tick, entryGate);
      if (releasedGate && releasedGate.lockedLevels.length !== entryGate.lockedLevels.length) {
        entryGate = releasedGate;
        store.setEntryGate(entryGate);
      }
    }
    const strategyPositions = [...store.listActivePositions(), ...store.listPositions("CLOSED", 500)];
    const result = evaluateStrategy({
      config,
      tick,
      market,
      positions: strategyPositions,
      account,
      enabled: store.getEnabled(),
      settings,
      entryGate
    });
    for (const intent of result.intents) {
      await executeIntent(intent, tick.last);
    }
    consecutiveWorkerFailures = 0;
  } catch (error) {
    consecutiveWorkerFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    const broker = store.getBrokerSnapshot();
    store.setBrokerSnapshot({
      positions: broker.positions,
      pendingOrders: broker.pendingOrders,
      error: message
    });
    store.event("WORKER_ERROR", { message, consecutiveWorkerFailures });
    if (store.getEnabled()) {
      store.setEnabled(false);
      store.setEntryGate(null);
      store.event("TRADING_PAUSED_MT5_UNHEALTHY", { message, consecutiveWorkerFailures });
    }
  } finally {
    runMaintenance();
    if (!shouldStopWithLauncher()) {
      setTimeout(loop, intervalMs).unref();
    } else {
      stopWorker("Launcher or Chrome UI was closed. Stopping MT5 worker.");
    }
  }
}

async function syncPendingGridToMarket(config: StrategyConfig, market: MarketState, tick: Tick, recentMode: boolean) {
  if (recentMode) return;
  const pendingPositions = store.listPositions("PENDING").filter((position) => position.symbol === config.symbol);
  for (const position of pendingPositions) {
    if (!isEntrySideReady(market, position.side)) {
      if (!position.brokerOrderId) throw new Error("Cannot cancel blocked pending entry without broker ticket");
      const result = await adapter.cancelPendingTicket(position.symbol, position.brokerOrderId);
      if (!result.ok) throw new Error(result.error ?? "Could not cancel entry awaiting breakout");
      if (!result.skipped) {
        store.closePosition(position.id, position.entryPrice, 0);
        store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
        store.event("PENDING_ORDER_CANCELLED_AWAITING_BREAKOUT", { brokerOrderId: position.brokerOrderId, side: position.side });
      }
      continue;
    }
    const leg = config.legs[position.levelIndex - 1];
    const nextLevelPrice = levelPriceFor(config, position.side, position.levelIndex, market);
    const nextLot = leg?.lotSize ?? position.volume;
    const triggerPrice = position.side === "BUY" ? tick.ask : tick.bid;
    const shouldCancel = !leg?.enabled || !isPendingWaiting(position.side, nextLevelPrice, triggerPrice);

    try {
      if (shouldCancel) {
        const result = await adapter.close(position.symbol, position.side, position.volume, position.levelIndex, position.levelPrice);
        if (!result.ok) throw new Error(result.error ?? `Could not cancel pending order for leg ${position.levelIndex}`);
        store.closePosition(position.id, position.entryPrice, 0);
        store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
        store.event("PENDING_ORDER_CANCELLED_ON_ADAPTIVE_SYNC", {
          symbol: position.symbol,
          side: position.side,
          levelIndex: position.levelIndex,
          oldLevelPrice: position.levelPrice,
          nextLevelPrice,
          reason: leg?.enabled ? "New adaptive level already reached" : "Leg disabled"
        });
        continue;
      }

      if (Math.abs(nextLevelPrice - position.levelPrice) <= 1e-8 && Math.abs(nextLot - position.volume) <= 1e-8) continue;
      const result = await adapter.replacePending(
        position.symbol,
        position.side,
        position.levelIndex,
        position.levelPrice,
        nextLevelPrice,
        nextLot,
        config.stopLoss,
        brokerTakeProfit(config)
      );
      if (!result.ok || !result.brokerOrderId) throw new Error(result.error ?? `Could not update pending order for leg ${position.levelIndex}`);
      store.updatePendingPosition(position.id, {
        levelPrice: result.price ?? nextLevelPrice,
        entryPrice: result.price ?? nextLevelPrice,
        volume: result.volume ?? nextLot,
        brokerOrderId: result.brokerOrderId
      });
      store.event("PENDING_ORDER_SYNCED_TO_ADAPTIVE_MARKET", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        oldLevelPrice: position.levelPrice,
        newLevelPrice: result.price ?? nextLevelPrice,
        oldVolume: position.volume,
        newVolume: result.volume ?? nextLot
      });
    } catch (error) {
      store.event("PENDING_ORDER_ADAPTIVE_SYNC_FAILED", {
        symbol: position.symbol,
        side: position.side,
        levelIndex: position.levelIndex,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function levelPriceFor(config: StrategyConfig, side: Side, levelIndex: number, market: MarketState) {
  const anchor = side === "BUY" ? market.adaptiveHigh : market.adaptiveLow;
  const distance = config.gridType === "percentage" ? (anchor * config.gridDistance) / 100 : config.gridDistance;
  return side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
}

function isPendingWaiting(side: Side, levelPrice: number, marketPrice: number) {
  return side === "BUY" ? levelPrice < marketPrice : levelPrice > marketPrice;
}

function runMaintenance() {
  const nowMs = Date.now();
  if (nowMs - lastMaintenanceAt < maintenanceIntervalMs) return;
  lastMaintenanceAt = nowMs;
  try {
    store.maintenance();
    rotateLogFiles();
  } catch (error) {
    store.event("MAINTENANCE_ERROR", { message: error instanceof Error ? error.message : String(error) });
  }
}

function reconcileClosedBrokerPositions(activePositions: Position[], brokerPositions: Mt5BrokerPosition[], marketPrice: number) {
  for (const position of activePositions) {
    if (position.status !== "OPEN") continue;
    if (brokerPositions.some((broker) => matchesBrokerPosition(position, broker))) continue;
    const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
    store.closePosition(position.id, marketPrice, pnl);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
    store.event("BROKER_POSITION_RECONCILED_CLOSED", position);
  }
}

function promoteFilledPendingPositions(activePositions: Position[], brokerPositions: Mt5BrokerPosition[]) {
  for (const position of activePositions) {
    if (position.status !== "PENDING") continue;
    const brokerPosition = brokerPositions.find((broker) => matchesBrokerPosition(position, broker));
    if (!brokerPosition) continue;
    store.markPositionOpen(position.id, brokerPosition.entryPrice, brokerPosition.brokerOrderId);
    store.event("PENDING_ORDER_FILLED", { position, brokerPosition });
  }
}

async function reconcileOpenPositionProtection(
  config: StrategyConfig,
  activePositions: Position[],
  brokerPositions: Mt5BrokerPosition[]
) {
  for (const position of activePositions) {
    if (position.status !== "OPEN") continue;
    const brokerPosition = brokerPositions.find((broker) => matchesBrokerPosition(position, broker));
    if (!brokerPosition) continue;
    try {
      const result = await adapter.updatePositionProtection(
        position.symbol,
        position.side,
        position.levelIndex,
        brokerPosition.entryPrice,
        config.stopLoss,
        brokerTakeProfit(config),
        brokerPosition.brokerOrderId
      );
      if (result.ok && !result.skipped) {
        store.event("POSITION_PROTECTION_SYNCED", {
          brokerOrderId: brokerPosition.brokerOrderId,
          side: position.side,
          entryPrice: brokerPosition.entryPrice,
          stopLoss: config.stopLoss,
          takeProfitPoints: brokerTakeProfit(config)
        });
      }
    } catch (error) {
      store.event("POSITION_PROTECTION_SYNC_FAILED", {
        brokerOrderId: brokerPosition.brokerOrderId,
        side: position.side,
        entryPrice: brokerPosition.entryPrice,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function reconcileRemovedPendingOrders(activePositions: Position[], brokerPendingOrders: Mt5BrokerPendingOrder[]) {
  for (const position of activePositions) {
    if (position.status !== "PENDING") continue;
    if (brokerPendingOrders.some((order) => matchesBrokerPending(position, order))) {
      continue;
    }
    store.closePosition(position.id, position.entryPrice, 0);
    store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
    store.event("PENDING_ORDER_RECONCILED_REMOVED", position);
  }
}

async function executeIntent(intent: TradeIntent, marketPrice: number) {
  await withLock(`intent:${intent.idempotencyKey}`, 5000, async () => {
    const config = store.getConfig();
    const created = store.createIntent(intent);
    if (!created) return;
    let reservedOpenLevel = false;
    let brokerAcceptedOpen = false;
    try {
      if (intent.action === "OPEN") {
        reservedOpenLevel = store.reserveOpenLevel(intent.symbol, intent.side!, intent.levelIndex!, intent.levelPrice!);
        if (!reservedOpenLevel) {
          store.completeIntent(intent.idempotencyKey);
          store.event("ORDER_OPEN_SKIPPED", { ...intent, reason: "Level already open or reserved" });
          return;
        }
        const result = await adapter.open(
          intent.symbol,
          intent.side!,
          intent.volume!,
          intent.levelIndex,
          intent.levelPrice!,
          config.stopLoss,
          brokerTakeProfit(config),
          intent.pendingOrderType
        );
        if (!result.ok) throw new Error(result.error ?? "Broker rejected open order");
        if (result.skipped && !result.brokerOrderId) {
          store.releaseOpenLevel(intent.symbol, intent.side!, intent.levelIndex!, intent.levelPrice);
          store.completeIntent(intent.idempotencyKey);
          store.event("ORDER_OPEN_SKIPPED", { ...intent, reason: result.reason ?? "Broker skipped open order" });
          return;
        }
        brokerAcceptedOpen = true;
        const position: Position = {
          id: randomUUID(),
          symbol: intent.symbol,
          side: intent.side!,
          levelIndex: intent.levelIndex!,
          levelPrice: intent.levelPrice!,
          entryPrice: result.price ?? marketPrice,
          volume: intent.volume!,
          status: result.pending ? "PENDING" : "OPEN",
          openedAt: new Date().toISOString(),
          brokerOrderId: result.brokerOrderId,
          reEntryCount: intent.reEntryCount ?? 0
        };
        store.insertOpenPosition(position);
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ORDER_OPENED", position);
      }
      if (intent.action === "CLOSE") {
        const result = await adapter.close(intent.symbol, intent.side, intent.volume, intent.levelIndex, intent.levelPrice);
        if (!result.ok) throw new Error(result.error ?? "Broker rejected close order");
        const position = store
          .listPositions()
          .find(
            (p) =>
              (p.status === "OPEN" || p.status === "PENDING") &&
              p.side === intent.side &&
              p.levelIndex === intent.levelIndex &&
              intent.levelPrice !== undefined &&
              priceClose(p.levelPrice, intent.levelPrice)
          );
        if (position) {
          const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
          store.closePosition(position.id, marketPrice, pnl);
          store.releaseOpenLevel(position.symbol, position.side, position.levelIndex, position.levelPrice);
        }
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ORDER_CLOSED", intent);
      }
      if (intent.action === "CLOSE_ALL") {
        const result = await adapter.close(intent.symbol);
        if (!result.ok) throw new Error(result.error ?? "Broker rejected close all");
        for (const position of store.listPositions("OPEN")) {
          const pnl = (position.side === "BUY" ? marketPrice - position.entryPrice : position.entryPrice - marketPrice) * position.volume;
          store.closePosition(position.id, marketPrice, pnl);
        }
        store.releaseAllOpenLevels(intent.symbol);
        store.completeIntent(intent.idempotencyKey, result.brokerOrderId);
        store.event("ALL_CLOSED", intent);
      }
      if (intent.action === "DISABLE_DAY") {
        store.setEnabled(false);
        store.setEntryGate(null);
        store.completeIntent(intent.idempotencyKey);
      }
    } catch (error) {
      if (reservedOpenLevel && !brokerAcceptedOpen) {
        store.releaseOpenLevel(intent.symbol, intent.side!, intent.levelIndex!, intent.levelPrice);
      }
      store.failIntent(intent.idempotencyKey, error instanceof Error ? error.message : String(error));
    }
  });
}

function priceClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.05;
}

function assertUsableTick(tick: Tick) {
  if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask) || !Number.isFinite(tick.last)) {
    throw new Error("MT5 returned an invalid quote");
  }
  if (tick.bid <= 0 || tick.ask <= 0 || tick.last <= 0) {
    throw new Error("MT5 returned an empty quote");
  }
}

function shouldStopWithLauncher() {
  if (!browserRequired) return false;
  if (Number.isFinite(launcherPid) && launcherPid > 0 && !processExists(launcherPid)) return true;
  if (!browserProfileDir) return false;
  if (Date.now() - workerStartedAt < browserGraceMs) return false;
  return !browserWindowOpen(browserProfileDir);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function browserWindowOpen(profileDir: string) {
  if (process.platform !== "win32") return true;
  const script = `
$escapedProfile = [regex]::Escape('${profileDir.replace(/'/g, "''")}')
$browserProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
  $_.CommandLine -match $escapedProfile
}
foreach ($browserProcessInfo in $browserProcesses) {
  $process = Get-Process -Id $browserProcessInfo.ProcessId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    Write-Output "open"
    exit 0
  }
}
Write-Output "closed"
`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).includes("open");
  } catch {
    return false;
  }
}

function stopWorker(message: string) {
  try {
    if (store.getEnabled()) {
      store.setEnabled(false);
      store.setEntryGate(null);
    }
    const broker = store.getBrokerSnapshot();
    store.setBrokerSnapshot({
      positions: broker.positions,
      pendingOrders: broker.pendingOrders,
      error: message
    });
    store.event("WORKER_STOPPED_WITH_LAUNCHER", { message });
  } finally {
    process.exit(0);
  }
}

loop();
