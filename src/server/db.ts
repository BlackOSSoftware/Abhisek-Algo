import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultConfig } from "@/lib/default-config";
import { defaultSettings } from "@/lib/default-settings";
import type { AccountSnapshot, AppSettings, EntryStartGate, MarketState, Position, StrategyConfig, Tick, TradeIntent } from "@/lib/types";

const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
const dbPath = isProductionBuild ? ":memory:" : resolve(process.env.DATABASE_PATH ?? "./data/trader.sqlite");
if (!isProductionBuild) mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

const MAX_STORED_EVENTS = Number(process.env.MAX_STORED_EVENTS ?? 2000);
let eventWrites = 0;

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  level_index INTEGER NOT NULL,
  level_price REAL NOT NULL,
  entry_price REAL NOT NULL,
  volume REAL NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_price REAL,
  broker_order_id TEXT,
  pnl REAL,
  re_entry_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_level
ON positions(symbol, side, level_index, status)
WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_level
ON positions(symbol, side, level_index)
WHERE status IN ('OPEN', 'PENDING');
CREATE TABLE IF NOT EXISTS open_level_reservations (
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  level_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(symbol, side, level_index)
);
CREATE TABLE IF NOT EXISTS intents (
  idempotency_key TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  side TEXT,
  level_index INTEGER,
  level_price REAL,
  volume REAL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  broker_order_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

db.exec(`
DELETE FROM events
WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ${MAX_STORED_EVENTS});
`);

db.exec(`
INSERT OR IGNORE INTO open_level_reservations(symbol, side, level_index, created_at)
SELECT symbol, side, level_index, opened_at
FROM positions
WHERE status = 'OPEN';
`);

function now() {
  return new Date().toISOString();
}

function setJson(key: string, value: unknown) {
  db.prepare(
    "INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), now());
}

function getJson<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export const store = {
  getConfig(): StrategyConfig {
    const config = getJson<StrategyConfig>("config", defaultConfig);
    return { ...defaultConfig, ...config };
  },
  setConfig(config: StrategyConfig) {
    setJson("config", config);
    this.event("CONFIG_UPDATED", config);
  },
  getSettings(): AppSettings {
    const settings = getJson<AppSettings>("settings", defaultSettings);
    return { ...defaultSettings, ...settings };
  },
  setSettings(settings: AppSettings) {
    setJson("settings", settings);
    this.event("SETTINGS_UPDATED", settings);
  },
  getMarket(): MarketState | null {
    return getJson<MarketState | null>("market", null);
  },
  setMarket(market: MarketState) {
    setJson("market", market);
  },
  getTick(): Tick | null {
    return getJson<Tick | null>("tick", null);
  },
  setTick(tick: Tick) {
    setJson("tick", tick);
  },
  getEntryGate(): EntryStartGate | null {
    return getJson<EntryStartGate | null>("entryGate", null);
  },
  setEntryGate(gate: EntryStartGate | null) {
    setJson("entryGate", gate);
    this.event("ENTRY_GATE_UPDATED", gate);
  },
  getAccount(): AccountSnapshot {
    return getJson<AccountSnapshot>("account", {
      balance: 0,
      equity: 0,
      floatingPnl: 0,
      dailyRealizedPnl: 0
    });
  },
  setAccount(account: AccountSnapshot) {
    setJson("account", account);
  },
  getEnabled(): boolean {
    return getJson("enabled", false);
  },
  setEnabled(enabled: boolean) {
    setJson("enabled", enabled);
    this.event(enabled ? "TRADING_ENABLED" : "TRADING_DISABLED", { enabled });
  },
  listPositions(status?: "OPEN" | "PENDING" | "CLOSED" | "REJECTED", limit = 100): Position[] {
    const rows = (status
      ? db.prepare("SELECT * FROM positions WHERE status = ? ORDER BY opened_at DESC LIMIT ?").all(status, limit)
      : db.prepare("SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.map(mapPosition);
  },
  listActivePositions(): Position[] {
    const rows = db
      .prepare("SELECT * FROM positions WHERE status IN ('OPEN', 'PENDING') ORDER BY opened_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapPosition);
  },
  insertOpenPosition(position: Position) {
    db.prepare(`
      INSERT INTO positions(id, symbol, side, level_index, level_price, entry_price, volume, status, opened_at, broker_order_id, re_entry_count)
      VALUES(@id, @symbol, @side, @levelIndex, @levelPrice, @entryPrice, @volume, @status, @openedAt, @brokerOrderId, @reEntryCount)
    `).run(position);
  },
  reserveOpenLevel(symbol: string, side: Position["side"], levelIndex: number) {
    const reserve = db.transaction(() => {
      const open = db
        .prepare("SELECT 1 FROM positions WHERE symbol = ? AND side = ? AND level_index = ? AND status IN ('OPEN', 'PENDING')")
        .get(symbol, side, levelIndex);
      if (open) return false;
      const result = db
        .prepare("INSERT OR IGNORE INTO open_level_reservations(symbol, side, level_index, created_at) VALUES(?, ?, ?, ?)")
        .run(symbol, side, levelIndex, now());
      return result.changes === 1;
    });
    return reserve();
  },
  releaseOpenLevel(symbol: string, side: Position["side"], levelIndex: number) {
    db.prepare("DELETE FROM open_level_reservations WHERE symbol = ? AND side = ? AND level_index = ?")
      .run(symbol, side, levelIndex);
  },
  releaseAllOpenLevels(symbol: string) {
    db.prepare("DELETE FROM open_level_reservations WHERE symbol = ?").run(symbol);
  },
  markPositionOpen(id: string, entryPrice: number, brokerOrderId?: string) {
    db.prepare("UPDATE positions SET status = 'OPEN', entry_price = ?, broker_order_id = ? WHERE id = ? AND status = 'PENDING'")
      .run(entryPrice, brokerOrderId ?? null, id);
  },
  closePosition(id: string, closePrice: number, pnl: number) {
    db.prepare("UPDATE positions SET status = 'CLOSED', closed_at = ?, close_price = ?, pnl = ? WHERE id = ? AND status IN ('OPEN', 'PENDING')")
      .run(now(), closePrice, pnl, id);
  },
  disableLeg(symbol: string, levelIndex: number) {
    const config = this.getConfig();
    if (config.symbol !== symbol) return;
    const index = levelIndex - 1;
    if (!config.legs[index]) return;
    const legs = config.legs.map((leg, legIndex) => (legIndex === index ? { ...leg, enabled: false } : leg));
    this.setConfig({ ...config, legs, maxLegs: legs.length });
  },
  createIntent(intent: TradeIntent) {
    const result = db.prepare(`
      INSERT INTO intents(idempotency_key, symbol, action, side, level_index, level_price, volume, reason, created_at)
      VALUES(@idempotencyKey, @symbol, @action, @side, @levelIndex, @levelPrice, @volume, @reason, @createdAt)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        symbol = excluded.symbol,
        action = excluded.action,
        side = excluded.side,
        level_index = excluded.level_index,
        level_price = excluded.level_price,
        volume = excluded.volume,
        reason = excluded.reason,
        status = 'PENDING',
        broker_order_id = NULL,
        error = NULL,
        created_at = excluded.created_at,
        completed_at = NULL
      WHERE intents.status != 'PENDING'
    `).run({ ...intent, createdAt: now() });
    return result.changes === 1;
  },
  completeIntent(idempotencyKey: string, brokerOrderId?: string) {
    db.prepare("UPDATE intents SET status = 'DONE', broker_order_id = ?, completed_at = ? WHERE idempotency_key = ?")
      .run(brokerOrderId ?? null, now(), idempotencyKey);
  },
  failIntent(idempotencyKey: string, error: string) {
    db.prepare("UPDATE intents SET status = 'FAILED', error = ?, completed_at = ? WHERE idempotency_key = ?")
      .run(error, now(), idempotencyKey);
  },
  event(type: string, payload: unknown) {
    db.prepare("INSERT INTO events(type, payload, created_at) VALUES(?, ?, ?)").run(type, JSON.stringify(payload), now());
    eventWrites += 1;
    if (eventWrites % 250 === 0) {
      db.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)").run(MAX_STORED_EVENTS);
    }
  },
  recentEvents(limit = 80) {
    return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; type: string; payload: string; created_at: string }>;
  }
};

function mapPosition(row: Record<string, unknown>): Position {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    side: row.side as Position["side"],
    levelIndex: Number(row.level_index),
    levelPrice: Number(row.level_price),
    entryPrice: Number(row.entry_price),
    volume: Number(row.volume),
    status: row.status as Position["status"],
    openedAt: String(row.opened_at),
    closedAt: row.closed_at ? String(row.closed_at) : undefined,
    closePrice: row.close_price === null ? undefined : Number(row.close_price),
    brokerOrderId: row.broker_order_id ? String(row.broker_order_id) : undefined,
    pnl: row.pnl === null ? undefined : Number(row.pnl),
    reEntryCount: Number(row.re_entry_count)
  };
}
