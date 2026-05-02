import { z } from "zod";

export const RegimeSchema = z.enum([
  "trending_up",
  "trending_down",
  "ranging",
  "volatile",
]);

export const OpenPositionSchema = z
  .object({
    side: z.enum(["long", "short", "none"]),
    entry_price: z.number(),
    unrealized_pnl_pct: z.number(),
  })
  .strict();

export const Last3TradeSchema = z
  .object({
    action: z.string(),
    pnl_pct: z.number(),
    rationale_summary: z.string(),
  })
  .strict();

export const MarketStatePacketSchema = z
  .object({
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
    equity_high_water: z.number(),
    daily_pnl_pct: z.number(),
    last_3_trades: z.array(Last3TradeSchema),
  })
  .strict();

export type MarketStatePacket = z.infer<typeof MarketStatePacketSchema>;

// Hallucinated extra fields are rejected, not silently dropped — this is the
// last line of defence against a model that returns e.g. "liquidate_all": true.
export const IntentSchema = z
  .object({
    action: z.enum(["BUY", "SELL", "HOLD", "CLOSE"]),
    symbol: z.string(),
    size_pct_of_equity: z.number().min(0).max(100),
    stop_loss_pct: z.number().min(0),
    take_profit_pct: z.number().min(0),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Hand-mirrored JSON Schema for Intent, used by providers that support
 * structured-output enforcement (e.g. `claude -p --json-schema`).
 * Keep in sync with IntentSchema above.
 */
export const INTENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["BUY", "SELL", "HOLD", "CLOSE"] },
    symbol: { type: "string" },
    size_pct_of_equity: { type: "number", minimum: 0, maximum: 100 },
    stop_loss_pct: { type: "number", minimum: 0 },
    take_profit_pct: { type: "number", minimum: 0 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
  required: [
    "action",
    "symbol",
    "size_pct_of_equity",
    "stop_loss_pct",
    "take_profit_pct",
    "confidence",
    "rationale",
  ],
} as const;
