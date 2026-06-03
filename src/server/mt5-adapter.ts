import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AccountSnapshot, MarketState, Side, Tick } from "@/lib/types";

export interface Mt5OrderResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  pending?: boolean;
  brokerOrderId?: string;
  price?: number;
  error?: string;
}

export interface Mt5BrokerPosition {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  volume: number;
  entryPrice: number;
  comment: string;
}

export interface Mt5BrokerPendingOrder {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  volume: number;
  price: number;
  comment: string;
}

export class Mt5Adapter {
  private python = process.env.MT5_PYTHON ?? "python";
  private script = "scripts/mt5_bridge.py";
  private child: ReturnType<typeof spawn> | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  private seq = 0;

  async tick(symbol: string): Promise<Tick> {
    return this.call<Tick>(["tick", symbol]);
  }

  async account(): Promise<AccountSnapshot> {
    return this.call<AccountSnapshot>(["account"]);
  }

  async dayRange(symbol: string): Promise<MarketState> {
    return this.call<MarketState>(["day_range", symbol]);
  }

  async open(symbol: string, side: Side, volume: number, levelIndex: number | undefined, levelPrice: number, stopLoss: number, takeProfitPoints: number): Promise<Mt5OrderResult> {
    const args = ["open", symbol, side, String(volume), String(levelIndex ?? ""), String(levelPrice), String(stopLoss), String(takeProfitPoints)];
    return this.call<Mt5OrderResult>(args);
  }

  async close(symbol: string, side?: Side, volume?: number, levelIndex?: number, levelPrice?: number): Promise<Mt5OrderResult> {
    const args = ["close", symbol];
    if (side) args.push(side);
    if (volume) args.push(String(volume));
    if (levelIndex) args.push(String(levelIndex));
    if (levelPrice) args.push(String(levelPrice));
    return this.call<Mt5OrderResult>(args);
  }

  async clear(symbol: string, clearPendingOrders: boolean, closeLivePositions: boolean): Promise<Mt5OrderResult> {
    return this.call<Mt5OrderResult>(["clear", symbol, String(clearPendingOrders), String(closeLivePositions)]);
  }

  async positions(symbol: string): Promise<Mt5BrokerPosition[]> {
    return this.call<Mt5BrokerPosition[]>(["positions", symbol]);
  }

  async pendingOrders(symbol: string): Promise<Mt5BrokerPendingOrder[]> {
    return this.call<Mt5BrokerPendingOrder[]>(["pending_orders", symbol]);
  }

  private call<T>(args: string[]): Promise<T> {
    const child = this.ensureBridge();
    return new Promise<T>((resolve, reject) => {
      const id = String(++this.seq);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.stdin!.write(`${JSON.stringify({ id, args })}\n`);
    });
  }

  private ensureBridge() {
    if (this.child && !this.child.killed && this.child.stdin) return this.child;
    this.child = spawn(this.python, [this.script, "serve"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw new Error("Could not open MT5 bridge stdio");
    }
    const child = this.child;
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { id: string; ok: boolean; data?: unknown; error?: string };
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error ?? "MT5 bridge error"));
    });
    child.stderr!.on("data", (chunk) => {
      const error = new Error(String(chunk));
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    child.on("close", (code) => {
      const error = new Error(`MT5 bridge closed with code ${code}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
    });
    return child;
  }
}
