"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Snapshot } from "./types";
import { normalizeConfig } from "./snapshot-utils";

type SnapshotContextValue = {
  snapshot: Snapshot | null;
  loading: boolean;
  reload: () => Promise<Snapshot>;
};

const SnapshotContext = createContext<SnapshotContextValue | null>(null);

export function SnapshotProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<{ view: string; promise: Promise<Snapshot> } | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const snapshotHashRef = useRef("");
  const requestSeq = useRef(0);

  const snapshotView = pathname === "/" ? "full" : pathname.startsWith("/settings") ? "settings" : "config";

  const reload = useCallback(async () => {
    if (inFlight.current?.view === snapshotView) return inFlight.current.promise;
    const requestId = ++requestSeq.current;
    const promise = (async () => {
      const res = await fetch(`/api/snapshot?view=${snapshotView}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Snapshot request failed");
      const data = (await res.json()) as Snapshot;
      data.config = normalizeConfig(data.config);
      const nextHash = JSON.stringify(data);
      if (requestId === requestSeq.current && nextHash !== snapshotHashRef.current) {
        snapshotHashRef.current = nextHash;
        snapshotRef.current = data;
        startTransition(() => setSnapshot(data));
      }
      return data;
    })();
    inFlight.current = { view: snapshotView, promise };
    try {
      return await promise;
    } catch (error) {
      console.error(error);
      return snapshotRef.current as Snapshot;
    } finally {
      setLoading(false);
      if (inFlight.current?.promise === promise) inFlight.current = null;
    }
  }, [snapshotView]);

  useEffect(() => {
    reload();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 2000);
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const value = useMemo(() => ({ snapshot, loading, reload }), [snapshot, loading, reload]);

  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

export function useSnapshotContext() {
  return useContext(SnapshotContext);
}
