import type { Indicators } from "./indicators.js";
import type { z } from "zod";
import { RegimeSchema } from "../agent/schema.js";

export type Regime = z.infer<typeof RegimeSchema>;

const VOLATILITY_THRESHOLD_PCT = 3;
const TREND_DISTANCE_THRESHOLD_PCT = 1;

export function classifyRegime(ind: Indicators, lastPrice: number): Regime {
  const finite =
    Number.isFinite(ind.atr_14) &&
    Number.isFinite(ind.macd_histogram) &&
    Number.isFinite(ind.ema200_distance_pct) &&
    Number.isFinite(lastPrice) &&
    lastPrice > 0;
  if (!finite) return "ranging";

  const volatilityPct = (ind.atr_14 / lastPrice) * 100;
  if (volatilityPct > VOLATILITY_THRESHOLD_PCT) return "volatile";
  if (
    ind.ema200_distance_pct > TREND_DISTANCE_THRESHOLD_PCT &&
    ind.macd_histogram > 0
  ) {
    return "trending_up";
  }
  if (
    ind.ema200_distance_pct < -TREND_DISTANCE_THRESHOLD_PCT &&
    ind.macd_histogram < 0
  ) {
    return "trending_down";
  }
  return "ranging";
}
