import { NextResponse } from "next/server";
import { setAdminCookie, validateAdminLogin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as { adminId?: string; password?: string };
  if (!validateAdminLogin(body.adminId || "", body.password || "")) {
    return NextResponse.json({ ok: false, error: "Invalid admin ID or password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  setAdminCookie(response);
  return response;
}
