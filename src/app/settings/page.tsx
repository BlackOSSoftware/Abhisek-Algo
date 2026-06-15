"use client";

import { Save, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/trader/app-shell";
import { SectionCard } from "@/components/trader/cards";
import { cn } from "@/components/ui";
import { useSnapshot } from "@/components/trader/use-snapshot";
import type { AppSettings } from "@/lib/types";

export default function SettingsPage() {
  const { snapshot, reload } = useSnapshot();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (snapshot?.settings && !dirty) setSettings(snapshot.settings);
  }, [snapshot?.settings]);

  function update(patch: Partial<AppSettings>) {
    if (!value) return;
    setSettings({ ...value, ...patch });
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    if (!value || !dirty) return;
    setSaving(true);
    setSaved(false);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value)
    });
    setSaving(false);
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
    await reload();
  }

  const value = settings ?? snapshot?.settings;

  return (
    <AppShell snapshot={snapshot} onRefresh={reload}>
      <div className="grid gap-4">
        <SectionCard title="Settings" subtitle="Control how strategy changes are applied to MT5 orders.">
          <div className="grid gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700">
                <SettingsIcon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-ink">MT5 Order Sync</div>
                <div className="text-xs font-semibold text-muted">Choose whether saved strategy changes should update live and pending MT5 orders.</div>
              </div>
              <button
                type="button"
                className={cn(
                  "flex h-9 min-w-20 items-center justify-center rounded-lg border px-3 text-xs font-bold transition",
                  dirty ? "border-ink bg-white text-ink hover:bg-slate-100" : saved ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-line bg-slate-50 text-muted"
                )}
                onClick={save}
                disabled={!dirty || saving}
              >
                <Save size={14} className="mr-1" />
                {saving ? "Saving" : saved ? "Saved" : dirty ? "Save" : "Ready"}
              </button>
            </div>

            <SettingCheck
              checked={Boolean(value?.tickExecutionEnabled)}
              label="Auto-sync strategy to MT5"
              text="When ON, saved strategy changes update MT5 pending orders and open position SL/TP. When OFF, settings change only on the dashboard."
              onChange={(checked) => update({ tickExecutionEnabled: checked })}
            />
            <div className="mt-2 rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs font-bold uppercase text-muted">Disable Action</div>
            <SettingCheck
              checked={Boolean(value?.disableClearPendingOrders)}
              label="Clear pending orders"
              text="Cancel MT5 buy limit / sell limit orders."
              onChange={(checked) => update({ disableClearPendingOrders: checked })}
            />
            <SettingCheck
              checked={Boolean(value?.disableCloseLivePositions)}
              label="Clear live orders"
              text="Close open MT5 positions."
              onChange={(checked) => update({ disableCloseLivePositions: checked })}
            />
            <div className="mt-2 rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs font-bold uppercase text-muted">Direction Switch</div>
            <SettingCheck
              checked={Boolean(value?.directionSwitchClearPendingOrders)}
              label="Clear pending orders on BUY/SELL switch"
              text="Cancel pending orders before switching chart direction."
              onChange={(checked) => update({ directionSwitchClearPendingOrders: checked })}
            />
            <SettingCheck
              checked={Boolean(value?.directionSwitchCloseLivePositions)}
              label="Clear live orders on BUY/SELL switch"
              text="Close open positions before switching chart direction."
              onChange={(checked) => update({ directionSwitchCloseLivePositions: checked })}
            />
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}

function SettingCheck({ checked, label, text, onChange }: { checked: boolean; label: string; text: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-white p-4 transition hover:bg-slate-50">
      <input className="h-5 w-5 accent-emerald-600" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-ink">{label}</span>
        <span className="block text-xs font-semibold text-muted">{text}</span>
      </span>
    </label>
  );
}
