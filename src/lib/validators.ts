import { z } from "zod";

export const configSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["buy", "sell", "both"]),
  gridType: z.enum(["points", "percentage"]),
  gridDistance: z.coerce.number().positive(),
  maxLegs: z.coerce.number().int().min(1).max(200),
  legs: z
    .array(
      z.object({
        enabled: z.coerce.boolean(),
        lotSize: z.coerce.number().positive()
      })
    )
    .min(1)
    .max(200),
  lotMode: z.enum(["fixed", "incremental", "multiplier", "risk"]),
  lotSize: z.coerce.number().positive(),
  multiplier: z.coerce.number().min(1),
  riskPercent: z.coerce.number().min(0).max(100),
  individualTakeProfit: z.coerce.number().positive(),
  basketTakeProfit: z.coerce.number().min(0),
  trailingBasketTakeProfit: z.coerce.number().min(0),
  stopLoss: z.coerce.number().positive(),
  basketStopLoss: z.coerce.number().min(0),
  dailyDrawdown: z.coerce.number().min(0).max(100),
  maxExposure: z.coerce.number().positive(),
  maxLots: z.coerce.number().positive(),
  tradingStartTime: z.string().regex(/^\d{2}:\d{2}$/),
  tradingEndTime: z.string().regex(/^\d{2}:\d{2}$/),
  forceExitTime: z.string().regex(/^\d{2}:\d{2}$/),
  forceExitEnabled: z.coerce.boolean(),
  forceExitType: z.enum(["auto", "manual", "hybrid"]),
  entryCutoffTime: z.string().regex(/^\d{2}:\d{2}$/),
  enableReEntry: z.coerce.boolean(),
  enableNewsFilter: z.coerce.boolean(),
  enableFridayExit: z.coerce.boolean(),
  enableSpreadFilter: z.coerce.boolean(),
  maxSpread: z.coerce.number().min(0),
  enableCooldown: z.coerce.boolean(),
  cooldownMinutes: z.coerce.number().min(0),
  resetOnNewHighLow: z.coerce.boolean(),
  maxReEntriesPerLevel: z.coerce.number().int().min(0),
  newHighLowMode: z.enum(["reset", "continue"])
});

export const settingsSchema = z.object({
  disableClearPendingOrders: z.coerce.boolean(),
  disableCloseLivePositions: z.coerce.boolean(),
  directionSwitchClearPendingOrders: z.coerce.boolean(),
  directionSwitchCloseLivePositions: z.coerce.boolean()
});
