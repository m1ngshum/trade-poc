import type { Indicators } from "./indicators.js";
import type { MarketStatePacket } from "../agent/schema.js";

type Regime = MarketStatePacket["regime"];

/**
 * Map indicators + price into one of four discrete market regimes.
 *
 * Heuristic — not academic, but enough to give the LLM a useful prior:
 *   - volatile: ATR > 3% of price (high noise dominates direction)
 *   - trending_up: price clearly above EMA200 AND MACD histogram positive
 *   - trending_down: price clearly below EMA200 AND MACD histogram negative
 *   - ranging: everything else
 */
export function classifyRegime(ind: Indicators, price: number): Regime {
  const atrPct = price > 0 ? (ind.atr_14 / price) * 100 : 0;
  if (atrPct > 3) return "volatile";

  const aboveEma = ind.ema200_distance_pct > 1;
  const belowEma = ind.ema200_distance_pct < -1;

  if (aboveEma && ind.macd_histogram > 0) return "trending_up";
  if (belowEma && ind.macd_histogram < 0) return "trending_down";
  return "ranging";
}
