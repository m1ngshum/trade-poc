import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "../src/risk/engine.js";
import type { MarketStatePacket, Intent } from "../src/agent/schema.js";

// Default config (see src/config.ts) — these tests exercise the engine against
// the default thresholds: INITIAL_EQUITY=10000, MAX_POSITION_PCT=20,
// DAILY_LOSS_LIMIT_PCT=3, MAX_DRAWDOWN_PCT=15, MIN_CONFIDENCE=0.6,
// SYMBOLS=[BTC/USDT, ETH/USDT].

function packet(overrides: Partial<MarketStatePacket> = {}): MarketStatePacket {
  return {
    symbol: "BTC/USDT",
    timestamp: "2026-05-02T12:00:00.000Z",
    price: 100,
    change_1h_pct: 0,
    change_4h_pct: 0,
    change_24h_pct: 0,
    rsi_14: 50,
    macd_histogram: 0,
    ema200_distance_pct: 0,
    atr_14: 1,
    volume_24h_usd: 1_000_000,
    regime: "ranging",
    open_position: { side: "none", entry_price: 0, unrealized_pnl_pct: 0 },
    equity_usd: 10_000,
    daily_pnl_pct: 0,
    last_3_trades: [],
    ...overrides,
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    action: "BUY",
    symbol: "BTC/USDT",
    size_pct_of_equity: 10,
    stop_loss_pct: 1,
    take_profit_pct: 2,
    confidence: 0.8,
    rationale: "test",
    ...overrides,
  };
}

test("schema invalid intent → SCHEMA_INVALID reject", () => {
  const r = evaluate({ intent: { action: "WAT" }, packet: packet() });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /SCHEMA_INVALID/);
});

test("hallucinated extra field → SCHEMA_INVALID reject (Zod strict)", () => {
  const bad = { ...intent(), liquidate_all: true };
  const r = evaluate({ intent: bad, packet: packet() });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /SCHEMA_INVALID/);
});

test("symbol off allowlist → SYMBOL_NOT_WHITELISTED reject", () => {
  const r = evaluate({
    intent: intent({ symbol: "DOGE/USDT" }),
    packet: packet({ symbol: "DOGE/USDT" }),
  });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /SYMBOL_NOT_WHITELISTED/);
});

test("equity below drawdown limit halts even on HOLD", () => {
  // 10000 * (1 - 0.15) = 8500; anything strictly below halts.
  const r = evaluate({
    intent: intent({ action: "HOLD", size_pct_of_equity: 0 }),
    packet: packet({ equity_usd: 8000 }),
  });
  assert.equal(r.verdict, "HALT");
  assert.equal(r.reason, "MAX_DRAWDOWN");
});

test("HOLD short-circuits trade-specific checks", () => {
  // size_pct=99 would normally trip SIZE_CAP, but HOLD bypasses that path.
  const r = evaluate({
    intent: intent({ action: "HOLD", size_pct_of_equity: 99 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "ACCEPT");
});

test("daily loss limit fires before SIZE/STOP checks", () => {
  // size and stop are *also* invalid here; the daily-loss reason should win.
  const r = evaluate({
    intent: intent({ size_pct_of_equity: 99, stop_loss_pct: 0 }),
    packet: packet({ daily_pnl_pct: -5 }),
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "DAILY_LOSS_LIMIT");
});

test("low confidence rejects with LOW_CONFIDENCE", () => {
  const r = evaluate({
    intent: intent({ confidence: 0.4 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /LOW_CONFIDENCE/);
});

test("confidence at boundary (>= MIN_CONFIDENCE) passes", () => {
  const r = evaluate({
    intent: intent({ confidence: 0.6 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "ACCEPT");
});

test("size above MAX_POSITION_PCT → SIZE_CAP", () => {
  const r = evaluate({
    intent: intent({ size_pct_of_equity: 25 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /SIZE_CAP/);
});

test("missing stop-loss → STOP_LOSS_MISSING", () => {
  const r = evaluate({
    intent: intent({ stop_loss_pct: 0 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "STOP_LOSS_MISSING");
});

test("duplicate order id → DUPLICATE_ORDER", () => {
  const r = evaluate({
    intent: intent(),
    packet: packet(),
    duplicateOrderId: true,
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "DUPLICATE_ORDER");
});

test("BUY while already long → POSITION_ALREADY_OPEN", () => {
  const r = evaluate({
    intent: intent({ action: "BUY" }),
    packet: packet({
      open_position: { side: "long", entry_price: 100, unrealized_pnl_pct: 0 },
    }),
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "POSITION_ALREADY_OPEN");
});

test("SELL while already short → POSITION_ALREADY_OPEN", () => {
  const r = evaluate({
    intent: intent({ action: "SELL" }),
    packet: packet({
      open_position: { side: "short", entry_price: 100, unrealized_pnl_pct: 0 },
    }),
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "POSITION_ALREADY_OPEN");
});

test("CLOSE without an open position → CLOSE_WITHOUT_POSITION", () => {
  const r = evaluate({
    intent: intent({ action: "CLOSE" }),
    packet: packet(),
  });
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "CLOSE_WITHOUT_POSITION");
});

test("valid BUY on flat book → ACCEPT", () => {
  const r = evaluate({
    intent: intent(),
    packet: packet(),
  });
  assert.equal(r.verdict, "ACCEPT");
});

test("valid CLOSE of an open long → ACCEPT", () => {
  const r = evaluate({
    intent: intent({ action: "CLOSE" }),
    packet: packet({
      open_position: { side: "long", entry_price: 100, unrealized_pnl_pct: 1 },
    }),
  });
  assert.equal(r.verdict, "ACCEPT");
});
