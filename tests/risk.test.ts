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
    equity_high_water: 10_000,
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

test("LLM-proposed size is overridden by risk-based sizing (regression for C3)", () => {
  // RISK_PER_TRADE_PCT default 0.5, stop_loss_pct=2 → 0.5/2*100 = 25 → clamped
  // to MAX_POSITION_PCT (default 20). The LLM's proposed 7 is ignored.
  const r = evaluate({
    intent: intent({ size_pct_of_equity: 7, stop_loss_pct: 2 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "ACCEPT");
  assert.equal(r.intent?.size_pct_of_equity, 20);
});

test("wider stop produces a smaller risk-based size", () => {
  // 0.5 / 10 * 100 = 5%
  const r = evaluate({
    intent: intent({ size_pct_of_equity: 99, stop_loss_pct: 10 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "ACCEPT");
  assert.ok(Math.abs((r.intent?.size_pct_of_equity ?? 0) - 5) < 1e-9);
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

test("drawdown HALT is anchored to high-water mark, not initial equity (regression for C6)", () => {
  // HWM=20000, MAX_DD=15% → kill line = 17000. Equity 18000 sits above the
  // line under HWM anchoring; under the old INITIAL_EQUITY=10000 anchor it
  // would not have halted either, so the discriminating case is below.
  const r1 = evaluate({
    intent: intent({ action: "HOLD", size_pct_of_equity: 0 }),
    packet: packet({ equity_usd: 18_000, equity_high_water: 20_000 }),
  });
  assert.equal(r1.verdict, "ACCEPT");

  // Equity 16000 is well above the old INITIAL_EQUITY-anchored line (8500)
  // but BELOW the HWM-anchored line (17000) → must HALT.
  const r2 = evaluate({
    intent: intent({ action: "HOLD", size_pct_of_equity: 0 }),
    packet: packet({ equity_usd: 16_000, equity_high_water: 20_000 }),
  });
  assert.equal(r2.verdict, "HALT");
  assert.equal(r2.reason, "MAX_DRAWDOWN");
});

test("stop tighter than 0.1% is rejected (would force >100% sizing)", () => {
  const r = evaluate({
    intent: intent({ stop_loss_pct: 0.05 }),
    packet: packet(),
  });
  assert.equal(r.verdict, "REJECT");
  assert.match(r.reason ?? "", /STOP_TOO_TIGHT/);
});
