import { ATR, EMA, MACD, RSI } from "trading-signals";
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
  const m = /^(\d+)([mhd])$/.exec(tf.trim().toLowerCase());
  if (!m) throw new Error(`invalid timeframe: ${tf}`);
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "m") return n;
  if (unit === "h") return n * 60;
  return n * 60 * 24;
}

function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function computeChanges(candles: Candle[], tfMinutes: number): Changes {
  if (candles.length === 0) {
    return { change_1h_pct: 0, change_4h_pct: 0, change_24h_pct: 0 };
  }
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) {
    return { change_1h_pct: 0, change_4h_pct: 0, change_24h_pct: 0 };
  }
  const last = lastCandle.close;
  const firstClose = candles[0]?.close ?? last;
  const lookbackFor = (minutes: number): number => {
    const n = Math.max(1, Math.round(minutes / tfMinutes));
    const idx = candles.length - 1 - n;
    return idx >= 0 ? (candles[idx]?.close ?? firstClose) : firstClose;
  };
  return {
    change_1h_pct: pctChange(lookbackFor(60), last),
    change_4h_pct: pctChange(lookbackFor(240), last),
    change_24h_pct: pctChange(lookbackFor(60 * 24), last),
  };
}

export function computeIndicators(candles: Candle[]): Indicators {
  if (candles.length < 20) {
    // Not enough history — return safe zeros rather than crash.
    const last = candles.at(-1)?.close ?? 0;
    return {
      rsi_14: 50,
      macd_histogram: 0,
      ema200_distance_pct: 0,
      atr_14: last * 0.01,
    };
  }

  const rsi = new RSI(14);
  const ema200 = new EMA(200);
  const atr = new ATR(14);
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));

  let rsiVal: number | null = null;
  let emaVal: number | null = null;
  let atrVal: number | null = null;
  let macdHist = 0;

  for (const c of candles) {
    try { rsiVal = rsi.update(c.close, false) ?? rsiVal; } catch { /* warmup */ }
    try { emaVal = ema200.update(c.close, false) ?? emaVal; } catch { /* warmup */ }
    try { atrVal = atr.update({ high: c.high, low: c.low, close: c.close }, false) ?? atrVal; } catch { /* warmup */ }
    try {
      const r = macd.update(c.close, false);
      if (r) macdHist = r.histogram;
    } catch { /* warmup */ }
  }

  const lastCandle = candles[candles.length - 1];
  const last = lastCandle ? lastCandle.close : 0;
  const ema200Distance = emaVal !== null && emaVal !== 0
    ? ((last - emaVal) / emaVal) * 100
    : 0;

  return {
    rsi_14: Number(rsiVal ?? 50),
    macd_histogram: Number(macdHist),
    ema200_distance_pct: Number(ema200Distance),
    atr_14: Number(atrVal ?? last * 0.01),
  };
}
