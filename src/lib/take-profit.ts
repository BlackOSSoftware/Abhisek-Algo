import type { StrategyConfig } from "./types";

type TakeProfitConfig = Pick<StrategyConfig, "individualTakeProfit" | "takeProfitType">;

export function takeProfitDistance(config: TakeProfitConfig, entryPrice: number): number {
  return config.takeProfitType === "percentage"
    ? entryPrice * config.individualTakeProfit / 100
    : config.individualTakeProfit;
}

// Preserve the unit across the bridge so market orders use the current deal price.
export function brokerTakeProfit(config: TakeProfitConfig): number | string {
  return config.takeProfitType === "percentage" ? `${config.individualTakeProfit}%` : config.individualTakeProfit;
}
