import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { settingsSchema } from "@/lib/validators";
import { store } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  return NextResponse.json({ ok: true, settings: store.getSettings() });
}

export async function PUT(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const body = await request.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const previous = store.getSettings();
  store.setSettings(parsed.data);
  if (
    previous.adaptiveHighLowMode !== parsed.data.adaptiveHighLowMode ||
    previous.manualAdaptiveHigh !== parsed.data.manualAdaptiveHigh ||
    previous.manualAdaptiveLow !== parsed.data.manualAdaptiveLow
  ) {
    store.setEntryGate(null);
  }
  return NextResponse.json({ ok: true, settings: parsed.data });
}
