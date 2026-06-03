"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, Gauge, LayoutDashboard, LogOut, Moon, Power, RefreshCw, Settings, Settings2, Sun, WalletCards, X } from "lucide-react";
import { cn } from "@/components/ui";
import { money } from "./format";
import type { Snapshot } from "./types";
import { useTheme } from "./theme-provider";
import { BusyOverlay, Loader } from "./loader";
import { useState } from "react";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/strategy", label: "Strategy", icon: Settings2 },
  { href: "/positions", label: "Positions", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({
  snapshot,
  onRefresh,
  children
}: {
  snapshot: Snapshot | null;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  async function toggleTrading(enabled: boolean) {
    setBusyLabel(enabled ? "Enabling engine" : "Disabling engine");
    try {
      const response = await fetch("/api/trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        window.alert(data.error ?? "Trading could not be updated");
      }
      await onRefresh?.();
    } finally {
      setBusyLabel(null);
    }
  }

  async function logout() {
    setBusyLabel("Logging out");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.reload();
    } finally {
      setBusyLabel(null);
    }
  }

  async function refresh() {
    setBusyLabel("Refreshing");
    try {
      await onRefresh?.();
    } finally {
      setBusyLabel(null);
    }
  }

  const enabled = Boolean(snapshot?.status.enabled);
  const connected = Boolean(snapshot?.status.connected);

  return (
    <main className={cn("min-h-screen text-ink", theme === "dark" ? "bg-black text-slate-50" : "bg-[#eef2f8]")}>
      <BusyOverlay show={Boolean(busyLabel)} label={busyLabel ?? "Working"} />
      <div className="flex min-h-screen">
        <aside className={cn("sticky top-0 hidden h-screen w-72 shrink-0 border-r text-white lg:block", theme === "dark" ? "border-zinc-800 bg-black" : "border-white/60 bg-[#111827] shadow-2xl")}>
          <div className="px-5 py-6">
            <div className={cn("rounded-xl p-4 ring-1", theme === "dark" ? "bg-zinc-950 ring-zinc-800" : "bg-white/10 ring-white/10")}>
              <div className="text-xl font-semibold">Grid Trader Pro</div>
              <div className={cn("mt-1 text-xs font-semibold uppercase", theme === "dark" ? "text-zinc-400" : "text-cyan-200")}>MT5 Gold Algo</div>
            </div>
          </div>
          <nav className="grid gap-2 px-4">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch
                  className={cn(
                    "flex h-12 items-center gap-3 rounded-lg px-4 text-sm font-semibold transition",
                    active
                      ? theme === "dark"
                        ? "border border-zinc-600 bg-zinc-900 text-white"
                        : "bg-white text-[#111827] shadow-lg"
                      : theme === "dark"
                        ? "text-zinc-400 hover:bg-zinc-900 hover:text-white"
                        : "text-slate-200 hover:bg-white/10 hover:text-white"
                  )}
                >
                  <Icon size={18} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className={cn("absolute bottom-0 left-0 right-0 border-t p-4", theme === "dark" ? "border-zinc-800" : "border-white/10")}>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                className={cn("flex h-9 items-center justify-center gap-2 rounded-md border text-xs font-bold", theme === "light" ? "border-white bg-white text-[#111827]" : "border-zinc-700 bg-black text-zinc-400 hover:bg-zinc-900")}
                onClick={() => setTheme("light")}
              >
                <Sun size={14} /> Light
              </button>
              <button
                type="button"
                className={cn("flex h-9 items-center justify-center gap-2 rounded-md border text-xs font-bold", theme === "dark" ? "border-zinc-500 bg-zinc-900 text-white" : "border-white/20 bg-white/10 text-slate-200")}
                onClick={() => setTheme("dark")}
              >
                <Moon size={14} /> Dark
              </button>
            </div>
            <button
              type="button"
              className={cn("mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border text-xs font-bold", theme === "dark" ? "border-zinc-700 bg-black text-zinc-300 hover:bg-zinc-900" : "border-white/20 bg-white/10 text-slate-200 hover:bg-white/15")}
              onClick={logout}
            >
              <LogOut size={14} /> Logout
            </button>
            <div className={cn("rounded-lg p-3 text-sm", theme === "dark" ? "border border-zinc-800 bg-zinc-950" : "bg-white/10")}>
              <div className="flex items-center justify-between">
                <span className="text-slate-300">Engine</span>
                <span className={enabled ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>{enabled ? "Enabled" : "Off"}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-slate-300">MT5</span>
                <span className={connected ? "font-semibold text-cyan-200" : "font-semibold text-rose-300"}>{connected ? "Connected" : "Offline"}</span>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className={cn("sticky top-0 z-20 border-b backdrop-blur", theme === "dark" ? "border-zinc-800 bg-black/90" : "border-white/70 bg-white/85 shadow-sm")}>
            <div className="mx-auto flex max-w-7xl flex-col gap-2 px-2.5 py-2.5 sm:gap-3 sm:px-6 sm:py-3 lg:flex-row lg:items-center xl:px-8">
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5 sm:gap-2 xl:grid-cols-4">
                <TopStat icon={<Activity size={16} />} label="MT5" value={connected ? "Connected" : "Offline"} tone={connected ? "cyan" : "rose"} />
                <TopStat icon={<Gauge size={16} />} label="Basket PnL" value={money(snapshot?.account.floatingPnl ?? 0)} tone="violet" />
                <TopStat icon={<WalletCards size={16} />} label="Balance" value={money(snapshot?.account.balance ?? 0)} tone="amber" />
                <TopStat icon={<Power size={16} />} label="Engine" value={enabled ? "Enabled" : "Disabled"} tone={enabled ? "emerald" : "slate"} />
              </div>

              <div className="grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 lg:flex lg:justify-end">
                  <button type="button" className="btn-secondary h-9 min-w-0 gap-1 px-1.5 text-[11px] sm:h-10 sm:gap-2 sm:px-3 sm:text-sm" onClick={refresh} disabled={Boolean(busyLabel)}>
                    {busyLabel === "Refreshing" ? <Loader /> : <RefreshCw size={16} />} Refresh
                  </button>
                  <button type="button" className={cn("btn-primary h-9 min-w-0 gap-1 px-1.5 text-[11px] sm:h-10 sm:gap-2 sm:px-3 sm:text-sm", enabled && "ring-4 ring-emerald-100")} onClick={() => toggleTrading(true)} disabled={Boolean(busyLabel)}>
                    {busyLabel === "Enabling engine" ? <Loader /> : <Power size={16} />} {enabled ? "Enabled" : "Enable"}
                  </button>
                  <button type="button" className="btn-danger h-9 min-w-0 gap-1 px-1.5 text-[11px] sm:h-10 sm:gap-2 sm:px-3 sm:text-sm" onClick={() => toggleTrading(false)} disabled={Boolean(busyLabel)}>
                    {busyLabel === "Disabling engine" ? <Loader /> : <X size={16} />} Disable
                  </button>
                  <button type="button" className="btn-secondary col-span-3 h-9 min-w-0 gap-1 px-1.5 text-[11px] sm:h-10 sm:gap-2 sm:px-3 sm:text-sm lg:col-span-1" onClick={logout}>
                    <LogOut size={16} /> Logout
                  </button>
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-5 xl:px-8">{children}</div>
        </section>
      </div>
    </main>
  );
}

function TopStat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: "cyan" | "rose" | "violet" | "amber" | "emerald" | "slate" }) {
  const tones = {
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    slate: "border-slate-200 bg-slate-50 text-slate-700"
  };
  return (
    <div className="min-w-0 rounded-lg border border-white/70 bg-white px-2 py-1.5 text-ink shadow-sm dark-card sm:px-3 sm:py-2">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <div className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md border sm:h-8 sm:w-8", tones[tone])}>{icon}</div>
        <div className="min-w-0">
          <div className="truncate text-[9px] font-bold uppercase leading-3 text-muted sm:text-[10px]">{label}</div>
          <div className="truncate text-xs font-semibold leading-4 sm:text-sm">{value}</div>
        </div>
      </div>
    </div>
  );
}
