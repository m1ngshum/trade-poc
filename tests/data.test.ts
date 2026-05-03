import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeChanges,
  computeIndicators,
  timeframeMinutes,
} from "../src/data/indicators.js";
import { classifyRegime } from "../src/data/regime.js";
import type { Candle } from "../src/data/market.js";

test("timeframeMinutes parses minutes/hours/days", () => {
  assert.equal(timeframeMinutes("1m"), 1);
  assert.equal(timeframeMinutes("5m"), 5);
  assert.equal(timeframeMinutes("15m"), 15);
  assert.equal(timeframeMinutes("1h"), 60);
  assert.equal(timeframeMinutes("4h"), 240);
  assert.equal(timeframeMinutes("1d"), 1440);
});

test("timeframeMinutes throws on garbage", () => {
  assert.throws(() => timeframeMinutes("foo"));
  assert.throws(() => timeframeMinutes("15"));
});

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1000,
  }));
}

test("computeChanges returns 1h pct change from N bars back", () => {
  // 20 candles of 100..119 at 15m timeframe → bars1h=4 → last=119, past=115.
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const ch = computeChanges(makeCandles(closes), 15);
  assert.ok(Math.abs(ch.change_1h_pct - ((119 - 115) / 115) * 100) < 1e-9);
});

test("computeChanges returns 0 when not enough candles", () => {
  const ch = computeChanges(makeCandles([100, 101]), 15);
  assert.equal(ch.change_4h_pct, 0);
  assert.equal(ch.change_24h_pct, 0);
});

test("classifyRegime: volatile when atr/price > 3%", () => {
  assert.equal(
    classifyRegime(
      { rsi_14: 50, macd_histogram: 0, ema200_distance_pct: 0, atr_14: 5 },
      100,
    ),
    "volatile",
  );
});

test("classifyRegime: trending_up when above EMA200 with positive MACD", () => {
  assert.equal(
    classifyRegime(
      { rsi_14: 60, macd_histogram: 0.5, ema200_distance_pct: 5, atr_14: 1 },
      100,
    ),
    "trending_up",
  );
});

test("classifyRegime: trending_down when below EMA200 with negative MACD", () => {
  assert.equal(
    classifyRegime(
      { rsi_14: 40, macd_histogram: -0.5, ema200_distance_pct: -5, atr_14: 1 },
      100,
    ),
    "trending_down",
  );
});

test("classifyRegime: ranging in the neutral zone", () => {
  assert.equal(
    classifyRegime(
      { rsi_14: 50, macd_histogram: 0.1, ema200_distance_pct: 0.5, atr_14: 1 },
      100,
    ),
    "ranging",
  );
});

test("classifyRegime: ranging on non-finite inputs", () => {
  assert.equal(
    classifyRegime(
      { rsi_14: 50, macd_histogram: NaN, ema200_distance_pct: 0, atr_14: 1 },
      100,
    ),
    "ranging",
  );
});

test("computeIndicators returns finite values once warm", () => {
  // 250 candles with a slow uptrend so EMA200 stabilizes.
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.1);
  const ind = computeIndicators(makeCandles(closes));
  assert.ok(Number.isFinite(ind.rsi_14));
  assert.ok(Number.isFinite(ind.macd_histogram));
  assert.ok(Number.isFinite(ind.ema200_distance_pct));
  assert.ok(Number.isFinite(ind.atr_14));
});

test("computeIndicators returns safe defaults on empty input", () => {
  const ind = computeIndicators([]);
  assert.deepEqual(ind, {
    rsi_14: 0,
    macd_histogram: 0,
    ema200_distance_pct: 0,
    atr_14: 0,
  });
});
