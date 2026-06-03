"use client";

import { AlertTriangle, Clock3, ListChecks, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/trader/app-shell";
import { EmptyState, SectionCard } from "@/components/trader/cards";
import { money, num } from "@/components/trader/format";
import { cn } from "@/components/ui";
import { useSnapshot } from "@/components/trader/use-snapshot";
import type { BrokerPendingOrder, BrokerPosition, Position } from "@/lib/types";

type PositionsResponse = {
  positions?: Position[];
  localPositions?: Position[];
  brokerPositions?: BrokerPosition[];
  brokerPendingOrders?: BrokerPendingOrder[];
  brokerError?: string;
};

export default function PositionsPage() {
  const { snapshot, reload } = useSnapshot();
  const [data, setData] = useState<PositionsResponse>({});
  const [loading, setLoading] = useState(true);

  async function loadPositions() {
    const response = await fetch("/api/positions", { cache: "no-store" });
    const next = (await response.json()) as PositionsResponse;
    setData(next);
    setLoading(false);
  }

  useEffect(() => {
    loadPositions();
    const id = window.setInterval(loadPositions, 2500);
    return () => window.clearInterval(id);
  }, []);

  async function refreshAll() {
    setLoading(true);
    await reload();
    await loadPositions();
  }

  const brokerPositions = data.brokerPositions ?? snapshot?.brokerPositions ?? [];
  const brokerPendingOrders = data.brokerPendingOrders ?? snapshot?.brokerPendingOrders ?? [];
  const localPositions = data.localPositions ?? data.positions ?? [];
  const brokerError = data.brokerError ?? snapshot?.brokerError;
  const activeLocal = localPositions.filter((position) => position.status === "OPEN" || position.status === "PENDING");
  const closedLocal = localPositions.filter((position) => position.status === "CLOSED" || position.status === "REJECTED");
  const floating = brokerPositions.reduce((sum, position) => sum + (position.profit ?? 0), 0);
  const lots = brokerPositions.reduce((sum, position) => sum + position.volume, 0);
  const pendingLots = brokerPendingOrders.reduce((sum, order) => sum + order.volume, 0);
  const updatedAt = useMemo(() => new Date(), [brokerPositions, brokerPendingOrders, localPositions]);

  return (
    <AppShell snapshot={snapshot} onRefresh={refreshAll}>
      <div className="grid gap-4 sm:gap-5">
        {brokerError && (
          <div className="flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-rose-800">
            <AlertTriangle className="mt-0.5 shrink-0" size={20} />
            <div className="min-w-0">
              <div className="text-sm font-bold">MT5 positions could not be read</div>
              <div className="mt-0.5 break-words text-sm font-semibold">{brokerError}</div>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile icon={<TrendingUp size={18} />} label="Live Positions" value={String(brokerPositions.length)} tone="cyan" />
          <SummaryTile icon={<Clock3 size={18} />} label="Pending Orders" value={String(brokerPendingOrders.length)} tone="amber" />
          <SummaryTile icon={<ListChecks size={18} />} label="Open Lots" value={lots.toFixed(2)} tone="emerald" />
          <SummaryTile icon={<TrendingDown size={18} />} label="Floating PnL" value={money(floating)} tone={floating >= 0 ? "emerald" : "rose"} />
        </div>

        <SectionCard
          title="MT5 Live Positions"
          subtitle={`Broker positions from MT5. Updated ${updatedAt.toLocaleTimeString()}.`}
          action={
            <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={refreshAll} disabled={loading}>
              <RefreshCw size={15} /> Refresh
            </button>
          }
        >
          <LivePositionsTable positions={brokerPositions} />
        </SectionCard>

        <SectionCard title="MT5 Pending Orders" subtitle={`Pending limit/stop orders waiting at broker. Pending lots ${pendingLots.toFixed(2)}.`}>
          <PendingOrdersTable orders={brokerPendingOrders} />
        </SectionCard>

        <SectionCard title="Local Order History" subtitle={`Database audit trail. Active local records ${activeLocal.length}.`}>
          <LocalHistoryTable active={activeLocal} closed={closedLocal} />
        </SectionCard>
      </div>
    </AppShell>
  );
}

function LivePositionsTable({ positions }: { positions: BrokerPosition[] }) {
  if (!positions.length) return <EmptyState text="No live MT5 positions found." />;
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {positions.map((position) => (
          <BrokerPositionCard key={position.brokerOrderId} position={position} />
        ))}
      </div>
      <div className="hidden max-h-[430px] overflow-auto rounded-lg border border-line bg-white md:block">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
            <tr>
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Symbol</th>
              <th className="px-4 py-3">Side</th>
              <th className="px-4 py-3">Volume</th>
              <th className="px-4 py-3">Entry</th>
              <th className="px-4 py-3">Current</th>
              <th className="px-4 py-3">SL / TP</th>
              <th className="px-4 py-3">PnL</th>
              <th className="px-4 py-3">Opened</th>
              <th className="px-4 py-3">Comment</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.brokerOrderId} className="border-t border-line hover:bg-slate-50">
                <td className="px-4 py-3 font-semibold">{position.brokerOrderId}</td>
                <td className="px-4 py-3">{position.symbol}</td>
                <td className={sideClass(position.side)}>{position.side}</td>
                <td className="px-4 py-3">{position.volume.toFixed(2)}</td>
                <td className="px-4 py-3">{num(position.entryPrice)}</td>
                <td className="px-4 py-3">{num(position.currentPrice)}</td>
                <td className="px-4 py-3">{num(position.stopLoss)} / {num(position.takeProfit)}</td>
                <td className={pnlClass(position.profit)}>{money(position.profit ?? 0)}</td>
                <td className="px-4 py-3 text-muted">{formatTime(position.openedAt)}</td>
                <td className="px-4 py-3 text-muted">{position.comment || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PendingOrdersTable({ orders }: { orders: BrokerPendingOrder[] }) {
  if (!orders.length) return <EmptyState text="No pending MT5 orders found." />;
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {orders.map((order) => (
          <PendingOrderCard key={order.brokerOrderId} order={order} />
        ))}
      </div>
      <div className="hidden max-h-[430px] overflow-auto rounded-lg border border-line bg-white md:block">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
            <tr>
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Symbol</th>
              <th className="px-4 py-3">Side</th>
              <th className="px-4 py-3">Volume</th>
              <th className="px-4 py-3">Order Price</th>
              <th className="px-4 py-3">SL / TP</th>
              <th className="px-4 py-3">Placed</th>
              <th className="px-4 py-3">Comment</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.brokerOrderId} className="border-t border-line hover:bg-slate-50">
                <td className="px-4 py-3 font-semibold">{order.brokerOrderId}</td>
                <td className="px-4 py-3">{order.symbol}</td>
                <td className={sideClass(order.side)}>{order.side}</td>
                <td className="px-4 py-3">{order.volume.toFixed(2)}</td>
                <td className="px-4 py-3 font-semibold">{num(order.price)}</td>
                <td className="px-4 py-3">{num(order.stopLoss)} / {num(order.takeProfit)}</td>
                <td className="px-4 py-3 text-muted">{formatTime(order.placedAt)}</td>
                <td className="px-4 py-3 text-muted">{order.comment || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LocalHistoryTable({ active, closed }: { active: Position[]; closed: Position[] }) {
  const rows = [...active, ...closed].slice(0, 120);
  if (!rows.length) return <EmptyState text="No local position history yet." />;
  return (
    <div className="max-h-[520px] overflow-auto rounded-lg border border-line bg-white">
      <table className="w-full min-w-[940px] border-collapse text-sm">
        <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
          <tr>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Side</th>
            <th className="px-4 py-3">Leg</th>
            <th className="px-4 py-3">Level</th>
            <th className="px-4 py-3">Entry</th>
            <th className="px-4 py-3">Close</th>
            <th className="px-4 py-3">Volume</th>
            <th className="px-4 py-3">PnL</th>
            <th className="px-4 py-3">Broker Order</th>
            <th className="px-4 py-3">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((position) => (
            <tr key={position.id} className="border-t border-line hover:bg-slate-50">
              <td className="px-4 py-3"><StatusPill status={position.status} /></td>
              <td className={sideClass(position.side)}>{position.side}</td>
              <td className="px-4 py-3 font-semibold">{position.levelIndex}</td>
              <td className="px-4 py-3">{num(position.levelPrice)}</td>
              <td className="px-4 py-3">{num(position.entryPrice)}</td>
              <td className="px-4 py-3">{num(position.closePrice)}</td>
              <td className="px-4 py-3">{position.volume.toFixed(2)}</td>
              <td className={pnlClass(position.pnl)}>{position.pnl === undefined ? "-" : money(position.pnl)}</td>
              <td className="px-4 py-3 text-muted">{position.brokerOrderId ?? "-"}</td>
              <td className="px-4 py-3 text-muted">{formatTime(position.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BrokerPositionCard({ position }: { position: BrokerPosition }) {
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <CardTop title={position.symbol} subtitle={`Ticket ${position.brokerOrderId}`} side={position.side} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label="Volume" value={position.volume.toFixed(2)} />
        <Field label="PnL" value={money(position.profit ?? 0)} tone={(position.profit ?? 0) >= 0 ? "green" : "red"} />
        <Field label="Entry" value={num(position.entryPrice)} />
        <Field label="Current" value={num(position.currentPrice)} />
        <Field label="SL" value={num(position.stopLoss)} />
        <Field label="TP" value={num(position.takeProfit)} />
      </div>
      <div className="mt-3 text-xs font-semibold text-muted">{formatTime(position.openedAt)} · {position.comment || "No comment"}</div>
    </div>
  );
}

function PendingOrderCard({ order }: { order: BrokerPendingOrder }) {
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <CardTop title={order.symbol} subtitle={`Ticket ${order.brokerOrderId}`} side={order.side} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label="Volume" value={order.volume.toFixed(2)} />
        <Field label="Order Price" value={num(order.price)} />
        <Field label="SL" value={num(order.stopLoss)} />
        <Field label="TP" value={num(order.takeProfit)} />
      </div>
      <div className="mt-3 text-xs font-semibold text-muted">{formatTime(order.placedAt)} · {order.comment || "No comment"}</div>
    </div>
  );
}

function SummaryTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: "cyan" | "amber" | "emerald" | "rose" }) {
  const tones = {
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700"
  };
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase text-muted">{label}</div>
          <div className="mt-2 text-2xl font-semibold">{value}</div>
        </div>
        <div className={cn("grid h-10 w-10 place-items-center rounded-lg border", tones[tone])}>{icon}</div>
      </div>
    </div>
  );
}

function CardTop({ title, subtitle, side }: { title: string; subtitle: string; side: "BUY" | "SELL" }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-bold">{title}</div>
        <div className="mt-1 truncate text-xs font-bold text-muted">{subtitle}</div>
      </div>
      <span className={side === "BUY" ? "rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700" : "rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-bold text-rose-700"}>{side}</span>
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-muted">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm font-semibold", tone === "green" && "text-emerald-700", tone === "red" && "text-rose-700")}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: Position["status"] }) {
  const classes = {
    OPEN: "border-emerald-200 bg-emerald-50 text-emerald-700",
    PENDING: "border-amber-200 bg-amber-50 text-amber-700",
    CLOSED: "border-slate-200 bg-slate-50 text-slate-700",
    REJECTED: "border-rose-200 bg-rose-50 text-rose-700"
  };
  return <span className={cn("rounded-md border px-2 py-1 text-xs font-bold", classes[status])}>{status}</span>;
}

function sideClass(side: "BUY" | "SELL") {
  return side === "BUY" ? "px-4 py-3 font-bold text-emerald-700" : "px-4 py-3 font-bold text-rose-700";
}

function pnlClass(value: number | undefined) {
  if (value === undefined) return "px-4 py-3 text-muted";
  return value >= 0 ? "px-4 py-3 font-bold text-emerald-700" : "px-4 py-3 font-bold text-rose-700";
}

function formatTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}
