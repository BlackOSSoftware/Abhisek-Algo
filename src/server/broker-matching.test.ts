import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerPosition, Position } from "@/lib/types";
import { matchesBrokerPending, matchesBrokerPosition } from "./broker-matching";

const pending: Position = {
  id: "local", symbol: "GOLD.i#", side: "BUY", levelIndex: 3,
  levelPrice: 4346.1, entryPrice: 4346.1, volume: 0.01, status: "PENDING",
  openedAt: "2026-09-11T10:04:11Z", brokerOrderId: "2310297631", reEntryCount: 0
};
const filled: BrokerPosition = {
  brokerOrderId: "2310297631", symbol: "GOLD.i#", side: "BUY",
  entryPrice: 4346.03, volume: 0.01, comment: "ag-B-3"
};

test("actual slipped fill is recognized and remains open by ticket", () => {
  assert.equal(matchesBrokerPosition(pending, filled), true);
  assert.equal(matchesBrokerPosition({ ...pending, status: "OPEN" }, filled), true);
});

test("another ticket at the same level cannot substitute for the tracked order", () => {
  assert.equal(matchesBrokerPosition(pending, { ...filled, brokerOrderId: "2310302469", entryPrice: 4346.1 }), false);
});

test("stable position identifier recognizes a changed position ticket", () => {
  assert.equal(matchesBrokerPosition(pending, { ...filled, brokerOrderId: "new", positionIdentifier: pending.brokerOrderId }), true);
});

test("ticket identity still matches when MT5 reports an alias symbol", () => {
  assert.equal(matchesBrokerPosition(pending, { ...filled, symbol: "XAUUSD" }), true);
  assert.equal(matchesBrokerPending(pending, { ...filled, symbol: "XAUUSD", price: 4346.1 }), true);
});

test("side must match even when tickets match", () => {
  assert.equal(matchesBrokerPosition(pending, { ...filled, side: "SELL" }), false);
  assert.equal(matchesBrokerPending(pending, { ...filled, side: "SELL", price: 4346.1 }), false);
});

test("broker modifications do not make a pending ticket disappear", () => {
  assert.equal(matchesBrokerPending(pending, { ...filled, price: 4347 }), true);
  assert.equal(matchesBrokerPending(pending, { ...filled, price: 4346.1, brokerOrderId: "other" }), false);
});
