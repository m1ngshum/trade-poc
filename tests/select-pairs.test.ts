import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeATR,
  computeTrendPersistence,
  computeMeanReversion,
  computeMaxDrawdown,
  scoreCandidate,
  type Metrics,
} from "../src/scripts/select-pairs.js";

// Synthetic candle: [openTime, open, high, low, close, volume]
function candle(close: number, high?: number, low?: number): unknown[] {
  const h = high ?? close * 1.005;
  const l = low  ?? close * 0.995;
  return [0, String(close), String(h), String(l), String(close), "1000"];
}

function btcLike(overrides: Partial<Metrics> = {}): Metrics {
  return {
    symbol: "BTC/USDT",
    binanceSymbol: "BTCUSDT",
    atr_15m_pct_avg30d: 0.48,
    trend_persistence_pct: 36,
    mean_reversion_score: -0.03,
    vol24h_usd: 14e9,
    spread_bps_median: 0.4,
    max_dd_90d_pct: 22,
    ...overrides,
  };
}

// ── computeATR ────────────────────────────────────────────────────────────────
test("computeATR: empty input returns 0", () => {
  assert.equal(computeATR([]), 0);
});

test("computeATR: computes (high-low)/close*100 average", () => {
  // high=102, low=98, close=100 → 4%
  const c = [0, "100", "102", "98", "100", "1000"];
  assert.ok(Math.abs(computeATR([c, c]) - 4) < 0.001);
});

// ── computeTrendPersistence ───────────────────────────────────────────────────
test("computeTrendPersistence: <5 candles returns 0", () => {
  assert.equal(computeTrendPersistence([candle(100), candle(101), candle(102)]), 0);
});

test("computeTrendPersistence: strong uptrend scores >50%", () => {
  const candles = [100,101,102,103,104,105,106,107,108,109].map(p => candle(p));
  assert.ok(computeTrendPersistence(candles) > 50);
});

test("computeTrendPersistence: alternating prices scores <10%", () => {
  const candles = [100,101,100,101,100,101,100,101,100,101].map(p => candle(p));
  assert.ok(computeTrendPersistence(candles) < 10);
});

// ── computeMeanReversion ──────────────────────────────────────────────────────
test("computeMeanReversion: <12 candles returns 0", () => {
  assert.equal(computeMeanReversion([candle(100), candle(101)]), 0);
});

test("computeMeanReversion: alternating series gives negative autocorr", () => {
  const candles = Array.from({ length: 50 }, (_, i) => candle(100 + (i % 2 === 0 ? 1 : -1)));
  assert.ok(computeMeanReversion(candles) < -0.5);
});

// ── computeMaxDrawdown ────────────────────────────────────────────────────────
test("computeMaxDrawdown: empty input returns 0", () => {
  assert.equal(computeMaxDrawdown([]), 0);
});

test("computeMaxDrawdown: peak 200 → trough 100 = 50% drawdown", () => {
  const candles = [100,150,200,180,150,100].map(p => candle(p));
  assert.ok(Math.abs(computeMaxDrawdown(candles) - 50) < 0.01);
});

// ── scoreCandidate (smoke: BTC-like metrics) ──────────────────────────────────
test("BTC-like metrics: not rejected and score >0.5", () => {
  const r = scoreCandidate(btcLike());
  assert.equal(r.reject_reason, undefined, `unexpected rejection: ${r.reject_reason}`);
  assert.ok(r.score > 0.5, `score too low: ${r.score}`);
});

test("recommended array has length >= 1 when BTC+ETH-like metrics are scored", () => {
  const results = [
    scoreCandidate(btcLike()),
    scoreCandidate(btcLike({ symbol: "ETH/USDT", vol24h_usd: 8e9, atr_15m_pct_avg30d: 0.55 })),
  ].filter(r => !r.reject_reason);
  assert.ok(results.length >= 1);
});

test("scoreCandidate: ATR below cost floor is auto-rejected", () => {
  const r = scoreCandidate(btcLike({ atr_15m_pct_avg30d: 0.10 }));
  assert.ok(r.reject_reason?.includes("cost floor"));
  assert.equal(r.score, 0);
});

test("scoreCandidate: ATR above stop-noise ceiling is auto-rejected", () => {
  const r = scoreCandidate(btcLike({ atr_15m_pct_avg30d: 2.5 }));
  assert.ok(r.reject_reason?.includes("stop-noise ceiling"));
  assert.equal(r.score, 0);
});

test("scoreCandidate: mean-reversion penalty multiplies score by 0.70", () => {
  const base = scoreCandidate(btcLike({ mean_reversion_score: 0 }));
  const penalised = scoreCandidate(btcLike({ mean_reversion_score: -0.30 }));
  assert.ok(penalised.score < base.score);
  assert.ok(Math.abs(penalised.score / base.score - 0.70) < 0.01);
});

test("scoreCandidate: vol_fit_score peaks at ATR=0.60%", () => {
  const opts = { trend_persistence_pct: 0, max_dd_90d_pct: 0, mean_reversion_score: 0 };
  const atPeak  = scoreCandidate(btcLike({ ...opts, atr_15m_pct_avg30d: 0.60 }));
  const offPeak = scoreCandidate(btcLike({ ...opts, atr_15m_pct_avg30d: 1.40 }));
  assert.ok(atPeak.score > offPeak.score);
});
