import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import { store } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const counts = store.cleanRuntimeState();
  return NextResponse.json({ ok: true, counts });
}
