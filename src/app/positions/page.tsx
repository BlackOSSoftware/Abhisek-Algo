"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/trader/app-shell";
import { SectionCard, EmptyState } from "@/components/trader/cards";
import { cn } from "@/components/ui";
import { useSnapshot } from "@/components/trader/use-snapshot";
import type { Position } from "@/lib/types";

export default function PositionsPage() {
  const { snapshot, reload } = useSnapshot();
  const [positions, setPositions] = useState<Position[]>([]);

  async function loadPositions() {
    const response = await fetch("/api/positions", { cache: "no-store" });
    const data = (await response.json()) as { positions?: Position[] };
    setPositions(data.positions ?? []);
  }

  useEffect(() => {
    loadPositions();
  }, []);

  async function refreshAll() {
    await reload();
    await loadPositions();
  }

  return (
    <AppShell snapshot={snapshot} onRefresh={refreshAll}>
      <SectionCard title="Positions" subtitle="Open and recent closed positions with fixed-height scrolling.">
        {!positions.length && <EmptyState text="No positions yet." />}
        {!!positions.length && (
          <>
            <div className="grid max-h-[680px] gap-3 overflow-auto md:hidden">
              {positions.map((p) => (
                <div key={p.id} className="rounded-lg border border-line bg-white p-3 dark-card">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className={cn("text-sm font-bold", p.side === "BUY" ? "text-emerald-600" : "text-rose-600")}>{p.side}</div>
                      <div className="mt-1 text-xs font-bold text-muted">Leg {p.levelIndex}</div>
                    </div>
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-700">{p.status}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <PositionField label="Level" value={p.levelPrice.toFixed(2)} />
                    <PositionField label="Entry" value={p.entryPrice.toFixed(2)} />
                    <PositionField label="Volume" value={String(p.volume)} />
                    <PositionField label="Broker" value={p.brokerOrderId ?? "-"} />
                  </div>
                  <div className="mt-3 text-xs font-medium text-muted">{new Date(p.openedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="hidden max-h-[680px] overflow-auto rounded-xl border border-line bg-white dark-card md:block">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-100 text-left text-xs font-bold uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3">Side</th>
                    <th className="px-4 py-3">Leg</th>
                    <th className="px-4 py-3">Level</th>
                    <th className="px-4 py-3">Entry</th>
                    <th className="px-4 py-3">Volume</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Broker Order</th>
                    <th className="px-4 py-3">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id} className="border-t border-line hover:bg-blue-50/50">
                      <td className={p.side === "BUY" ? "px-4 py-3 font-bold text-emerald-600" : "px-4 py-3 font-bold text-rose-600"}>{p.side}</td>
                      <td className="px-4 py-3 font-semibold">{p.levelIndex}</td>
                      <td className="px-4 py-3">{p.levelPrice.toFixed(2)}</td>
                      <td className="px-4 py-3">{p.entryPrice.toFixed(2)}</td>
                      <td className="px-4 py-3">{p.volume}</td>
                      <td className="px-4 py-3">{p.status}</td>
                      <td className="px-4 py-3 text-muted">{p.brokerOrderId ?? "-"}</td>
                      <td className="px-4 py-3 text-muted">{new Date(p.openedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>
    </AppShell>
  );
}

function PositionField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}
