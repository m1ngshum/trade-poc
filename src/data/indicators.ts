import { ATR, EMA, MACD, RSI } from "trading-signals";
import { logger } from "../logger.js";
import type { Candle } from "./market.js";

export interface Indicators {
  rsi_14: number;
  macd_histogram: number;
  ema200_distance_pct: number;
  atr_14: number;
}

export interface Changes {
  change_1h_pct: number;
  change_4h_pct: number;
  change_24h_pct: number;
}

export function timeframeMinutes(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) throw new Error(`unsupported timeframe: ${tf}`);
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "m") return n;
  if (unit === "h") return n * 60;
  return n * 1440;
}

function safeResult<T>(fn: () => T, fallback: T, label: string): T {
  try {
    return fn();
  } catch (e) {
    logger.debug(`${label} not warm yet: ${(e as Error).message}`);
    return fallback;
  }
}

export function computeIndicators(candles: Candle[]): Indicators {
  const clean = candles.filter(
    (c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close),
  );
  if (clean.length === 0) {
    return { rsi_14: 0, macd_histogram: 0, ema200_distance_pct: 0, atr_14: 0 };
  }

  const rsi = new RSI(14);
  const ema200 = new EMA(200);
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
  const atr = new ATR(14);

  for (const c of clean) {
    rsi.add(c.close);
    ema200.add(c.close);
    macd.add(c.close);
    atr.add({ high: c.high, low: c.low, close: c.close });
  }

  const last = clean[clean.length - 1]!;
  const ema200Val = safeResult(() => ema200.getResultOrThrow(), 0, "EMA200");
  const ema200_distance_pct =
    ema200Val > 0 ? ((last.close - ema200Val) / ema200Val) * 100 : 0;

  return {
    rsi_14: safeResult(() => rsi.getResultOrThrow(), 50, "RSI"),
    macd_histogram: safeResult(() => macd.getResultOrThrow().histogram, 0, "MACD"),
    ema200_distance_pct,
    atr_14: safeResult(() => atr.getResultOrThrow(), 0, "ATR"),
  };
}

function pctChangeNBack(closes: number[], n: number): number {
  if (n <= 0 || closes.length <= n) return 0;
  const last = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - n]!;
  if (!(past > 0) || !Number.isFinite(last)) return 0;
  return ((last - past) / past) * 100;
}

export function computeChanges(candles: Candle[], tfMinutes: number): Changes {
  const closes = candles.map((c) => c.close);
  const bars1h = Math.max(1, Math.round(60 / tfMinutes));
  const bars4h = Math.max(1, Math.round(240 / tfMinutes));
  const bars24h = Math.max(1, Math.round(1440 / tfMinutes));
  return {
    change_1h_pct: pctChangeNBack(closes, bars1h),
    change_4h_pct: pctChangeNBack(closes, bars4h),
    change_24h_pct: pctChangeNBack(closes, bars24h),
  };
}
