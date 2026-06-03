import { defaultConfig } from "@/lib/default-config";
import type { StrategyConfig } from "@/lib/types";

export function normalizeConfig(config: StrategyConfig): StrategyConfig {
  const legs = config.legs?.length ? config.legs : defaultConfig.legs;
  return {
    ...defaultConfig,
    ...config,
    direction: config.direction === "sell" ? "sell" : "buy",
    maxLegs: legs.length,
    legs
  };
}
