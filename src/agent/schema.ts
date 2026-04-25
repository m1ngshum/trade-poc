import { z } from "zod";

export const RegimeSchema = z.enum([
  "trending_up",
  "trending_down",
  "ranging",
  "volatile",
]);

export const OpenPositionSchema = z.object({
  side: z.enum(["long", "short", "none"]),
  entry_price: z.number(),
  unrealized_pnl_pct: z.number(),
});

export const Last3TradeSchema = z.object({
  action: z.string(),
  pnl_pct: z.number(),
  rationale_summary: z.string(),
});

export const MarketStatePacketSchema = z.object({
  symbol: z.string(),
  timestamp: z.string(),
  price: z.number(),
  change_1h_pct: z.number(),
  change_4h_pct: z.number(),
  change_24h_pct: z.number(),
  rsi_14: z.number(),
  macd_histogram: z.number(),
  ema200_distance_pct: z.number(),
  atr_14: z.number(),
  volume_24h_usd: z.number(),
  regime: RegimeSchema,
  open_position: OpenPositionSchema,
  equity_usd: z.number(),
  daily_pnl_pct: z.number(),
  last_3_trades: z.array(Last3TradeSchema),
});

export type MarketStatePacket = z.infer<typeof MarketStatePacketSchema>;

export const IntentSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD", "CLOSE"]),
  symbol: z.string(),
  size_pct_of_equity: z.number().min(0).max(100),
  stop_loss_pct: z.number().min(0),
  take_profit_pct: z.number().min(0),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export type Intent = z.infer<typeof IntentSchema>;
