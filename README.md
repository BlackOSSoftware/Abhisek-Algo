# Adaptive High / Low Grid Trader

Live MT5 adaptive high/low grid recovery system for Forex/Gold with a Next.js dashboard, SQLite WAL persistence, optional Redis locks, and a persistent Python MT5 execution bridge.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

Run the live worker in a second terminal:

```bash
npm run worker
```

## Local MT5 Gold Setup

Install the MT5 Python package in the Python environment used by `MT5_PYTHON`:

```bash
pip install MetaTrader5
```

Set these values in `.env`:

```bash
MT5_PYTHON=python
MT5_LOGIN=123456
MT5_PASSWORD=your_password
MT5_SERVER=your_broker_server
MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
LIVE_TRADING_ENABLED=true
TRADER_SYMBOL=GOLD.i#
MT5_SYMBOL_ALIASES=GOLD.i#,GAUUSD.i#,XAUUSD,XAUUSDm,XAUUSD.,GOLDm
MT5_DEVIATION=20
MT5_MAGIC=250601
MT5_FILLING_MODE=auto
```

`LIVE_TRADING_ENABLED=true` is required before the bridge sends broker orders.

Find your local MT5 terminal path:

```bash
npm run mt5:find
```

Check which Gold/Forex symbols your broker exposes:

```bash
npm run mt5:symbols
```

Check live Gold tick:

```bash
python scripts/mt5_bridge.py tick GOLD.i#
```

If your broker symbol is `GAUUSD.i#`, `XAUUSDm`, or another suffix, put that exact value in `TRADER_SYMBOL`. Your local MT5 currently exposes Gold-like CFDs such as `GOLD.i#` and `GAUUSD.i#`.

## Speed Setup

The worker uses one persistent MT5 Python process instead of spawning Python on every tick. Keep the worker running:

```bash
npm run worker
```

For multi-process safety, run Redis and set:

```bash
REDIS_URL=redis://127.0.0.1:6379
```

## Duplicate Order Protection

The system uses:

- deterministic idempotency keys per symbol, side, level, and action
- SQLite unique constraints for open levels
- optional Redis locks via `REDIS_URL`
- append-only intent/event records for auditability

## Verification

```bash
npm run typecheck
npm run build
```

## 24/7 Maintenance

The worker runs periodic cleanup for local logs, old event rows, and SQLite WAL checkpoints.

```bash
MAINTENANCE_INTERVAL_MS=300000
LOG_MAX_BYTES=5242880
LOG_KEEP_FILES=3
```

Run cleanup manually:

```bash
npm run maintenance
```

If running with PM2 on a VPS, enable PM2 log rotation too:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 save
```

## Important

This is live trading software. Test every symbol contract size, filling mode, broker permissions, and lot rules on the exact MT5 account before enabling real capital.

# Abhisek-Algo

