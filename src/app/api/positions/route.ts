import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminAuthenticated } from "@/lib/auth";
import type { BrokerPendingOrder, BrokerPosition } from "@/lib/types";
import { store } from "@/server/db";
import { Mt5Adapter } from "@/server/mt5-adapter";

export const dynamic = "force-dynamic";

const adapter = new Mt5Adapter();

export async function GET(request: Request) {
  if (!isAdminAuthenticated(request)) return adminUnauthorized();
  const config = store.getConfig();
  let brokerPositions: BrokerPosition[] = [];
  let brokerPendingOrders: BrokerPendingOrder[] = [];
  let brokerError: string | undefined;
  try {
    [brokerPositions, brokerPendingOrders] = await Promise.all([
      adapter.positions(config.symbol),
      adapter.pendingOrders(config.symbol)
    ]);
  } catch (error) {
    brokerError = error instanceof Error ? error.message : String(error);
  }
  const localPositions = store.listPositions(undefined, 160);
  return NextResponse.json({
    ok: true,
    positions: localPositions,
    localPositions,
    brokerPositions,
    brokerPendingOrders,
    brokerError
  });
}
