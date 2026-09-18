import type { BrokerPendingOrder, BrokerPosition, Position } from "@/lib/types";

export function matchesBrokerPosition(position: Position, broker: BrokerPosition) {
  if (broker.side !== position.side) return false;
  // Ticket identity wins even when MT5 resolves an alias symbol (GOLD.i# → XAUUSD).
  if (position.brokerOrderId) {
    return broker.brokerOrderId === position.brokerOrderId || broker.positionIdentifier === position.brokerOrderId;
  }
  if (!symbolsMatch(broker.symbol, position.symbol)) return false;
  return matchesLegacyLevel(position, broker.comment, broker.entryPrice);
}

export function matchesBrokerPending(position: Position, broker: BrokerPendingOrder) {
  if (broker.side !== position.side) return false;
  // Ticket identity wins even when MT5 resolves an alias symbol (GOLD.i# → XAUUSD).
  if (position.brokerOrderId) return broker.brokerOrderId === position.brokerOrderId;
  if (!symbolsMatch(broker.symbol, position.symbol)) return false;
  return matchesLegacyLevel(position, broker.comment, broker.price);
}

function symbolsMatch(left: string, right: string) {
  if (left === right) return true;
  const aliases = (process.env.MT5_SYMBOL_ALIASES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (aliases.length === 0) return false;
  const group = new Set(aliases);
  return group.has(left) && group.has(right);
}

function matchesLegacyLevel(position: Position, comment: string, price: number) {
  const code = position.side === "BUY" ? "B" : "S";
  return commentMatchesPosition(position, comment, code) && Math.abs(price - position.levelPrice) <= 0.05;
}

function commentMatchesPosition(position: Position, comment: string, sideCode: "B" | "S") {
  if (position.strategyMode) {
    const modeCode = position.strategyMode === "auto" ? "a" : position.strategyMode === "manual" ? "m" : "r";
    if (comment === `ag-${modeCode}-${sideCode}-${position.levelIndex}`) return true;
  }
  return comment === `ag-${sideCode}-${position.levelIndex}` || comment === `adaptive-grid-${position.side}`.slice(0, 15);
}
