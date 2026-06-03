"use client";

import { Activity, Eye, EyeOff, LockKeyhole, Moon, Sun } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { useTheme } from "./theme-provider";
import { Loader } from "./loader";

type AuthState = "checking" | "authenticated" | "guest";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");
  const [adminId, setAdminId] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ authenticated: boolean }>)
      .then((data) => {
        if (alive) setState(data.authenticated ? "authenticated" : "guest");
      })
      .catch(() => {
        if (alive) setState("guest");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminId.trim() || !password) {
      setError("Admin ID aur password dono required hain.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ adminId: adminId.trim(), password })
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(data.error || "Admin ID ya password galat hai.");
        return;
      }
      setState("authenticated");
    } catch {
      setError("Login request fail ho gayi. Dev server refresh karke try karein.");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "authenticated") return children;

  return (
    <main className={cn("grid min-h-screen place-items-center px-4 py-8 sm:px-8", theme === "dark" ? "bg-black text-slate-50" : "bg-[#eef2f8] text-ink")}>
      <div className="w-full max-w-6xl overflow-hidden rounded-xl border border-line bg-white shadow-panel dark-card">
        <div className="grid md:grid-cols-[1.05fr_1fr]">
          <aside className={cn("relative hidden min-h-[680px] overflow-hidden border-r border-line p-8 text-white md:flex md:flex-col md:justify-between lg:p-10", theme === "dark" ? "bg-zinc-950" : "bg-[#111827]")}>
            <img
              src="https://images.unsplash.com/photo-1579226905180-636b76d96082?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D"
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-[#111827]/80" />
            <div className="relative">
              <div className="inline-flex h-16 w-16 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-cyan-200">
                <Activity size={30} />
              </div>
              <div className="mt-7 text-4xl font-semibold">Grid Trader Pro</div>
              <div className="mt-3 text-base font-semibold text-slate-300">MT5 Gold Algo</div>
            </div>

            <div className="relative rounded-xl border border-white/10 bg-white/10 p-5 backdrop-blur">
              <div className="text-xs font-bold uppercase text-slate-300">Admin Access</div>
              <div className="mt-2 text-lg font-semibold text-white">Protected trading dashboard</div>
            </div>
          </aside>

          <form onSubmit={login} className="p-6 sm:p-8 md:p-10 lg:p-12">
            <div className="mb-9 flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700">
                  <LockKeyhole size={29} />
                </div>
                <div className="min-w-0">
                  <h1 className="text-3xl font-semibold">Admin Login</h1>
                  <p className="mt-2 text-base font-medium text-muted">Grid Trader Pro</p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-bold text-ink transition hover:bg-slate-50"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
                <span className="hidden sm:inline">{theme === "dark" ? "Day" : "Night"}</span>
              </button>
            </div>

            <div className="grid gap-5">
              <label className="grid gap-2 text-base font-bold">
                Admin ID
                <input
                  className="h-14 rounded-xl border border-line bg-white px-4 text-lg font-semibold outline-none transition focus:border-ink focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                  value={adminId}
                  onChange={(event) => setAdminId(event.target.value)}
                  autoComplete="username"
                  disabled={submitting}
                />
              </label>

              <label className="grid gap-2 text-base font-bold">
                Admin Password
                <div className="relative">
                  <input
                    className="h-14 w-full rounded-xl border border-line bg-white px-4 pr-14 text-lg font-semibold outline-none transition focus:border-ink focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-slate-50 hover:text-ink"
                    onClick={() => setShowPassword((value) => !value)}
                    disabled={submitting}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </label>
            </div>

            {error && <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>}

            <button type="submit" className="btn-primary mt-8 h-14 w-full text-base disabled:cursor-not-allowed disabled:opacity-60" disabled={submitting}>
              {submitting ? <Loader /> : <LockKeyhole size={17} />} {submitting ? "Logging in..." : "Login"}
            </button>

            <div className="mt-8 flex items-center justify-between border-t border-line pt-5 text-xs font-bold uppercase text-muted">
              <span>MT5 Admin</span>
              <span>{theme === "dark" ? "Dark" : "Light"}</span>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
