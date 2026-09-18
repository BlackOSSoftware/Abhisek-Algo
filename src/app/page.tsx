"use client";

import { takeProfitDistance } from "@/lib/take-profit";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Clock3, Layers, TrendingDown, TrendingUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/trader/app-shell";
import { SectionCard } from "@/components/trader/cards";
import { cn } from "@/components/ui";
import { money, num } from "@/components/trader/format";
import { useSnapshot } from "@/components/trader/use-snapshot";
import type { AppSettings, BrokerPendingOrder, BrokerPosition, EntryStartGate, StrategyConfig, Tick } from "@/lib/types";
import { Loader } from "@/components/trader/loader";
import { isEntrySideReady } from "@/lib/adaptive-market";

export default function DashboardPage() {
  const { snapshot, reload } = useSnapshot();
  const [switchingDirection, setSwitchingDirection] = useState(false);
  const tradePlan = useMemo(() => makeTradePlan(snapshot), [snapshot]);
  const recentOrders = useMemo(() => makeRecentOrderRows(snapshot), [snapshot]);
  const recentMode = snapshot?.settings.adaptiveHighLowMode === "recent";
  const visibleOpenRows = useMemo(() => tradePlan.filter((row) => row.status === "Open"), [tradePlan]);
  const buyCount = recentMode ? recentOrders.filter((row) => row.side === "BUY").length : visibleOpenRows.filter((row) => row.side === "BUY").length;
  const sellCount = recentMode ? recentOrders.filter((row) => row.side === "SELL").length : visibleOpenRows.filter((row) => row.side === "SELL").length;
  const openLots = recentMode ? recentOrders.reduce((sum, row) => sum + row.lot, 0) : visibleOpenRows.reduce((sum, row) => sum + row.lot, 0);

  const dayOpen = snapshot?.market?.dayOpen;
  const currentPrice = snapshot?.tick ? snapshot.tick.last || (snapshot.tick.bid + snapshot.tick.ask) / 2 : undefined;
  const dayMovePoints = dayOpen && currentPrice ? currentPrice - dayOpen : 0;
  const dayMovePct = dayOpen ? (dayMovePoints / dayOpen) * 100 : 0;
  const moveTone = dayMovePoints > 0 ? "up" : dayMovePoints < 0 ? "down" : "flat";
  const highChanged = usePulseOnChange(snapshot?.market?.adaptiveHigh);
  const lowChanged = usePulseOnChange(snapshot?.market?.adaptiveLow);
  const tradeWarning = getTradeWarning(snapshot);
  const tradeWarningKey = getTradeWarningKey(snapshot, tradeWarning);
  const [dismissedWarningKey, setDismissedWarningKey] = useState("");
  const activeWarningKeyRef = useRef("");
  const switchingDirectionRef = useRef(false);

  useEffect(() => {
    if (tradeWarningKey && tradeWarningKey !== activeWarningKeyRef.current) {
      activeWarningKeyRef.current = tradeWarningKey;
      setDismissedWarningKey("");
    }
    if (!tradeWarningKey && activeWarningKeyRef.current) {
      activeWarningKeyRef.current = "";
      setDismissedWarningKey("");
    }
  }, [tradeWarningKey]);

  async function setLevelEnabled(legIndex: number, enabled: boolean) {
    if (!snapshot?.config) return;
    const legs = snapshot.config.legs.map((leg, index) => (index === legIndex ? { ...leg, enabled } : leg));
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot.config, legs, maxLegs: legs.length })
    });
    await reload();
  }

  async function manualOrder(row: TradePlanRow, action: "place" | "unplace") {
    const response = await fetch("/api/manual-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        symbol: snapshot?.config.symbol,
        side: row.side,
        levelIndex: row.leg,
        levelPrice: row.entry,
        volume: row.lot
      })
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; skipped?: boolean; reason?: string; error?: string };
    if (!response.ok || data.ok === false) {
      window.alert(data.error ?? "Manual order was rejected");
    } else if (data.skipped) {
      window.alert(data.reason ?? "Manual order was skipped");
    }
    await reload();
  }

  async function updateLot(row: TradePlanRow, lotSize: number) {
    if (!snapshot?.config || !Number.isFinite(lotSize) || lotSize <= 0) return;
    const legs = snapshot.config.legs.map((leg, index) => (index === row.leg - 1 ? { ...leg, lotSize } : leg));
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot.config, legs, maxLegs: legs.length })
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      window.alert(data.error ?? `Pending order lot update failed for leg ${row.leg}`);
    }
    await reload();
  }

  async function switchDirection(direction: "buy" | "sell") {
    if (!snapshot?.config || snapshot.config.direction === direction || switchingDirectionRef.current) return;
    switchingDirectionRef.current = true;
    setSwitchingDirection(true);
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snapshot.config, direction })
      });
      await reload();
    } finally {
      switchingDirectionRef.current = false;
      setSwitchingDirection(false);
    }
  }

  return (
    <AppShell snapshot={snapshot} onRefresh={reload}>
      <div className="grid gap-4 sm:gap-5">
        {tradeWarning && tradeWarningKey && dismissedWarningKey !== tradeWarningKey && <TradeWarningModal message={tradeWarning} onClose={() => setDismissedWarningKey(tradeWarningKey)} />}

        <div className="grid gap-3 sm:gap-4 lg:grid-cols-3">
          <HeroSymbol symbol={snapshot?.tick?.symbol ?? snapshot?.config.symbol ?? "-"} connected={Boolean(snapshot?.status.connected)} />
          <HeroQuoteMove bid={num(snapshot?.tick?.bid)} ask={num(snapshot?.tick?.ask)} points={dayMovePoints} pct={dayMovePct} tone={moveTone} />
          <HeroMetric title="Basket PnL" value={money(snapshot?.account.floatingPnl ?? 0)} icon={<Layers size={22} />} tone={(snapshot?.account.floatingPnl ?? 0) >= 0 ? "green" : "red"} />
        </div>

        <SectionCard title="Market & Basket" subtitle="Live MT5 snapshot with current basket summary.">
          <div className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
              <SmallMetric label="Adaptive High" value={snapshot?.market?.recentHighReady === false ? "Waiting" : num(snapshot?.market?.adaptiveHigh)} tone="green" pulse={highChanged} />
              <SmallMetric label="Adaptive Low" value={snapshot?.market?.recentLowReady === false ? "Waiting" : num(snapshot?.market?.adaptiveLow)} tone="red" pulse={lowChanged} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <SmallMetric label="Buy Legs" value={String(buyCount)} icon={<ArrowUp size={16} className="text-emerald-600" />} />
              <SmallMetric label="Sell Legs" value={String(sellCount)} icon={<ArrowDown size={16} className="text-rose-600" />} />
              <SmallMetric label="Open Lots" value={openLots.toFixed(2)} icon={<Clock3 size={16} className="text-blue-600" />} />
            </div>
          </div>
        </SectionCard>

        {snapshot?.settings.adaptiveHighLowMode === "recent" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <div className="font-bold">Recent High · BUY {snapshot.market?.recentHighReady ? "active" : "waiting for previous high"}</div>
              <div>Previous day High: {num(snapshot.market?.previousDayHigh)} · Today High: {num(snapshot.market?.todayHigh)}</div>
            </div>
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <div className="font-bold">Recent Low · SELL {snapshot.market?.recentLowReady ? "active" : "waiting for previous low"}</div>
              <div>Previous day Low: {num(snapshot.market?.previousDayLow)} · Today Low: {num(snapshot.market?.todayLow)}</div>
            </div>
          </div>
        )}

        {recentMode && <RecentOrdersTable rows={recentOrders} />}

        {!recentMode && (
        <SectionCard title="Trade Level Chart" action={<DirectionSwitch value={snapshot?.config.direction ?? "buy"} busy={switchingDirection} onChange={switchDirection} />}>
          <div className="grid gap-3 md:hidden">
            {tradePlan.map((row) => (
              <TradeLevelCard
                key={row.leg}
                row={row}
                onToggle={() => setLevelEnabled(row.leg - 1, !row.enabled)}
                onManual={() => manualOrder(row, hasActiveOrder(row) ? "unplace" : "place")}
                onLotSave={(value) => updateLot(row, value)}
              />
            ))}
            {tradePlan.length === 0 && <div className="rounded-lg border border-dashed border-line bg-white/70 p-4 text-center text-sm font-medium text-muted">No legs found.</div>}
          </div>
          <div className="hidden max-h-[420px] overflow-auto rounded-xl border border-line bg-white md:block">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
                <tr>
                  <th className="px-4 py-3">Leg</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3">Entry Level</th>
                  <th className="px-4 py-3">Lot</th>
                  <th className="px-4 py-3">TP Level</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Level</th>
                  <th className="px-4 py-3">Order</th>
                </tr>
              </thead>
              <tbody>
                {tradePlan.map((row) => (
                  <tr key={row.leg} className="border-t border-line hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold">Leg {row.leg}</td>
                    <td className={row.side === "BUY" ? "px-4 py-3 font-bold text-emerald-700" : "px-4 py-3 font-bold text-rose-700"}>{row.side}</td>
                    <td className="px-4 py-3 font-semibold">{row.entry.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <InlineLotInput value={row.lot} onSave={(value) => updateLot(row, value)} />
                    </td>
                    <td className={row.side === "BUY" ? "px-4 py-3 font-semibold text-emerald-700" : "px-4 py-3 font-semibold text-rose-700"}>{row.tp.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <span className={statusClass(row.status)}>{row.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className={row.enabled ? "inline-flex h-9 min-w-28 items-center justify-center rounded-lg border border-emerald-600 bg-white px-4 text-sm font-bold text-emerald-700 shadow-sm transition hover:bg-emerald-50" : "inline-flex h-9 min-w-28 items-center justify-center rounded-lg border border-slate-400 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"}
                        onClick={() => setLevelEnabled(row.leg - 1, !row.enabled)}
                      >
                        {row.enabled ? "Enabled" : "Disabled"}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {isEntryLocked(row) ? (
                        <button type="button" className="inline-flex h-9 min-w-24 items-center justify-center rounded-lg border border-slate-300 bg-slate-100 px-4 text-sm font-bold text-slate-500" disabled>
                          {row.status === "Awaiting Breakout" ? "Awaiting Breakout" : "Locked"}
                        </button>
                      ) : isOldConceptOrder(row) ? (
                        <button type="button" className="inline-flex h-9 min-w-24 items-center justify-center rounded-lg border border-slate-300 bg-slate-100 px-4 text-sm font-bold text-slate-500" disabled>
                          Tracked
                        </button>
                      ) : hasActiveOrder(row) ? (
                        <button type="button" className="inline-flex h-9 min-w-24 items-center justify-center rounded-lg border border-rose-500 bg-white px-4 text-sm font-bold text-rose-700 shadow-sm transition hover:bg-rose-50" onClick={() => manualOrder(row, "unplace")}>
                          Unplace
                        </button>
                      ) : (
                        <button type="button" className="inline-flex h-9 min-w-24 items-center justify-center rounded-lg border border-ink bg-white px-4 text-sm font-bold text-ink shadow-sm transition hover:bg-slate-100" onClick={() => manualOrder(row, "place")}>
                          Place
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {tradePlan.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center font-medium text-muted" colSpan={8}>No legs found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
        )}

        <SectionCard title="Risk Controls">
          <div className="grid gap-3 lg:grid-cols-2">
            <StopLossCard snapshot={snapshot} onUpdated={reload} />
            <ForceExitCard snapshot={snapshot} onUpdated={reload} />
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}

function TradeWarningModal({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-rose-300 bg-white p-4 text-ink shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
            <AlertTriangle size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-rose-800">Order warning</div>
            <div className="mt-1 break-words text-sm font-semibold leading-6 text-rose-700">{message}</div>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-ink"
            onClick={onClose}
            aria-label="Close warning"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className="h-10 rounded-lg border border-rose-600 bg-rose-600 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-rose-700" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function getTradeWarning(snapshot: ReturnType<typeof useSnapshot>["snapshot"]) {
  if (!snapshot?.config) return "";
  const config = snapshot.config;
  const price = snapshot.tick ? snapshot.tick.last || (snapshot.tick.bid + snapshot.tick.ask) / 2 : undefined;

  if (price && config.stopLoss > 0) {
    if (config.direction === "sell" && config.stopLoss <= price) {
      return `Sell mode needs Stop Loss above current price. Current price is ${price.toFixed(2)}, but Stop Loss is ${config.stopLoss}.`;
    }
    if (config.direction === "buy" && config.stopLoss >= price) {
      return `Buy mode needs Stop Loss below current price. Current price is ${price.toFixed(2)}, but Stop Loss is ${config.stopLoss}.`;
    }
  }

  const latestFailed = snapshot.recentIntents.find((intent) => {
    if (intent.status !== "FAILED" || !intent.error || intent.symbol !== config.symbol) return false;
    if (config.direction !== "both" && intent.side && intent.side.toLowerCase() !== config.direction) return false;
    return true;
  });
  if (!latestFailed?.error) return "";
  const failedAt = Date.parse(latestFailed.completedAt ?? latestFailed.createdAt);
  if (Number.isFinite(failedAt) && Date.now() - failedAt > 2 * 60 * 1000) return "";
  if (latestFailed.error.includes("stop loss") && price && stopLossLooksValid(config.direction, config.stopLoss, price)) return "";
  const leg = latestFailed.side && latestFailed.levelIndex ? `${latestFailed.side} leg ${latestFailed.levelIndex}` : latestFailed.action;
  return `${leg} rejected: ${latestFailed.error}`;
}

function getTradeWarningKey(snapshot: ReturnType<typeof useSnapshot>["snapshot"], warning: string) {
  if (!warning || !snapshot?.config) return "";
  const config = snapshot.config;
  if (warning.startsWith("Buy mode needs Stop Loss")) return `${config.symbol}:buy-stop-loss:${config.stopLoss}`;
  if (warning.startsWith("Sell mode needs Stop Loss")) return `${config.symbol}:sell-stop-loss:${config.stopLoss}`;
  return warning;
}

function stopLossLooksValid(direction: "buy" | "sell" | "both", stopLoss: number, price: number) {
  if (direction === "sell") return stopLoss > price;
  if (direction === "buy") return stopLoss < price;
  return stopLoss > 0;
}

function HeroMetric({ title, value, icon, tone }: { title: string; value: string; icon: React.ReactNode; tone?: "green" | "red" }) {
  return (
    <div className={cn("rounded-2xl border bg-white p-4 text-ink", tone === "green" && "border-emerald-300", tone === "red" && "border-rose-300", !tone && "border-line")}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold uppercase text-muted">{title}</span>
        <div className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-slate-50 text-slate-700">{icon}</div>
      </div>
      <div className={cn("mt-5 truncate text-2xl font-semibold", tone === "green" && "text-emerald-700", tone === "red" && "text-rose-700")}>{value}</div>
    </div>
  );
}

function HeroSymbol({ symbol, connected }: { symbol: string; connected: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4 text-ink">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold uppercase text-muted">Live Symbol</span>
        <div className={cn("grid h-11 w-11 place-items-center rounded-xl border bg-white", connected ? "border-cyan-300 text-cyan-700" : "border-slate-200 text-slate-500")}>
          <Activity size={22} />
        </div>
      </div>
      <div className="mt-5 flex min-w-0 items-center gap-3">
        <span className="min-w-0 max-w-full truncate rounded-xl border border-slate-300 bg-slate-50 px-4 py-2 text-xl font-bold tracking-wide sm:text-2xl">{symbol}</span>
      </div>
    </div>
  );
}

function HeroQuoteMove({ bid, ask, points, pct, tone }: { bid: string; ask: string; points: number; pct: number; tone: "up" | "down" | "flat" }) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border bg-white p-4 text-ink", tone === "up" && "border-emerald-300", tone === "down" && "border-rose-300", tone === "flat" && "border-line")}>
      <div className={cn("pointer-events-none absolute inset-y-0 left-0 w-20 opacity-45 blur-2xl", tone === "up" && "bg-emerald-300", tone === "down" && "bg-rose-300", tone === "flat" && "hidden")} />
      <div className="relative">
        <div className="flex items-center justify-between">
        <span className="text-sm font-bold uppercase text-muted">Bid / Ask</span>
        <div className={cn("grid h-11 w-11 place-items-center rounded-xl border bg-white", tone === "up" && "border-emerald-300 text-emerald-700", tone === "down" && "border-rose-300 text-rose-700", tone === "flat" && "border-line text-slate-700")}>
          {tone === "down" ? <TrendingDown size={22} /> : <TrendingUp size={22} />}
        </div>
      </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xl font-semibold text-ink sm:text-2xl">
          {bid}<span className="mx-2 text-slate-400">/</span>{ask}
        </span>
        <span className={cn("text-sm font-bold", quoteTextClass(tone))}>
          {tone === "up" ? "↑ +" : tone === "down" ? "↓ -" : ""}
          {Math.abs(points).toFixed(2)} pt
        </span>
        <span className={cn("text-sm font-bold", quoteTextClass(tone))}>
          {tone === "up" ? "+" : tone === "down" ? "-" : ""}
          {Math.abs(pct).toFixed(3)}%
        </span>
        </div>
      </div>
    </div>
  );
}

function quoteTextClass(tone: "up" | "down" | "flat") {
  if (tone === "up") return "text-emerald-700";
  if (tone === "down") return "text-rose-700";
  return "text-ink";
}

function usePulseOnChange(value: number | undefined) {
  const previous = useRef<number | undefined>(undefined);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (value === undefined) return;
    if (previous.current !== undefined && previous.current !== value) {
      setPulse(true);
      const id = window.setTimeout(() => setPulse(false), 2200);
      previous.current = value;
      return () => window.clearTimeout(id);
    }
    previous.current = value;
  }, [value]);

  return pulse;
}

function SmallMetric({ label, value, icon, tone, pulse = false }: { label: string; value: string; icon?: React.ReactNode; tone?: "green" | "red"; pulse?: boolean }) {
  const liveTone = tone === "green" || tone === "red";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-slate-50 px-3 py-3"
      )}
    >
      {liveTone && pulse && <LivePulse tone={tone} />}
      <div className="relative z-10 flex items-center gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase text-muted">
          {icon}
          <span className="truncate">{label}</span>
        </div>
      </div>
      <div className={cn("relative z-10 mt-1 truncate text-xl font-semibold", tone === "green" && "text-emerald-700", tone === "red" && "text-rose-700")}>{value}</div>
    </div>
  );
}

function LivePulse({ tone }: { tone: "green" | "red" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "live-orbit absolute right-3 top-1/2 h-16 w-16 -translate-y-1/2",
        tone === "green" ? "live-orbit-green" : "live-orbit-red"
      )}
    />
  );
}

function TradeLevelCard({
  row,
  onToggle,
  onManual,
  onLotSave
}: {
  row: TradePlanRow;
  onToggle: () => void;
  onManual: () => void;
  onLotSave: (value: number) => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold">Leg {row.leg}</div>
          <div className={row.side === "BUY" ? "mt-1 text-xs font-bold text-emerald-700" : "mt-1 text-xs font-bold text-rose-700"}>{row.side}</div>
        </div>
        <span className={statusClass(row.status)}>{row.status}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <MobileField label="Entry" value={row.entry.toFixed(2)} />
        <MobileField label="TP" value={row.tp.toFixed(2)} tone={row.side === "BUY" ? "green" : "red"} />
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[10px] font-bold uppercase text-muted">Lot</div>
        <InlineLotInput value={row.lot} onSave={onLotSave} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          className={row.enabled ? "inline-flex h-10 items-center justify-center rounded-lg border border-emerald-600 bg-white px-3 text-sm font-bold text-emerald-700 shadow-sm" : "inline-flex h-10 items-center justify-center rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold text-slate-700 shadow-sm"}
          onClick={onToggle}
        >
          {row.enabled ? "Enabled" : "Disabled"}
        </button>
        <button
          type="button"
          className={isEntryLocked(row) || isOldConceptOrder(row) ? "inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-slate-100 px-3 text-sm font-bold text-slate-500 shadow-sm" : hasActiveOrder(row) ? "inline-flex h-10 items-center justify-center rounded-lg border border-rose-500 bg-white px-3 text-sm font-bold text-rose-700 shadow-sm" : "inline-flex h-10 items-center justify-center rounded-lg border border-ink bg-white px-3 text-sm font-bold text-ink shadow-sm"}
          onClick={onManual}
          disabled={isEntryLocked(row) || isOldConceptOrder(row)}
        >
          {isEntryLocked(row) ? (row.status === "Awaiting Breakout" ? "Awaiting Breakout" : "Locked") : isOldConceptOrder(row) ? "Tracked" : hasActiveOrder(row) ? "Unplace" : "Place"}
        </button>
      </div>
    </div>
  );
}

function MobileField({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div className="rounded-lg border border-line bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-muted">{label}</div>
      <div className={cn("mt-0.5 truncate text-base font-semibold", tone === "green" && "text-emerald-700", tone === "red" && "text-rose-700")}>{value}</div>
    </div>
  );
}

function StopLossCard({ snapshot, onUpdated }: { snapshot: ReturnType<typeof useSnapshot>["snapshot"]; onUpdated: () => void }) {
  const config = snapshot?.config;
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setText(config?.stopLoss ? String(config.stopLoss) : "");
    setDirty(false);
  }, [config?.stopLoss]);

  async function save() {
    if (!config) return;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return;
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, stopLoss: value })
    });
    setDirty(false);
    onUpdated();
  }

  return (
    <div className="rounded-lg border border-line bg-slate-50 px-3 py-3">
      <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-bold uppercase text-muted">Stop Loss Price</div>
          <div className={cn("mt-1 text-xs font-bold", config?.stopLoss ? "text-emerald-700" : "text-rose-700")}>
            {config?.stopLoss ? "Ready" : "Required"}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2 sm:flex">
          <input
            className="h-9 min-w-0 rounded-lg border border-line bg-white px-3 text-sm font-semibold outline-none transition focus:border-ink focus:ring-2 focus:ring-slate-200 sm:w-32"
            inputMode="decimal"
            placeholder="Price"
            value={text}
            onChange={(event) => {
              const next = event.target.value;
              if (!/^\d*\.?\d*$/.test(next)) return;
              setText(next);
              setDirty(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
          {dirty && (
            <button type="button" className="h-9 rounded-lg border border-ink bg-white px-3 text-xs font-bold text-ink hover:bg-slate-100" onClick={save}>
              Update
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ForceExitCard({ snapshot, onUpdated }: { snapshot: ReturnType<typeof useSnapshot>["snapshot"]; onUpdated: () => void }) {
  const config = snapshot?.config;
  const enabled = Boolean(config?.forceExitEnabled);
  const seconds = snapshot?.status.forceExitCountdownSeconds ?? 0;
  const countdown = enabled ? formatCountdown(seconds) : "Off";

  async function patchForceExit(patch: Partial<NonNullable<typeof config>>) {
    if (!config) return;
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, ...patch })
    });
    onUpdated();
  }

  return (
    <div className="rounded-lg border border-line bg-slate-50 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase text-muted">Force Exit</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-xl font-semibold">{config?.forceExitTime ?? "--:--"}</span>
            <span className="text-xs font-bold text-muted">{countdown}</span>
          </div>
        </div>
        <button
          type="button"
          className={enabled ? "h-8 rounded-md border border-emerald-300 bg-white px-2 text-xs font-bold text-emerald-700" : "h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-bold text-slate-600"}
          onClick={() => patchForceExit({ forceExitEnabled: !enabled })}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={enabled ? "h-8 flex-1 rounded-md border border-emerald-300 bg-white px-2 text-xs font-bold text-emerald-700" : "h-8 flex-1 rounded-md border border-line bg-white px-2 text-xs font-bold text-muted"}
          onClick={() => patchForceExit({ forceExitType: "auto", forceExitEnabled: true })}
        >
          Enable
        </button>
        <button
          type="button"
          className={!enabled ? "h-8 flex-1 rounded-md border border-rose-300 bg-white px-2 text-xs font-bold text-rose-700" : "h-8 flex-1 rounded-md border border-line bg-white px-2 text-xs font-bold text-muted"}
          onClick={() => patchForceExit({ forceExitEnabled: false })}
        >
          Disable
        </button>
      </div>
    </div>
  );
}

function formatCountdown(seconds: number) {
  if (seconds <= 0) return "Due now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

function DirectionSwitch({ value, busy, onChange }: { value: "buy" | "sell" | "both"; busy: boolean; onChange: (value: "buy" | "sell") => void }) {
  const selected = value === "sell" ? "sell" : "buy";
  return (
    <div className="grid grid-cols-2 rounded-lg border border-line bg-slate-50 p-1">
      <button
        type="button"
        className={cn("h-9 min-w-20 rounded-md px-3 text-sm font-bold transition", selected === "buy" ? "bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200" : "text-muted hover:bg-white/70")}
        onClick={() => onChange("buy")}
        disabled={busy}
      >
        {busy && selected !== "buy" ? <Loader className="mx-auto" /> : "BUY"}
      </button>
      <button
        type="button"
        className={cn("h-9 min-w-20 rounded-md px-3 text-sm font-bold transition", selected === "sell" ? "bg-white text-rose-700 shadow-sm ring-1 ring-rose-200" : "text-muted hover:bg-white/70")}
        onClick={() => onChange("sell")}
        disabled={busy}
      >
        {busy && selected !== "sell" ? <Loader className="mx-auto" /> : "SELL"}
      </button>
    </div>
  );
}

type RecentOrderRow = {
  key: string;
  levelIndex?: number;
  side: "BUY" | "SELL";
  orderType: "BUY LIMIT" | "BUY STOP" | "SELL LIMIT" | "SELL STOP" | "BUY POSITION" | "SELL POSITION";
  price: number;
  lot: number;
  stopLoss?: number;
  takeProfit?: number;
  status: "Pending" | "Open";
  ticket?: string;
  time?: string;
  sourceMode: string;
};

type RecentOrderSortKey = "level" | "source" | "orderType" | "entry" | "lot" | "sl" | "tp" | "status" | "ticket" | "placed";
type SortDirection = "asc" | "desc";

function RecentOrdersTable({ rows }: { rows: RecentOrderRow[] }) {
  const [sortKey, setSortKey] = useState<RecentOrderSortKey>("level");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const sortedRows = useMemo(() => sortRecentOrderRows(rows, sortKey, sortDirection), [rows, sortKey, sortDirection]);

  function setSort(nextKey: RecentOrderSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(nextKey);
    setSortDirection("asc");
  }

  return (
    <SectionCard title="Recent High / Low Orders" subtitle="Live Recent-mode orders currently tracked in MT5.">
      <div className="grid gap-2 md:hidden">
        {sortedRows.map((row) => (
          <div key={row.key} className="rounded-lg border border-line bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div className={row.side === "BUY" ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>{row.orderType}</div>
              <span className={statusClass(row.status)}>{row.status}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <RecentOrderValue label="Source" value={row.sourceMode} />
              <RecentOrderValue label="Entry" value={row.price.toFixed(2)} />
              <RecentOrderValue label="Lot" value={row.lot.toFixed(2)} />
              <RecentOrderValue label="SL" value={formatOptionalPrice(row.stopLoss)} />
              <RecentOrderValue label="TP" value={formatOptionalPrice(row.takeProfit)} />
            </div>
            <div className="mt-3 break-all text-xs font-semibold text-muted">Ticket: {row.ticket ?? "Syncing"}{row.time ? ` · ${formatOrderTime(row.time)}` : ""}</div>
          </div>
        ))}
        {sortedRows.length === 0 && <div className="rounded-lg border border-dashed border-line bg-white p-4 text-center text-sm font-medium text-muted">No Recent-mode pending or open orders.</div>}
      </div>
      <div className="hidden max-h-[420px] overflow-auto rounded-xl border border-line bg-white md:block">
        <table className="w-full min-w-[1020px] border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
            <tr>
              <RecentOrderSortableHeader label="Level" sortKey="level" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Source" sortKey="source" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Order Type" sortKey="orderType" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Entry" sortKey="entry" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Lot" sortKey="lot" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="SL" sortKey="sl" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="TP" sortKey="tp" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Status" sortKey="status" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Ticket" sortKey="ticket" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
              <RecentOrderSortableHeader label="Placed" sortKey="placed" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.key} className="border-t border-line hover:bg-slate-50">
                <td className="px-4 py-3 font-bold">{row.levelIndex === undefined ? "-" : row.levelIndex > 0 ? `+${row.levelIndex}` : row.levelIndex}</td>
                <td className="px-4 py-3"><span className={sourceModeClass(row.sourceMode)}>{row.sourceMode}</span></td>
                <td className={row.side === "BUY" ? "px-4 py-3 font-bold text-emerald-700" : "px-4 py-3 font-bold text-rose-700"}>{row.orderType}</td>
                <td className="px-4 py-3 font-semibold">{row.price.toFixed(2)}</td>
                <td className="px-4 py-3 font-semibold">{row.lot.toFixed(2)}</td>
                <td className="px-4 py-3">{formatOptionalPrice(row.stopLoss)}</td>
                <td className="px-4 py-3">{formatOptionalPrice(row.takeProfit)}</td>
                <td className="px-4 py-3"><span className={statusClass(row.status)}>{row.status}</span></td>
                <td className="px-4 py-3 font-mono text-xs">{row.ticket ?? "Syncing"}</td>
                <td className="px-4 py-3 text-xs font-semibold text-muted">{row.time ? formatOrderTime(row.time) : "-"}</td>
              </tr>
            ))}
            {sortedRows.length === 0 && <tr><td className="px-4 py-6 text-center font-medium text-muted" colSpan={10}>No Recent-mode pending or open orders.</td></tr>}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function RecentOrderSortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort
}: {
  label: string;
  sortKey: RecentOrderSortKey;
  activeKey: RecentOrderSortKey;
  direction: SortDirection;
  onSort: (key: RecentOrderSortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="px-2 py-2">
      <button
        type="button"
        className={cn("flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-bold uppercase transition hover:bg-white hover:text-slate-900", active && "bg-white text-slate-900 shadow-sm")}
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        <ArrowUpDown size={13} className={active ? "text-blue-600" : "text-slate-400"} />
        {active && <span className="text-[10px] text-blue-600">{direction === "asc" ? "ASC" : "DESC"}</span>}
      </button>
    </th>
  );
}

function RecentOrderValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-line bg-slate-50 px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-muted">{label}</div><div className="font-semibold">{value}</div></div>;
}

function sortRecentOrderRows(rows: RecentOrderRow[], sortKey: RecentOrderSortKey, direction: SortDirection) {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const compared = compareRecentOrderValues(recentOrderSortValue(left, sortKey), recentOrderSortValue(right, sortKey));
    if (compared !== 0) return compared * sign;
    return left.key.localeCompare(right.key);
  });
}

function recentOrderSortValue(row: RecentOrderRow, sortKey: RecentOrderSortKey) {
  if (sortKey === "level") return row.levelIndex ?? Number.POSITIVE_INFINITY;
  if (sortKey === "source") return row.sourceMode;
  if (sortKey === "orderType") return row.orderType;
  if (sortKey === "entry") return row.price;
  if (sortKey === "lot") return row.lot;
  if (sortKey === "sl") return row.stopLoss ?? Number.POSITIVE_INFINITY;
  if (sortKey === "tp") return row.takeProfit ?? Number.POSITIVE_INFINITY;
  if (sortKey === "status") return row.status;
  if (sortKey === "ticket") return row.ticket ?? "";
  return row.time ? Date.parse(row.time) : Number.POSITIVE_INFINITY;
}

function compareRecentOrderValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function makeRecentOrderRows(snapshot: ReturnType<typeof useSnapshot>["snapshot"]): RecentOrderRow[] {
  if (!snapshot?.config || snapshot.settings.adaptiveHighLowMode !== "recent") return [];
  const pendingByTicket = new Map(snapshot.brokerPendingOrders.map((order) => [order.brokerOrderId, order]));
  const openByTicket = new Map<string, (typeof snapshot.brokerPositions)[number]>();
  for (const position of snapshot.brokerPositions) {
    openByTicket.set(position.brokerOrderId, position);
    if (position.positionIdentifier) openByTicket.set(position.positionIdentifier, position);
  }
  const representedTickets = new Set<string>();
  const rows: RecentOrderRow[] = snapshot.positions
    .filter((position) => (position.status === "OPEN" || position.status === "PENDING") && positionMatchesMode(position, snapshot.settings.adaptiveHighLowMode))
    .map((position) => {
      const pending = position.brokerOrderId ? pendingByTicket.get(position.brokerOrderId) : undefined;
      const open = position.brokerOrderId ? openByTicket.get(position.brokerOrderId) : undefined;
      if (position.brokerOrderId) representedTickets.add(position.brokerOrderId);
      const status = position.status === "OPEN" ? "Open" as const : "Pending" as const;
      const price = pending?.price ?? open?.entryPrice ?? position.levelPrice;
      return {
        key: `local-${position.id}`,
        levelIndex: position.levelIndex,
        sourceMode: orderSourceMode(position.strategyMode, snapshot.settings.adaptiveHighLowMode),
        side: position.side,
        orderType: status === "Open" ? `${position.side} POSITION` : brokerOrderType(position.side, pending?.orderType, price, snapshot.tick),
        price,
        lot: pending?.volume ?? open?.volume ?? position.volume,
        stopLoss: pending?.stopLoss ?? open?.stopLoss,
        takeProfit: pending?.takeProfit ?? open?.takeProfit ?? recentTakeProfit(snapshot.config, position.side, price),
        status,
        ticket: position.brokerOrderId,
        time: pending?.placedAt ?? open?.openedAt ?? position.openedAt
      };
    });

  for (const pending of snapshot.brokerPendingOrders) {
    if (representedTickets.has(pending.brokerOrderId)) continue;
    if (!brokerOrderMatchesMode(pending, snapshot.settings.adaptiveHighLowMode)) continue;
    rows.push({
      key: `broker-${pending.brokerOrderId}`,
      sourceMode: "Untracked",
      side: pending.side,
      orderType: brokerOrderType(pending.side, pending.orderType, pending.price, snapshot.tick),
      price: pending.price,
      lot: pending.volume,
      stopLoss: pending.stopLoss,
      takeProfit: pending.takeProfit,
      status: "Pending",
      ticket: pending.brokerOrderId,
      time: pending.placedAt
    });
  }
  return rows.sort((left, right) => Date.parse(right.time ?? "") - Date.parse(left.time ?? ""));
}

function brokerOrderMatchesMode(order: { side: "BUY" | "SELL"; comment: string }, currentMode: AppSettings["adaptiveHighLowMode"]) {
  const parsed = brokerCommentLevel(order.comment, order.side);
  return !parsed?.mode || parsed.mode === currentMode;
}

function orderSourceMode(mode: AppSettings["adaptiveHighLowMode"] | undefined, currentMode: AppSettings["adaptiveHighLowMode"]) {
  if (!mode) return "Unknown";
  const label = modeLabel(mode);
  return mode === currentMode ? `Current ${label}` : `Old ${label}`;
}

function modeLabel(mode: AppSettings["adaptiveHighLowMode"]) {
  if (mode === "auto") return "Auto";
  if (mode === "manual") return "Manual";
  return "Recent";
}

function sourceModeClass(sourceMode: string) {
  if (sourceMode.startsWith("Current")) return "rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700";
  if (sourceMode.startsWith("Old")) return "rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-bold text-rose-700";
  return "rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-600";
}

function brokerOrderType(side: "BUY" | "SELL", rawType: string | undefined, levelPrice: number, tick: Tick | null | undefined): RecentOrderRow["orderType"] {
  const type = Number(rawType);
  if (type === 2) return "BUY LIMIT";
  if (type === 3) return "SELL LIMIT";
  if (type === 4 || type === 6) return "BUY STOP";
  if (type === 5 || type === 7) return "SELL STOP";
  const price = tick ? tick.last || (tick.bid + tick.ask) / 2 : levelPrice;
  if (side === "BUY") return levelPrice < price ? "BUY LIMIT" : "BUY STOP";
  return levelPrice > price ? "SELL LIMIT" : "SELL STOP";
}

function recentTakeProfit(config: StrategyConfig, side: "BUY" | "SELL", price: number) {
  const distance = takeProfitDistance(config, price);
  return side === "BUY" ? price + distance : price - distance;
}

function formatOptionalPrice(value: number | undefined) {
  return value && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function formatOrderTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

type TradePlanRow = {
  leg: number;
  side: "BUY" | "SELL";
  entry: number;
  lot: number;
  tp: number;
  distance: number;
  status: string;
  enabled: boolean;
};

function makeTradePlan(snapshot: ReturnType<typeof useSnapshot>["snapshot"]) {
  const config = snapshot?.config;
  const market = snapshot?.market;
  const tick = snapshot?.tick;
  if (!config || !market || !tick) return [];

  const side = config.direction === "sell" ? "SELL" : "BUY";
  const anchor = side === "BUY" ? market.adaptiveHigh : market.adaptiveLow;
  const distance = config.gridType === "percentage" ? (anchor * config.gridDistance) / 100 : config.gridDistance;
  const price = tick.last || (tick.bid + tick.ask) / 2;
  const currentMode = snapshot.settings.adaptiveHighLowMode;
  const activePositions = snapshot.positions.filter((p) => (p.status === "OPEN" || p.status === "PENDING") && positionMatchesMode(p, currentMode));

  return config.legs
    .map((leg, index) => {
      const legNumber = index + 1;
      const entry = side === "BUY" ? anchor - legNumber * distance : anchor + legNumber * distance;
      const tp = side === "BUY" ? entry + takeProfitDistance(config, entry) : entry - takeProfitDistance(config, entry);
      const active = activePositions.find((p) => p.side === side && p.levelIndex === legNumber && priceClose(p.levelPrice, entry));
      const brokerOpen = snapshot.brokerPositions.find((position) => isBrokerPositionForLevel(position, side, legNumber, entry, snapshot.settings.adaptiveHighLowMode));
      const brokerPending = snapshot.brokerPendingOrders.find((order) => isBrokerPendingForLevel(order, side, legNumber, entry, snapshot.settings.adaptiveHighLowMode));
      const oldConceptActive = activePositions.find((p) => p.side === side && ((p.levelIndex !== legNumber && priceClose(p.levelPrice, entry)) || (p.levelIndex === legNumber && !priceClose(p.levelPrice, entry))));
      const oldConceptBrokerOpen = snapshot.brokerPositions.find((position) => isBrokerOldConceptForLevel(position, side, legNumber, entry, position.entryPrice, currentMode));
      const oldConceptBrokerPending = snapshot.brokerPendingOrders.find((order) => isBrokerOldConceptForLevel(order, side, legNumber, entry, order.price, currentMode));
      const triggerReady = side === "BUY" ? price <= entry : price >= entry;
      const startLocked = isStartLockedRow(snapshot.entryGate, config.symbol, market.day, side, legNumber, anchor, distance, price);
      return {
        leg: legNumber,
        side,
        entry,
        lot: leg.lotSize,
        tp,
        distance,
        enabled: leg.enabled,
        status: active?.status === "OPEN" || brokerOpen
          ? "Open"
          : active?.status === "PENDING" || brokerPending
            ? "Pending"
            : oldConceptActive?.status === "OPEN" || oldConceptBrokerOpen
              ? "Old Open"
              : oldConceptActive?.status === "PENDING" || oldConceptBrokerPending
                ? "Old Pending"
                : !leg.enabled
                  ? "Disabled"
                  : !isEntrySideReady(market, side)
                    ? "Awaiting Breakout"
                  : startLocked
                    ? "Start Locked"
                    : triggerReady
                      ? "Level Reached"
                      : "Waiting"
      };
    })
    .filter(Boolean) as TradePlanRow[];
}

function statusClass(status: string) {
  if (status === "Open") return "rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700";
  if (status === "Pending") return "rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700";
  if (status === "Old Open" || status === "Old Pending") return "rounded-md border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs font-bold text-cyan-700";
  if (status === "Start Locked") return "rounded-md border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700";
  if (status === "Level Reached") return "rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-xs font-bold text-purple-700";
  if (status === "Disabled") return "rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-400";
  return "rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-600";
}

function hasActiveOrder(row: TradePlanRow) {
  return row.status === "Open" || row.status === "Pending";
}

function isEntryLocked(row: TradePlanRow) {
  return row.status === "Start Locked" || row.status === "Awaiting Breakout";
}

function isOldConceptOrder(row: TradePlanRow) {
  return row.status === "Old Open" || row.status === "Old Pending";
}

function priceClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.05;
}

function isBrokerPositionForLevel(
  position: BrokerPosition,
  side: "BUY" | "SELL",
  levelIndex: number,
  entry: number,
  currentMode: AppSettings["adaptiveHighLowMode"]
) {
  if (position.side !== side) return false;
  return priceClose(position.entryPrice, entry) && brokerCommentMatchesLevel(position.comment, side, levelIndex, currentMode);
}

function isBrokerPendingForLevel(
  order: BrokerPendingOrder,
  side: "BUY" | "SELL",
  levelIndex: number,
  entry: number,
  currentMode: AppSettings["adaptiveHighLowMode"]
) {
  if (order.side !== side) return false;
  return priceClose(order.price, entry) && brokerCommentMatchesLevel(order.comment, side, levelIndex, currentMode);
}

function isBrokerOldConceptForLevel(
  order: { side: "BUY" | "SELL"; comment: string },
  side: "BUY" | "SELL",
  levelIndex: number,
  entry: number,
  price: number,
  currentMode: AppSettings["adaptiveHighLowMode"]
) {
  if (order.side !== side) return false;
  const parsed = brokerCommentLevel(order.comment, side);
  if (!parsed || (parsed.mode && parsed.mode !== currentMode)) return false;
  if (parsed.level === levelIndex) return !priceClose(price, entry);
  return priceClose(price, entry);
}

function brokerCommentMatchesLevel(comment: string, side: "BUY" | "SELL", levelIndex: number, currentMode: AppSettings["adaptiveHighLowMode"]) {
  const parsed = brokerCommentLevel(comment, side);
  if (!parsed) return true;
  return parsed.level === levelIndex && parsed.mode === currentMode;
}

function brokerCommentLevel(comment: string, side: "BUY" | "SELL") {
  const code = side === "BUY" ? "B" : "S";
  const modeMatch = comment.match(new RegExp(`^ag-([amr])-${code}-(\\d+)$`));
  if (modeMatch) return { mode: modeFromCommentCode(modeMatch[1]), level: Number(modeMatch[2]) };
  const legacyMatch = comment.match(new RegExp(`^ag-${code}-(\\d+)$`));
  return legacyMatch ? { mode: undefined, level: Number(legacyMatch[1]) } : undefined;
}

function modeFromCommentCode(code: string): AppSettings["adaptiveHighLowMode"] | undefined {
  if (code === "a") return "auto";
  if (code === "m") return "manual";
  if (code === "r") return "recent";
  return undefined;
}

function positionMatchesMode(position: { strategyMode?: AppSettings["adaptiveHighLowMode"] }, currentMode: AppSettings["adaptiveHighLowMode"]) {
  return !position.strategyMode || position.strategyMode === currentMode;
}

function isStartLockedRow(
  entryGate: EntryStartGate | null | undefined,
  symbol: string,
  day: string,
  side: "BUY" | "SELL",
  levelIndex: number,
  anchor: number,
  distance: number,
  price: number
) {
  if (!entryGate || entryGate.symbol !== symbol || entryGate.day !== day) return false;
  const locked = entryGate.lockedLevels.some((level: EntryStartGate["lockedLevels"][number]) => level.side === side && level.levelIndex === levelIndex);
  if (!locked) return false;
  if (side === "BUY" && entryGate.buyAnchor !== undefined && anchor > entryGate.buyAnchor) return false;
  if (side === "SELL" && entryGate.sellAnchor !== undefined && anchor < entryGate.sellAnchor) return false;
  const recoveryThreshold = side === "BUY" ? anchor - levelIndex * distance : anchor + levelIndex * distance;
  return side === "BUY" ? price < recoveryThreshold : price > recoveryThreshold;
}

function InlineLotInput({ value, onSave }: { value: number; onSave: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(String(value));
    setDirty(false);
  }, [value]);

  async function save() {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setText(String(value));
      setDirty(false);
      return;
    }
    setSaving(true);
    await onSave(parsed);
    setSaving(false);
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        className="h-9 min-w-20 flex-1 rounded-lg border border-line bg-white px-3 text-sm font-semibold outline-none transition focus:border-ink focus:ring-2 focus:ring-slate-200 sm:w-24 sm:flex-none"
        type="number"
        min="0.01"
        step="0.01"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setDirty(next !== String(value));
          setSaved(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      {dirty && (
        <button type="button" className="h-9 rounded-lg border border-ink bg-white px-3 text-xs font-bold text-ink transition hover:bg-slate-100" onClick={save}>
          {saving ? "..." : "Update"}
        </button>
      )}
      {saved && <span className="text-xs font-bold text-emerald-700">Updated</span>}
    </div>
  );
}
