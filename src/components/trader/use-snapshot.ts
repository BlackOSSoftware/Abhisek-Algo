"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Snapshot } from "./types";
import { useSnapshotContext } from "./snapshot-provider";
import { normalizeConfig } from "./snapshot-utils";

export { normalizeConfig };

export function useSnapshot(intervalMs = 2000) {
  const context = useSnapshotContext();
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<{ view: string; promise: Promise<Snapshot> } | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const snapshotHashRef = useRef("");
  const requestSeq = useRef(0);

  const snapshotView = pathname === "/" ? "full" : pathname.startsWith("/settings") ? "settings" : "config";

  const load = useCallback(async () => {
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
    if (context) return;
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, intervalMs);
    return () => clearInterval(id);
  }, [context, intervalMs, load]);

  return context ?? { snapshot, loading, reload: load };
}
