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

function shouldUseSecureCookie(request: Request) {
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  return forwardedProtocol === "https" || new URL(request.url).protocol === "https:";
}

export function setAdminCookie(response: NextResponse, request: Request) {
  response.cookies.set(ADMIN_AUTH_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: 60 * 60 * 12
  });
}

export function clearAdminCookie(response: NextResponse, request: Request) {
  response.cookies.set(ADMIN_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: 0
  });
}
