"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "./types";
import { normalizeConfig } from "./snapshot-utils";

type SnapshotContextValue = {
  snapshot: Snapshot | null;
  loading: boolean;
  reload: () => Promise<Snapshot>;
};

const SnapshotContext = createContext<SnapshotContextValue | null>(null);

export function SnapshotProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<Promise<Snapshot> | null>(null);

  const reload = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = (await res.json()) as Snapshot;
      data.config = normalizeConfig(data.config);
      setSnapshot(data);
      setLoading(false);
      return data;
    })();
    try {
      return await inFlight.current;
    } finally {
      inFlight.current = null;
    }
  }, []);

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
