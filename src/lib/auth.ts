import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const ADMIN_AUTH_COOKIE = "trader_admin_session";

function adminId() {
  return process.env.ADMIN_ID || "admin";
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || "admin";
}

function sessionToken() {
  return createHash("sha256").update(`${adminId()}:${adminPassword()}:grid-trader-admin`).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateAdminLogin(id: string, password: string) {
  return safeEqual(id, adminId()) && safeEqual(password, adminPassword());
}

export function isAdminAuthenticated(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${ADMIN_AUTH_COOKIE}=([^;]+)`));
  return Boolean(match?.[1] && safeEqual(decodeURIComponent(match[1]), sessionToken()));
}

export function adminUnauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export function setAdminCookie(response: NextResponse) {
  response.cookies.set(ADMIN_AUTH_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12
  });
}

export function clearAdminCookie(response: NextResponse) {
  response.cookies.set(ADMIN_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}
