import { test } from "node:test";
import assert from "node:assert/strict";

import { PaperExchange, TAKER_FEE } from "../src/exchange/paper.js";
import type { Intent } from "../src/agent/schema.js";

function buy(overrides: Partial<Intent> = {}): Intent {
  return {
    action: "BUY",
    symbol: "BTC/USDT",
    size_pct_of_equity: 20,
    stop_loss_pct: 1,
    take_profit_pct: 2,
    confidence: 0.9,
    rationale: "test",
    ...overrides,
  };
}

function close(): Intent {
  return {
    action: "CLOSE",
    symbol: "BTC/USDT",
    size_pct_of_equity: 0,
    stop_loss_pct: 0.5,
    take_profit_pct: 0.5,
    confidence: 0.9,
    rationale: "test",
  };
}

test("flat round-trip: equity falls by exactly 2 * (sizeUsd * fee)", () => {
  const ex = new PaperExchange(10_000);
  const open = ex.fill(buy(), 100, "open-1");
  // 20% of $10k = $2000 notional. Open fee = 2000 * 0.001 = $2.
  assert.equal(open.position?.sizeUsd, 2000);
  assert.equal(open.feePaidUsd, 2);
  assert.equal(ex.getEquity(), 10_000 - 2);

  // Exit at the same price → gross PnL=0; closing fee = $2 again.
  const closed = ex.fill(close(), 100, "close-1");
  assert.equal(closed.trade?.pnlUsd, -2);
  // Total equity drop is 2 + 2 = $4 (open fee + close fee).
  assert.ok(Math.abs(ex.getEquity() - 9996) < 1e-9);
});

test("5% favourable move on 20% notional → expected net PnL", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy(), 100, "open-1");
  // Move 5% up — exit at 105.
  const closed = ex.fill(close(), 105, "close-1");
  // gross = 0.05 * 2000 = 100; close fee = 2; net = 98.
  assert.ok(Math.abs((closed.trade?.pnlUsd ?? 0) - 98) < 1e-9);
  // Equity = 10000 - 2 (open fee) + 98 (net) = 10096.
  assert.ok(Math.abs(ex.getEquity() - 10_096) < 1e-9);
});

test("feePaidUsd reflects notional, not |PnL| (regression)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy(), 100, "open");
  // Big winner: exit at 200 → gross PnL = $2000. Fee MUST stay $2 (notional),
  // not 2000 * 0.001 = $2 (which happens to coincide here) so we use a loss
  // case to make the bug visible: lose 50% from 100 → 50.
  const ex2 = new PaperExchange(10_000);
  ex2.fill(buy(), 100, "open2");
  const lost = ex2.fill(close(), 50, "close2");
  // The pre-fix code would have reported feePaidUsd = |pnlUsd| * fee, which
  // for a -$1000 trade is $1, not $2. After fix it must be sizeUsd * fee = $2.
  assert.equal(lost.feePaidUsd, 2);
});

test("checkExits triggers on intra-bar stop wick (regression for C2)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ stop_loss_pct: 1 }), 100, "open");
  // entry=100, stopPrice=99. Bar wicks to 98.5 then closes back at 99.5.
  // The previous mid-only checkExits would have missed this entirely.
  const exit = ex.checkExits("BTC/USDT", { high: 100, low: 98.5, close: 99.5 });
  assert.ok(exit !== null);
  // Fill is at the trigger price (99), not at the wick low (98.5).
  assert.ok(Math.abs((exit?.exitPrice ?? 0) - 99) < 1e-9);
  assert.ok(exit!.pnlUsd < 0);
});

test("checkExits triggers on intra-bar take-profit reach", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ stop_loss_pct: 5, take_profit_pct: 2 }), 100, "open");
  // entry=100, tpPrice=102. Bar wicks to 103 then closes back at 101.5.
  const exit = ex.checkExits("BTC/USDT", { high: 103, low: 99, close: 101.5 });
  assert.ok(exit !== null);
  assert.ok(Math.abs((exit?.exitPrice ?? 0) - 102) < 1e-9);
  assert.ok(exit!.pnlUsd > 0);
});

test("checkExits returns null inside the corridor", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ stop_loss_pct: 1, take_profit_pct: 2 }), 100, "open");
  const exit = ex.checkExits("BTC/USDT", { high: 100.8, low: 99.5, close: 100.5 });
  assert.equal(exit, null);
});

test("when stop and TP both fall inside the same bar, stop wins (conservative)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ stop_loss_pct: 1, take_profit_pct: 1 }), 100, "open");
  // bar engulfs both stop (99) and TP (101)
  const exit = ex.checkExits("BTC/USDT", { high: 102, low: 98, close: 101 });
  assert.ok(exit !== null);
  assert.ok(Math.abs((exit?.exitPrice ?? 0) - 99) < 1e-9);
});

test("short stop fires when bar.high >= stopPrice", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(
    {
      action: "SELL",
      symbol: "BTC/USDT",
      size_pct_of_equity: 20,
      stop_loss_pct: 1,
      take_profit_pct: 5,
      confidence: 0.9,
      rationale: "test",
    },
    100,
    "open",
  );
  // entry=100 short, stopPrice=101. Bar wicks to 102 then back.
  const exit = ex.checkExits("BTC/USDT", { high: 102, low: 99, close: 101.5 });
  assert.ok(exit !== null);
  assert.ok(Math.abs((exit?.exitPrice ?? 0) - 101) < 1e-9);
});

test("daily rollover records yesterday before zeroing (regression for H16)", () => {
  let now = new Date("2026-05-02T12:00:00.000Z");
  const ex = new PaperExchange(10_000, () => now);
  // Earn some equity then advance the clock past UTC midnight.
  ex.fill(buy(), 100, "open");
  ex.fill(close(), 110, "close");
  // Equity should be > 10000 now.
  const eod = ex.getEquity();
  assert.ok(eod > 10_000);
  // Tick past midnight; reading any equity-aware getter triggers rollover.
  now = new Date("2026-05-03T00:00:01.000Z");
  ex.getEquity();
  const history = ex.getDailyPnlHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.day, "2026-05-02");
  assert.equal(history[0]?.equityStart, 10_000);
  assert.ok(Math.abs((history[0]?.equityEnd ?? 0) - eod) < 1e-9);
});

test("sizePct on closed trade uses entry-time equity (regression for H17)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ size_pct_of_equity: 20 }), 100, "open");
  // Take a big loss so post-fill equity diverges sharply from entry-time.
  const lost = ex.fill(close(), 50, "close");
  // sizePct should be reported as ~20 (entry-time), not the inflated post-fill
  // value the buggy version produced.
  assert.ok(Math.abs((lost.trade?.sizePct ?? 0) - 20) < 1e-6);
});

test("default taker fee is 10 bps (regression for C5)", () => {
  assert.equal(TAKER_FEE, 0.001);
});

test("getHighWater rises with equity but does not fall when equity drops (regression for C6)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ stop_loss_pct: 5, take_profit_pct: 50 }), 100, "open-1");
  // TP at 150 (low 105 stays clear of stop at 95)
  ex.checkExits("BTC/USDT", { high: 200, low: 105, close: 150 });
  const peak = ex.getEquity();
  assert.ok(peak > 10_000);
  assert.equal(ex.getHighWater(), peak);

  // New trade is stopped out → equity drops, HWM stays at peak.
  ex.fill(buy({ stop_loss_pct: 5, take_profit_pct: 100 }), 200, "open-2");
  ex.checkExits("BTC/USDT", { high: 201, low: 189, close: 195 });
  assert.ok(ex.getEquity() < peak);
  assert.equal(ex.getHighWater(), peak);
});

test("closeAll closes every open position at the supplied price (regression for C7)", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy({ symbol: "BTC/USDT" }), 100, "open-btc");
  ex.fill(buy({ symbol: "ETH/USDT" }), 50, "open-eth");
  const trades = ex.closeAll(
    new Map([
      ["BTC/USDT", 110],
      ["ETH/USDT", 55],
    ]),
    "force-close",
  );
  assert.equal(trades.length, 2);
  const btc = trades.find((t) => t.symbol === "BTC/USDT");
  const eth = trades.find((t) => t.symbol === "ETH/USDT");
  assert.equal(btc?.exitPrice, 110);
  assert.equal(eth?.exitPrice, 55);
});

test("closeAll falls back to entry price when a symbol is missing", () => {
  const ex = new PaperExchange(10_000);
  ex.fill(buy(), 100, "open");
  const trades = ex.closeAll(new Map());
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.exitPrice, 100);
});
