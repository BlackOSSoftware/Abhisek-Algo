import { todayKey, isPast, isTimeBetween, secondsUntil } from "@/lib/time";
import type { AccountSnapshot, EntryStartGate, MarketState, Position, Side, StrategyConfig, Tick, TradeIntent } from "@/lib/types";

export function evaluateStrategy(input: {
  config: StrategyConfig;
  tick: Tick;
  market: MarketState | null;
  positions: Position[];
  account: AccountSnapshot;
  enabled: boolean;
  entryGate?: EntryStartGate | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const config = input.config;
  const price = input.tick.last || mid(input.tick.bid, input.tick.ask);
  const nextMarket = input.market ?? { adaptiveHigh: price, adaptiveLow: price, day: todayKey(now) };
  const day = nextMarket.day;
  const marketReady = Boolean(input.market);
  const active = input.positions.filter((p) => p.status === "OPEN" || p.status === "PENDING");
  const closed = input.positions.filter((p) => p.status === "CLOSED");
  const open = input.positions.filter((p) => p.status === "OPEN");
  const intents: TradeIntent[] = [];
  const warnings: string[] = [];
  const canTradeSession = isTimeBetween(config.tradingStartTime, config.tradingEndTime, now);
  const canEnter = marketReady && canTradeSession && !isPast(config.entryCutoffTime, now) && input.enabled;
  const spread = Math.abs(input.tick.ask - input.tick.bid);

  if (!marketReady) warnings.push("MT5 day candle unavailable");
  if (!input.enabled) warnings.push("Trading disabled");
  if (!canTradeSession) warnings.push("Outside trading session");
  if (config.enableSpreadFilter && spread > config.maxSpread) warnings.push("Spread filter active");

  const floatingPnl = estimatePnl(open, price);
  if (input.enabled && config.basketTakeProfit > 0 && floatingPnl >= config.basketTakeProfit) {
    intents.push(closeAll(config, "Basket take profit reached"));
  }
  if (input.enabled && config.stopLoss > 0) {
    const buyStopped = open.some((p) => p.side === "BUY" && price <= config.stopLoss);
    const sellStopped = open.some((p) => p.side === "SELL" && price >= config.stopLoss);
    if (buyStopped || sellStopped) intents.push(closeAll(config, "Stop loss reached"));
  }
  if (input.enabled && config.basketStopLoss > 0 && floatingPnl <= -config.basketStopLoss) {
    intents.push(closeAll(config, "Basket stop loss reached"));
  }
  if (input.enabled && config.dailyDrawdown > 0 && input.account.balance > 0) {
    const lossLimit = (input.account.balance * config.dailyDrawdown) / 100;
    if (input.account.dailyRealizedPnl + floatingPnl <= -lossLimit) {
      intents.push(closeAll(config, "Daily drawdown limit reached"));
      intents.push({ idempotencyKey: `${day}:${config.symbol}:disable-day`, symbol: config.symbol, action: "DISABLE_DAY", reason: "Daily drawdown lock" });
    }
  }

  if (input.enabled && config.forceExitEnabled && isPast(config.forceExitTime, now)) {
    intents.push(closeAll(config, "Force exit time reached"));
  }

  for (const p of open) {
    const tp = config.individualTakeProfit;
    if (p.side === "BUY" && price >= p.entryPrice + tp) intents.push(closeOne(config, p, price, "Buy leg take profit"));
    if (p.side === "SELL" && price <= p.entryPrice - tp) intents.push(closeOne(config, p, price, "Sell leg take profit"));
  }

  if (canEnter && !(config.enableSpreadFilter && spread > config.maxSpread) && intents.every((i) => i.action !== "CLOSE_ALL")) {
    if (config.direction === "buy" || config.direction === "both") {
      intents.push(...entryIntents(config, "BUY", nextMarket.adaptiveHigh, active, closed, entryTriggerPrice(input.tick, "BUY"), input.entryGate, day));
    }
    if (config.direction === "sell" || config.direction === "both") {
      intents.push(...entryIntents(config, "SELL", nextMarket.adaptiveLow, active, closed, entryTriggerPrice(input.tick, "SELL"), input.entryGate, day));
    }
  }

  return {
    market: nextMarket,
    intents: dedupeIntents(intents),
    floatingPnl,
    canEnter,
    statusMessage: warnings[0] ?? "Live engine ready",
    forceExitCountdownSeconds: secondsUntil(config.forceExitTime, now)
  };
}

export function createEntryStartGate(config: StrategyConfig, market: MarketState | null, tick: Tick | null, now = new Date()): EntryStartGate | null {
  if (!market || !tick) return null;
  const day = market.day || todayKey(now);
  const lockedLevels: EntryStartGate["lockedLevels"] = [];

  if (config.direction === "buy" || config.direction === "both") {
    lockedLevels.push(...reachedLevelsAtStart(config, "BUY", market.adaptiveHigh, entryTriggerPrice(tick, "BUY")));
  }
  if (config.direction === "sell" || config.direction === "both") {
    lockedLevels.push(...reachedLevelsAtStart(config, "SELL", market.adaptiveLow, entryTriggerPrice(tick, "SELL")));
  }

  return {
    day,
    symbol: config.symbol,
    buyAnchor: config.direction === "buy" || config.direction === "both" ? market.adaptiveHigh : undefined,
    sellAnchor: config.direction === "sell" || config.direction === "both" ? market.adaptiveLow : undefined,
    lockedLevels
  };
}

export function releaseRecoveredEntryLocks(
  config: StrategyConfig,
  market: MarketState,
  tick: Tick,
  entryGate: EntryStartGate | null | undefined
): EntryStartGate | null {
  if (!entryGate || entryGate.day !== market.day || entryGate.symbol !== config.symbol) return entryGate ?? null;
  const lockedLevels = entryGate.lockedLevels.filter((level) => {
    const anchor = level.side === "BUY" ? market.adaptiveHigh : market.adaptiveLow;
    const price = entryTriggerPrice(tick, level.side);
    return !hasRecoveredStartLockedLevel(config, level.side, level.levelIndex, anchor, price);
  });
  if (lockedLevels.length === entryGate.lockedLevels.length) return entryGate;
  return { ...entryGate, lockedLevels };
}

function entryIntents(
  config: StrategyConfig,
  side: Side,
  anchor: number,
  active: Position[],
  closed: Position[],
  price: number,
  entryGate: EntryStartGate | null | undefined,
  day: string
): TradeIntent[] {
  const intents: TradeIntent[] = [];
  const distance = gridDistance(config, anchor);
  const maxConfiguredLegs = Math.min(config.maxLegs, config.legs?.length || config.maxLegs);

  const currentLots = active.reduce((sum, p) => sum + p.volume, 0);
  const activeLevels = new Set(active.filter((p) => p.side === side).map((p) => p.levelIndex));
  for (let levelIndex = 1; levelIndex <= maxConfiguredLegs; levelIndex += 1) {
    if (activeLevels.has(levelIndex)) continue;
    const legConfig = config.legs?.[levelIndex - 1];
    if (legConfig && !legConfig.enabled) continue;
    const levelPrice = side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
    const levelIsWaiting = side === "BUY" ? levelPrice < price : levelPrice > price;
    if (!levelIsWaiting) continue;
    const nextReEntryCount = nextReEntryCountFor(config, side, levelIndex, closed);
    if (nextReEntryCount === null) continue;
    if (isStartLocked(config, side, levelIndex, anchor, price, entryGate, day)) continue;
    const volume = lotFor(config, levelIndex);
    if (currentLots + volume > config.maxLots || currentLots + volume > config.maxExposure) continue;
    intents.push({
      idempotencyKey: `${config.symbol}:${side}:${levelIndex}:${levelPrice.toFixed(5)}:${nextReEntryCount}:open`,
      symbol: config.symbol,
      action: "OPEN",
      side,
      levelIndex,
      levelPrice,
      volume,
      reEntryCount: nextReEntryCount,
      reason: nextReEntryCount > 0 ? `${side} grid level ${levelIndex} re-entry ${nextReEntryCount}` : `${side} grid level ${levelIndex}`
    });
  }
  return intents;
}

function nextReEntryCountFor(config: StrategyConfig, side: Side, levelIndex: number, closed: Position[]) {
  const closedTakeProfitPositions = closed.filter(
    (position) =>
      position.symbol === config.symbol &&
      position.side === side &&
      position.levelIndex === levelIndex &&
      position.closePrice !== undefined &&
      takeProfitAchieved(position, config.individualTakeProfit)
  );
  if (closedTakeProfitPositions.length === 0) return 0;
  if (!config.enableReEntry) return null;
  const maxReEntryCount = Math.max(...closedTakeProfitPositions.map((position) => position.reEntryCount));
  const nextReEntryCount = maxReEntryCount + 1;
  return nextReEntryCount <= config.maxReEntriesPerLevel ? nextReEntryCount : null;
}

function takeProfitAchieved(position: Position, takeProfitPoints: number) {
  if (position.closePrice === undefined) return false;
  return position.side === "BUY" ? position.closePrice >= position.entryPrice + takeProfitPoints : position.closePrice <= position.entryPrice - takeProfitPoints;
}

function reachedLevelsAtStart(config: StrategyConfig, side: Side, anchor: number, price: number) {
  const distance = gridDistance(config, anchor);
  const maxConfiguredLegs = Math.min(config.maxLegs, config.legs?.length || config.maxLegs);
  const lockedLevels: EntryStartGate["lockedLevels"] = [];
  for (let levelIndex = 1; levelIndex <= maxConfiguredLegs; levelIndex += 1) {
    const legConfig = config.legs?.[levelIndex - 1];
    if (legConfig && !legConfig.enabled) continue;
    const levelPrice = side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
    const reached = side === "BUY" ? price <= levelPrice : price >= levelPrice;
    if (reached) lockedLevels.push({ side, levelIndex });
  }
  return lockedLevels;
}

function isStartLocked(
  config: StrategyConfig,
  side: Side,
  levelIndex: number,
  anchor: number,
  price: number,
  entryGate: EntryStartGate | null | undefined,
  day: string
) {
  if (!entryGate || entryGate.day !== day || entryGate.symbol !== config.symbol) return false;
  const locked = entryGate.lockedLevels.some((level) => level.side === side && level.levelIndex === levelIndex);
  if (!locked) return false;
  if (side === "BUY" && entryGate.buyAnchor !== undefined && anchor > entryGate.buyAnchor) return false;
  if (side === "SELL" && entryGate.sellAnchor !== undefined && anchor < entryGate.sellAnchor) return false;
  return !hasRecoveredStartLockedLevel(config, side, levelIndex, anchor, price);
}

function hasRecoveredStartLockedLevel(config: StrategyConfig, side: Side, levelIndex: number, anchor: number, price: number) {
  const distance = gridDistance(config, anchor);
  const thresholdLevel = Math.max(1, levelIndex - 1);
  const threshold = side === "BUY" ? anchor - thresholdLevel * distance : anchor + thresholdLevel * distance;
  return side === "BUY" ? price >= threshold : price <= threshold;
}

function gridDistance(config: StrategyConfig, anchor: number) {
  return config.gridType === "percentage" ? (anchor * config.gridDistance) / 100 : config.gridDistance;
}

function lotFor(config: StrategyConfig, levelIndex: number) {
  const leg = config.legs?.[levelIndex - 1];
  if (leg) return leg.lotSize;
  if (config.lotMode === "incremental") return config.lotSize * levelIndex;
  if (config.lotMode === "multiplier") return Number((config.lotSize * Math.pow(config.multiplier, levelIndex - 1)).toFixed(2));
  return config.lotSize;
}

function closeOne(config: StrategyConfig, position: Position, price: number, reason: string): TradeIntent {
  return {
    idempotencyKey: `${config.symbol}:${position.side}:${position.levelIndex}:${position.id}:close`,
    symbol: config.symbol,
    action: "CLOSE",
    side: position.side,
    levelIndex: position.levelIndex,
    levelPrice: price,
    volume: position.volume,
    reason
  };
}

function closeAll(config: StrategyConfig, reason: string): TradeIntent {
  return {
    idempotencyKey: `${todayKey()}:${config.symbol}:close-all:${reason}`,
    symbol: config.symbol,
    action: "CLOSE_ALL",
    reason
  };
}

function estimatePnl(positions: Position[], price: number) {
  return positions.reduce((total, position) => {
    const points = position.side === "BUY" ? price - position.entryPrice : position.entryPrice - price;
    return total + points * position.volume;
  }, 0);
}

function mid(bid: number, ask: number) {
  return (bid + ask) / 2;
}

function entryTriggerPrice(tick: Tick, side: Side) {
  return side === "BUY" ? tick.ask : tick.bid;
}

function dedupeIntents(intents: TradeIntent[]) {
  return Array.from(new Map(intents.map((intent) => [intent.idempotencyKey, intent])).values());
}
