"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Clock3, Percent, Plus, Save, Search, Target, Trash2 } from "lucide-react";
import { AppShell } from "@/components/trader/app-shell";
import { SectionCard } from "@/components/trader/cards";
import { normalizeConfig, useSnapshot } from "@/components/trader/use-snapshot";
import { cn, inputClass } from "@/components/ui";
import type { AppSettings, StrategyConfig } from "@/lib/types";

export default function StrategyPage() {
  const { snapshot, reload } = useSnapshot();
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!snapshot?.config || dirtyRef.current) return;
    setConfig(snapshot.config);
  }, [snapshot?.config]);

  useEffect(() => {
    if (!snapshot?.settings || dirtyRef.current) return;
    setSettings(snapshot.settings);
  }, [snapshot?.settings]);

  function replaceConfig(next: StrategyConfig) {
    dirtyRef.current = true;
    setDirty(true);
    setConfig(normalizeConfig(next));
  }

  function patchConfig(patch: Partial<StrategyConfig>) {
    if (!config) return;
    replaceConfig({ ...config, ...patch });
  }

  function patchSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    dirtyRef.current = true;
    setDirty(true);
    setSettings({ ...settings, ...patch });
  }

  function updateLeg(index: number, patch: Partial<StrategyConfig["legs"][number]>) {
    if (!config) return;
    const legs = config.legs.map((leg, i) => (i === index ? { ...leg, ...patch } : leg));
    replaceConfig({ ...config, legs, maxLegs: legs.length });
  }

  function addLeg() {
    if (!config) return;
    const previous = config.legs.at(-1);
    const legs = [...config.legs, { enabled: true, lotSize: previous?.lotSize ?? 0.01 }];
    replaceConfig({ ...config, legs, maxLegs: legs.length });
  }

  function removeLeg(index: number) {
    if (!config || config.legs.length <= 1) return;
    const legs = config.legs.filter((_, i) => i !== index);
    replaceConfig({ ...config, legs, maxLegs: legs.length });
  }

  async function saveConfig() {
    if (!config || !settings) return;
    const errors = validateStrategyConfig(config, settings);
    if (errors.length > 0) return;
    setSaving(true);
    const next = { ...config, maxLegs: config.legs.length };
    await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    dirtyRef.current = false;
    setDirty(false);
    await reload();
    setSaving(false);
  }

  const activeLegs = config?.legs.filter((leg) => leg.enabled).length ?? 0;
  const validationErrors = config && settings ? validateStrategyConfig(config, settings) : ["Configuration is loading"];
  const canSave = validationErrors.length === 0;
  const stopLossReady = Boolean(config && config.stopLoss > 0);
  const previewMarket = snapshot?.market && settings ? previewAdaptiveMarket(snapshot.market, settings) : snapshot?.market;
  const anchorPrice = config?.direction === "sell" ? previewMarket?.adaptiveLow : previewMarket?.adaptiveHigh;
  const gridStep = config && anchorPrice ? (config.gridType === "percentage" ? (anchorPrice * config.gridDistance) / 100 : config.gridDistance) : 0;

  return (
    <AppShell snapshot={snapshot} onRefresh={reload}>
      <div className="grid gap-3">
        <SectionCard
          title="Strategy Setup"
          subtitle={dirty ? "Unsaved changes. Save setup to apply." : "Configure symbol, side, grid and active legs."}
          action={
            <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50" onClick={saveConfig} disabled={!config || saving || !canSave}>
              <Save size={16} /> {saving ? "Saving..." : "Save Setup"}
            </button>
          }
        >
          {config && settings && (
            <div className="grid gap-3">
              {validationErrors.length > 0 && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                  {validationErrors[0]}
                </div>
              )}
              <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr]">
                <div className="rounded-xl border border-line bg-white p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase text-muted">
                    <Search size={16} /> Symbol
                  </div>
                  <input className={cn("h-11 w-full rounded-lg border bg-white px-3 text-base font-semibold outline-none transition focus:ring-2", !config.symbol.trim() ? "border-rose-300 focus:border-rose-500 focus:ring-rose-100" : "border-line focus:border-blue-500 focus:ring-blue-100")} value={config.symbol} onChange={(e) => patchConfig({ symbol: e.target.value.trim() })} placeholder="Type exact MT5 symbol" />
                </div>

                <ControlGroup title="Direction">
                  <DirectionButtons value={config.direction} onChange={(value) => patchConfig({ direction: value as StrategyConfig["direction"] })} />
                </ControlGroup>

                <ControlGroup title="Stop Loss">
                  <div className="grid gap-2">
                    <NumericInput value={config.stopLoss} onChange={(value) => patchConfig({ stopLoss: value })} invalid={config.stopLoss <= 0} className="h-10 rounded-lg" />
                    {!stopLossReady && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700">Required before trading starts</div>}
                  </div>
                </ControlGroup>
              </div>

              <ControlGroup title="Adaptive High / Low">
                <div className="grid gap-3 xl:grid-cols-[180px_1fr_1fr]">
                  <label className="grid gap-1.5 text-sm font-bold text-muted">
                    <span>Mode</span>
                    <select
                      className={cn(inputClass, "h-10 rounded-lg")}
                      value={settings.adaptiveHighLowMode}
                      onChange={(event) => patchSettings({ adaptiveHighLowMode: event.target.value as AppSettings["adaptiveHighLowMode"] })}
                    >
                      <option value="auto">Auto</option>
                      <option value="manual">Manual</option>
                    </select>
                  </label>
                  <label className="grid gap-1.5 text-sm font-bold text-muted">
                    <span>Manual High</span>
                    <AdaptiveNumberInput
                      value={settings.manualAdaptiveHigh ?? null}
                      disabled={settings.adaptiveHighLowMode !== "manual"}
                      invalid={settings.adaptiveHighLowMode === "manual" && !settings.manualAdaptiveHigh}
                      onChange={(manualAdaptiveHigh) => patchSettings({ manualAdaptiveHigh })}
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm font-bold text-muted">
                    <span>Manual Low</span>
                    <AdaptiveNumberInput
                      value={settings.manualAdaptiveLow ?? null}
                      disabled={settings.adaptiveHighLowMode !== "manual"}
                      invalid={settings.adaptiveHighLowMode === "manual" && !settings.manualAdaptiveLow}
                      onChange={(manualAdaptiveLow) => patchSettings({ manualAdaptiveLow })}
                    />
                  </label>
                </div>
                <div className="mt-2 text-xs font-semibold text-muted">
                  Current preview: High {previewMarket?.adaptiveHigh?.toFixed(2) ?? "-"} / Low {previewMarket?.adaptiveLow?.toFixed(2) ?? "-"}
                </div>
              </ControlGroup>

              <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr]">
                <ControlGroup title="Grid">
                  <GridButtons value={config.gridType} onChange={(value) => patchConfig({ gridType: value as StrategyConfig["gridType"] })} />
                  <div className="mt-3">
                    <label className="text-sm font-bold text-muted">Distance</label>
                    <div className="relative mt-1">
                      <NumericInput value={config.gridDistance} onChange={(value) => patchConfig({ gridDistance: value })} invalid={config.gridDistance <= 0} className="h-10 rounded-lg pr-12" />
                      <span className="pointer-events-none absolute right-3 top-2.5 text-xs font-bold uppercase text-muted">
                        {config.gridType === "percentage" ? "%" : "pt"}
                      </span>
                    </div>
                  </div>
                </ControlGroup>

                <ControlGroup title="Take Profit">
                  <label className="text-sm font-bold text-muted">Per Leg TP</label>
                  <NumericInput value={config.individualTakeProfit} onChange={(value) => patchConfig({ individualTakeProfit: value })} invalid={config.individualTakeProfit <= 0} className="mt-1 h-10 rounded-lg" />
                </ControlGroup>

                <ControlGroup title="Force Exit">
                  <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
                    <button
                      type="button"
                      className={cn("h-10 rounded-lg border text-sm font-bold transition", config.forceExitEnabled ? "border-emerald-600 bg-white text-emerald-700 shadow-sm" : "border-line bg-white text-ink hover:border-slate-400")}
                      onClick={() => patchConfig({ forceExitEnabled: !config.forceExitEnabled })}
                    >
                      {config.forceExitEnabled ? "On" : "Off"}
                    </button>
                    <div className="relative">
                      <Clock3 className="absolute left-3 top-2.5 text-muted" size={18} />
                      <input className={cn(inputClass, "h-10 rounded-lg pl-10")} type="time" value={config.forceExitTime} onChange={(e) => patchConfig({ forceExitTime: e.target.value })} />
                    </div>
                  </div>
                </ControlGroup>
              </div>

              <SectionCard
                title="Leg Setup"
                subtitle={`${activeLegs} enabled of ${config.legs.length} legs`}
                action={
                  <button type="button" className="btn-secondary h-10 w-full sm:w-auto" onClick={addLeg}>
                    <Plus size={16} /> Add Leg
                  </button>
                }
                className="overflow-hidden"
              >
                <div className="max-h-[520px] overflow-auto pr-1 sm:max-h-[360px] sm:pr-2">
                  <div className="grid gap-2 xl:grid-cols-2">
                    {config.legs.map((leg, index) => {
                      const sellSelected = config.direction === "sell";
                      return (
                      <div key={index} className={cn("grid grid-cols-2 items-center gap-2 rounded-lg border px-2.5 py-2 transition sm:grid-cols-[58px_90px_90px_1fr_auto_auto]", leg.enabled ? (sellSelected ? "border-rose-300 bg-white" : "border-emerald-300 bg-white") : "border-line bg-white opacity-75")}>
                        <div className="col-span-2 font-bold sm:col-span-1">Leg {index + 1}</div>
                        <div className="rounded-md border border-line bg-slate-50 px-2 py-1.5 sm:border-0 sm:bg-transparent sm:p-0">
                          <div className="mb-0.5 text-[10px] font-bold uppercase text-muted">Entry</div>
                          <div className="text-sm font-semibold">{formatLegPrice(config, anchorPrice, gridStep, index + 1)}</div>
                        </div>
                        <div className="rounded-md border border-line bg-slate-50 px-2 py-1.5 sm:border-0 sm:bg-transparent sm:p-0">
                          <div className="mb-0.5 text-[10px] font-bold uppercase text-muted">TP</div>
                          <div className={config.direction === "sell" ? "text-sm font-semibold text-rose-700" : "text-sm font-semibold text-emerald-700"}>{formatLegTp(config, anchorPrice, gridStep, index + 1)}</div>
                        </div>
                        <div className="col-span-2 sm:col-span-1">
                          <div className="mb-0.5 text-[10px] font-bold uppercase text-muted">Lot Size</div>
                          <NumericInput value={leg.lotSize} onChange={(value) => updateLeg(index, { lotSize: value })} invalid={leg.lotSize <= 0} className="h-9 rounded-lg" />
                        </div>
                        <button
                          type="button"
                          className={cn("h-9 min-w-20 rounded-lg border px-3 text-sm font-bold transition", leg.enabled ? "border-emerald-600 bg-white text-emerald-700 shadow-sm" : "border-line bg-white text-ink hover:border-slate-400")}
                          onClick={() => updateLeg(index, { enabled: !leg.enabled })}
                        >
                          {leg.enabled ? "Enabled" : "Off"}
                        </button>
                        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-600 hover:text-white" onClick={() => removeLeg(index)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </SectionCard>
            </div>
          )}
        </SectionCard>
      </div>
    </AppShell>
  );
}

function ControlGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-2.5">
      <div className="mb-1.5 text-xs font-bold uppercase text-muted">{title}</div>
      {children}
    </div>
  );
}

function DirectionButtons({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button type="button" className={cn("choice-btn h-10", value === "buy" && "border-emerald-600 text-emerald-700 ring-2 ring-emerald-100 dark-buy-active")} onClick={() => onChange("buy")}>
        {value === "buy" ? <Check size={16} /> : <ArrowUp size={16} />} Buy
      </button>
      <button type="button" className={cn("choice-btn h-10", value === "sell" && "border-rose-600 text-rose-700 ring-2 ring-rose-100 dark-sell-active")} onClick={() => onChange("sell")}>
        {value === "sell" ? <Check size={16} /> : <ArrowDown size={16} />} Sell
      </button>
    </div>
  );
}

function GridButtons({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button type="button" className={cn("choice-btn h-10", value === "points" && "border-ink text-ink ring-2 ring-slate-200 dark-neutral-active")} onClick={() => onChange("points")}>
        {value === "points" ? <Check size={16} /> : <Target size={16} />} Point
      </button>
      <button type="button" className={cn("choice-btn h-10", value === "percentage" && "border-ink text-ink ring-2 ring-slate-200 dark-neutral-active")} onClick={() => onChange("percentage")}>
        {value === "percentage" ? <Check size={16} /> : <Percent size={16} />} Percentage
      </button>
    </div>
  );
}

function formatLegPrice(config: StrategyConfig, anchor: number | undefined, step: number, legNumber: number) {
  if (!anchor || !step) return "-";
  const price = config.direction === "sell" ? anchor + legNumber * step : anchor - legNumber * step;
  return price.toFixed(2);
}

function formatLegTp(config: StrategyConfig, anchor: number | undefined, step: number, legNumber: number) {
  if (!anchor || !step) return "-";
  const entry = config.direction === "sell" ? anchor + legNumber * step : anchor - legNumber * step;
  const tp = config.direction === "sell" ? entry - config.individualTakeProfit : entry + config.individualTakeProfit;
  return tp.toFixed(2);
}

function NumericInput({
  value,
  onChange,
  className,
  invalid
}: {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  invalid?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const lastValue = useRef(value);

  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setText(String(value));
  }, [value]);

  function update(next: string) {
    if (!/^\d*\.?\d*$/.test(next)) return;
    setText(next);
    if (next === "" || next === ".") return;
    const parsed = Number(next);
    if (Number.isFinite(parsed)) {
      lastValue.current = parsed;
      onChange(parsed);
    }
  }

  function normalize() {
    if (text === "" || text === ".") {
      setText(String(value));
      return;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) setText(String(parsed));
  }

  return (
    <input
      className={cn(inputClass, invalid && "border-rose-300 focus:border-rose-500 focus:ring-rose-100", className)}
      inputMode="decimal"
      value={text}
      onBlur={normalize}
      onChange={(event) => update(event.target.value)}
    />
  );
}

function AdaptiveNumberInput({
  value,
  onChange,
  disabled,
  invalid
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const lastValue = useRef(value);

  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setText(value === null ? "" : String(value));
  }, [value]);

  function update(next: string) {
    if (!/^\d*\.?\d*$/.test(next)) return;
    setText(next);
    if (next === "" || next === ".") {
      lastValue.current = null;
      onChange(null);
      return;
    }
    const parsed = Number(next);
    if (Number.isFinite(parsed)) {
      lastValue.current = parsed;
      onChange(parsed);
    }
  }

  function normalize() {
    if (text === ".") {
      setText("");
      onChange(null);
      return;
    }
    const parsed = Number(text);
    if (text !== "" && Number.isFinite(parsed)) setText(String(parsed));
  }

  return (
    <input
      className={cn(inputClass, "h-10 rounded-lg", invalid && "border-rose-300 focus:border-rose-500 focus:ring-rose-100")}
      disabled={disabled}
      inputMode="decimal"
      value={text}
      onBlur={normalize}
      onChange={(event) => update(event.target.value)}
    />
  );
}

function previewAdaptiveMarket(market: { adaptiveHigh: number; adaptiveLow: number }, settings: AppSettings) {
  if (
    settings.adaptiveHighLowMode === "manual" &&
    settings.manualAdaptiveHigh &&
    settings.manualAdaptiveLow &&
    settings.manualAdaptiveHigh > settings.manualAdaptiveLow
  ) {
    return { ...market, adaptiveHigh: settings.manualAdaptiveHigh, adaptiveLow: settings.manualAdaptiveLow };
  }
  return market;
}

function validateStrategyConfig(config: StrategyConfig, settings: AppSettings) {
  const errors: string[] = [];
  if (!config.symbol.trim()) errors.push("Symbol is required.");
  if (config.gridDistance <= 0) errors.push("Grid distance must be greater than 0.");
  if (config.individualTakeProfit <= 0) errors.push("Per leg TP must be greater than 0.");
  if (config.stopLoss <= 0) errors.push("Stop loss price must be greater than 0.");
  if (!config.legs.some((leg) => leg.enabled)) errors.push("At least one leg must be enabled.");
  const invalidLeg = config.legs.findIndex((leg) => leg.lotSize <= 0);
  if (invalidLeg >= 0) errors.push(`Leg ${invalidLeg + 1} lot size must be greater than 0.`);
  if (!/^\d{2}:\d{2}$/.test(config.forceExitTime)) errors.push("Force exit time is invalid.");
  if (settings.adaptiveHighLowMode === "manual") {
    if (!settings.manualAdaptiveHigh) errors.push("Manual adaptive high is required.");
    if (!settings.manualAdaptiveLow) errors.push("Manual adaptive low is required.");
    if (settings.manualAdaptiveHigh && settings.manualAdaptiveLow && settings.manualAdaptiveHigh <= settings.manualAdaptiveLow) {
      errors.push("Manual adaptive high must be greater than manual adaptive low.");
    }
  }
  return errors;
}
