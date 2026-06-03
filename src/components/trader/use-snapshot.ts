"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types";
import { useSnapshotContext } from "./snapshot-provider";
import { normalizeConfig } from "./snapshot-utils";

export { normalizeConfig };

export function useSnapshot(intervalMs = 2000) {
  const context = useSnapshotContext();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<Promise<Snapshot> | null>(null);

  const load = useCallback(async () => {
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
    if (context) return;
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, intervalMs);
    return () => clearInterval(id);
  }, [context, intervalMs, load]);

  return context ?? { snapshot, loading, reload: load };
}
