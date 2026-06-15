export type DirectionMode = "buy" | "sell" | "both";
export type GridType = "points" | "percentage";
export type LotMode = "fixed" | "incremental" | "multiplier" | "risk";
export type ForceExitType = "auto" | "manual" | "hybrid";
export type Side = "BUY" | "SELL";
export type OrderStatus = "OPEN" | "PENDING" | "CLOSED" | "REJECTED";
export type IntentAction = "OPEN" | "CLOSE" | "CLOSE_ALL" | "DISABLE_DAY";

export interface StrategyConfig {
  symbol: string;
  direction: DirectionMode;
  gridType: GridType;
  gridDistance: number;
  maxLegs: number;
  legs: Array<{
    enabled: boolean;
    lotSize: number;
  }>;
  lotMode: LotMode;
  lotSize: number;
  multiplier: number;
  riskPercent: number;
  individualTakeProfit: number;
  basketTakeProfit: number;
  trailingBasketTakeProfit: number;
  stopLoss: number;
  basketStopLoss: number;
  dailyDrawdown: number;
  maxExposure: number;
  maxLots: number;
  tradingStartTime: string;
  tradingEndTime: string;
  forceExitTime: string;
  forceExitEnabled: boolean;
  forceExitType: ForceExitType;
  entryCutoffTime: string;
  enableReEntry: boolean;
  enableNewsFilter: boolean;
  enableFridayExit: boolean;
  enableSpreadFilter: boolean;
  maxSpread: number;
  enableCooldown: boolean;
  cooldownMinutes: number;
  resetOnNewHighLow: boolean;
  maxReEntriesPerLevel: number;
  newHighLowMode: "reset" | "continue";
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  time: string;
}

export interface MarketState {
  adaptiveHigh: number;
  adaptiveLow: number;
  dayOpen?: number;
  day: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  levelIndex: number;
  levelPrice: number;
  entryPrice: number;
  volume: number;
  status: OrderStatus;
  openedAt: string;
  closedAt?: string;
  closePrice?: number;
  brokerOrderId?: string;
  pnl?: number;
  reEntryCount: number;
}

export interface BrokerPosition {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  volume: number;
  entryPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  profit?: number;
  swap?: number;
  comment: string;
  openedAt?: string;
}

export interface BrokerPendingOrder {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  volume: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  orderType?: string;
  comment: string;
  placedAt?: string;
}

export interface BrokerSnapshot {
  positions: BrokerPosition[];
  pendingOrders: BrokerPendingOrder[];
  error?: string;
  updatedAt: string;
}

export interface TradeIntent {
  idempotencyKey: string;
  symbol: string;
  action: IntentAction;
  side?: Side;
  levelIndex?: number;
  levelPrice?: number;
  volume?: number;
  reEntryCount?: number;
  reason: string;
}

export interface TradeIntentRecord extends TradeIntent {
  status: "PENDING" | "DONE" | "FAILED";
  brokerOrderId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface EntryStartGate {
  day: string;
  symbol: string;
  buyAnchor?: number;
  sellAnchor?: number;
  lockedLevels: Array<{
    side: Side;
    levelIndex: number;
  }>;
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  floatingPnl: number;
  dailyRealizedPnl: number;
}

export interface AppSettings {
  tickExecutionEnabled: boolean;
  disableClearPendingOrders: boolean;
  disableCloseLivePositions: boolean;
  directionSwitchClearPendingOrders: boolean;
  directionSwitchCloseLivePositions: boolean;
}

export interface DashboardSnapshot {
  config: StrategyConfig;
  market: MarketState | null;
  tick: Tick | null;
  positions: Position[];
  account: AccountSnapshot;
  entryGate?: EntryStartGate | null;
  settings: AppSettings;
  brokerPositions: BrokerPosition[];
  brokerPendingOrders: BrokerPendingOrder[];
  brokerError?: string;
  brokerUpdatedAt?: string;
  events: Array<{ id: number; type: string; payload: string; created_at: string }>;
  recentIntents: TradeIntentRecord[];
  status: {
    enabled: boolean;
    connected: boolean;
    canEnter: boolean;
    forceExitCountdownSeconds: number;
    message: string;
  };
}
