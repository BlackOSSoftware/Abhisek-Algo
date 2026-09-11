import type { BrokerPendingOrder, BrokerPosition, Position } from "@/lib/types";

export function matchesBrokerPosition(position: Position, broker: BrokerPosition) {
  if (broker.symbol !== position.symbol || broker.side !== position.side) return false;
  // Execution slippage must never invalidate the broker's order identity.
  if (position.brokerOrderId) {
    return broker.brokerOrderId === position.brokerOrderId || broker.positionIdentifier === position.brokerOrderId;
  }
  return matchesLegacyLevel(position, broker.comment, broker.entryPrice);
}

export function matchesBrokerPending(position: Position, broker: BrokerPendingOrder) {
  if (broker.symbol !== position.symbol || broker.side !== position.side) return false;
  if (position.brokerOrderId) return broker.brokerOrderId === position.brokerOrderId;
  return matchesLegacyLevel(position, broker.comment, broker.price);
}

function matchesLegacyLevel(position: Position, comment: string, price: number) {
  const code = position.side === "BUY" ? "B" : "S";
  return (comment === `ag-${code}-${position.levelIndex}` || comment === `adaptive-grid-${position.side}`.slice(0, 15)) &&
    Math.abs(price - position.levelPrice) <= 0.05;
}
