import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  decisionId,
  getRecentDecisions,
  insertDecision,
  insertTrade,
  loadPaperState,
  savePaperState,
  setDbPathForTesting,
} from "../src/journal/db.js";
import { logger } from "../src/logger.js";
import type {
  Position,
  DailyPnlSnapshot,
  Trade,
} from "../src/exchange/paper.js";

// E1: dedupe is now keyed on (symbol, action, candleOpenMs). The old key
// included cycleNumber + sl/tp/size, which collided across restarts because
// SNAPSHOT.cycleNumber resets to 0 on every process start.
const CANDLE_A = 1_700_000_000_000;
const CANDLE_B = CANDLE_A + 15 * 60_000;

test("decisionId is deterministic for (symbol, action, candleOpenMs)", () => {
  assert.equal(
    decisionId("BTC/USDT", "BUY", CANDLE_A),
    decisionId("BTC/USDT", "BUY", CANDLE_A),
  );
});

test("decisionId differs when symbol, action, or candle changes", () => {
  const base = decisionId("BTC/USDT", "BUY", CANDLE_A);
  assert.notEqual(base, decisionId("ETH/USDT", "BUY", CANDLE_A));
  assert.notEqual(base, decisionId("BTC/USDT", "SELL", CANDLE_A));
  assert.notEqual(base, decisionId("BTC/USDT", "BUY", CANDLE_B));
});

test("E1: identical intent in same candle stays stable across simulated restart", () => {
  // The old key included cycleNumber: cycle #1 of run-1 and cycle #1 of
  // run-2 (after restart) would collide. The new key has no cycleNumber, so
  // restart never affects the id — restart-safety here means the SAME id
  // for the same (symbol, action, candle), and decisionExists can therefore
  // legitimately reject the second call as DUPLICATE_ORDER.
  const beforeRestart = decisionId("BTC/USDT", "BUY", CANDLE_A);
  const afterRestart = decisionId("BTC/USDT", "BUY", CANDLE_A);
  assert.equal(beforeRestart, afterRestart);
});

test("journal in WAL mode and round-trips the new columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "trade-journal-"));
  const path = join(dir, "test.db");
  setDbPathForTesting(path);
  try {
    insertDecision({
      id: decisionId("BTC/USDT", "BUY", CANDLE_A),
      timestamp: "2026-05-02T12:00:00.000Z",
      symbol: "BTC/USDT",
      market_state: {
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
        volume_24h_usd: 1,
        regime: "ranging",
        open_position: { side: "none", entry_price: 0, unrealized_pnl_pct: 0 },
        equity_usd: 10000,
        equity_high_water: 10000,
        daily_pnl_pct: 0,
        last_3_trades: [],
      },
      intent: {
        action: "BUY",
        symbol: "BTC/USDT",
        size_pct_of_equity: 10,
        stop_loss_pct: 1,
        take_profit_pct: 2,
        confidence: 0.8,
        rationale: "test",
      },
      risk_verdict: "ACCEPT",
      equity_after: 9998,
      model: "test-model",
      prompt_tokens: 100,
      completion_tokens: 20,
      cycle_number: 1,
      prompt_version: "v1",
      system_prompt_hash: "abcd",
      raw_response: "{\"action\": \"BUY\"}",
      cost_usd: 0.0023,
    });

    // Probe WAL mode via a fresh connection (the journal's own connection is
    // already in WAL after open, but verify it externally too).
    const probe = new Database(path);
    const mode = probe.pragma("journal_mode") as Array<{ journal_mode: string }>;
    assert.equal(mode[0]?.journal_mode, "wal");
    probe.close();

    const row = getRecentDecisions(1)[0];
    assert.ok(row);
    assert.equal(row?.cycle_number, 1);
    assert.equal(row?.prompt_version, "v1");
    assert.equal(row?.system_prompt_hash, "abcd");
    assert.equal(row?.raw_response, "{\"action\": \"BUY\"}");
    assert.ok(Math.abs((row?.cost_usd ?? 0) - 0.0023) < 1e-9);
  } finally {
    closeDb();
    setDbPathForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy journals get migrated with new columns", () => {
  // Simulate a v0.1 journal: pre-fix schema with no new columns. The
  // migration code path inside db() should add them on open.
  const dir = mkdtempSync(join(tmpdir(), "trade-journal-legacy-"));
  const path = join(dir, "legacy.db");
  const seed = new Database(path);
  seed.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      market_state TEXT NOT NULL,
      intent TEXT NOT NULL,
      risk_verdict TEXT NOT NULL,
      reject_reason TEXT,
      fill_price REAL,
      equity_after REAL NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER
    );
  `);
  seed.close();

  setDbPathForTesting(path);
  try {
    // Touch the journal so the migration runs.
    insertDecision({
      id: decisionId("BTC/USDT", "HOLD", CANDLE_B),
      timestamp: "2026-05-02T12:00:00.000Z",
      symbol: "BTC/USDT",
      market_state: {
        symbol: "BTC/USDT",
        timestamp: "2026-05-02T12:00:00.000Z",
        price: 1,
        change_1h_pct: 0,
        change_4h_pct: 0,
        change_24h_pct: 0,
        rsi_14: 0,
        macd_histogram: 0,
        ema200_distance_pct: 0,
        atr_14: 0,
        volume_24h_usd: 0,
        regime: "ranging",
        open_position: { side: "none", entry_price: 0, unrealized_pnl_pct: 0 },
        equity_usd: 10000,
        equity_high_water: 10000,
        daily_pnl_pct: 0,
        last_3_trades: [],
      },
      intent: {
        action: "HOLD",
        symbol: "BTC/USDT",
        size_pct_of_equity: 0,
        stop_loss_pct: 0.5,
        take_profit_pct: 0.5,
        confidence: 0,
        rationale: "test",
      },
      risk_verdict: "ACCEPT",
      equity_after: 10000,
      model: "test-model",
      prompt_tokens: 0,
      completion_tokens: 0,
    });

    const probe = new Database(path);
    const cols = (
      probe.prepare("PRAGMA table_info(decisions)").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    probe.close();
    for (const expected of [
      "cycle_number",
      "prompt_version",
      "system_prompt_hash",
      "raw_response",
      "cost_usd",
    ]) {
      assert.ok(cols.includes(expected), `missing column: ${expected}`);
    }
  } finally {
    closeDb();
    setDbPathForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E4: insertDecision warns when INSERT OR IGNORE drops a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "trade-journal-dup-"));
  const path = join(dir, "test.db");
  setDbPathForTesting(path);
  const warnings: string[] = [];
  const origWarn = logger.warn.bind(logger);
  logger.warn = ((msg: string) => {
    warnings.push(msg);
    return logger;
  }) as typeof logger.warn;
  try {
    const id = decisionId("BTC/USDT", "BUY", CANDLE_A);
    const baseRecord = {
      id,
      timestamp: "2026-05-02T12:00:00.000Z",
      symbol: "BTC/USDT",
      market_state: {
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
        volume_24h_usd: 1,
        regime: "ranging" as const,
        open_position: { side: "none" as const, entry_price: 0, unrealized_pnl_pct: 0 },
        equity_usd: 10_000,
        equity_high_water: 10_000,
        daily_pnl_pct: 0,
        last_3_trades: [],
      },
      intent: {
        action: "BUY" as const,
        symbol: "BTC/USDT",
        size_pct_of_equity: 10,
        stop_loss_pct: 1,
        take_profit_pct: 2,
        confidence: 0.8,
        rationale: "test",
      },
      risk_verdict: "ACCEPT" as const,
      equity_after: 9_990,
      model: "test",
      prompt_tokens: 0,
      completion_tokens: 0,
    };
    insertDecision(baseRecord);
    insertDecision(baseRecord); // duplicate id — silently ignored before E4
    assert.ok(
      warnings.some((m) => m.includes(`duplicate id ${id}`)),
      `expected duplicate-warn; got ${JSON.stringify(warnings)}`,
    );
  } finally {
    logger.warn = origWarn;
    closeDb();
    setDbPathForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E4: insertTrade warns when INSERT OR IGNORE drops a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "trade-journal-dup-trade-"));
  const path = join(dir, "test.db");
  setDbPathForTesting(path);
  const warnings: string[] = [];
  const origWarn = logger.warn.bind(logger);
  logger.warn = ((msg: string) => {
    warnings.push(msg);
    return logger;
  }) as typeof logger.warn;
  try {
    const trade: Trade = {
      id: "trade-dup-1",
      symbol: "BTC/USDT",
      side: "long",
      entryPrice: 50_000,
      exitPrice: 51_000,
      sizePct: 10,
      pnlPct: 2,
      pnlUsd: 20,
      openedAt: "2026-05-02T12:00:00.000Z",
      closedAt: "2026-05-02T12:30:00.000Z",
    };
    insertTrade(trade);
    insertTrade(trade);
    assert.ok(
      warnings.some((m) => m.includes(`duplicate id ${trade.id}`)),
      `expected duplicate-warn; got ${JSON.stringify(warnings)}`,
    );
  } finally {
    logger.warn = origWarn;
    closeDb();
    setDbPathForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paper_state round-trips and the latest save wins (H18)", () => {
  const dir = mkdtempSync(join(tmpdir(), "trade-paper-state-"));
  const path = join(dir, "test.db");
  setDbPathForTesting(path);
  try {
    assert.equal(loadPaperState(), null);

    const positions: Position[] = [
      {
        symbol: "BTC/USDT",
        side: "long",
        entryPrice: 100,
        sizeUsd: 2000,
        qty: 20,
        stopLossPct: 1,
        takeProfitPct: 2,
        openedAt: "2026-05-02T12:00:00.000Z",
        openDecisionId: "open-1",
        equityAtOpen: 10_000,
      },
      {
        symbol: "ETH/USDT",
        side: "short",
        entryPrice: 50,
        sizeUsd: 500,
        qty: 10,
        stopLossPct: 1,
        takeProfitPct: 2,
        openedAt: "2026-05-02T12:01:00.000Z",
        openDecisionId: "open-2",
        equityAtOpen: 10_000,
      },
    ];
    const dailyPnlHistory: DailyPnlSnapshot[] = [
      { day: "2026-05-01", equityStart: 10_000, equityEnd: 10_120 },
    ];
    savePaperState({
      equity: 10_120,
      highWater: 10_200,
      dayStartEquity: 10_120,
      currentDay: "2026-05-02",
      positions,
      dailyPnlHistory,
    });

    const loaded = loadPaperState();
    assert.ok(loaded);
    assert.equal(loaded?.equity, 10_120);
    assert.equal(loaded?.highWater, 10_200);
    assert.equal(loaded?.dayStartEquity, 10_120);
    assert.equal(loaded?.currentDay, "2026-05-02");
    assert.equal(loaded?.positions.length, 2);
    assert.equal(loaded?.positions[0]?.symbol, "BTC/USDT");
    assert.equal(loaded?.positions[1]?.side, "short");
    assert.equal(loaded?.dailyPnlHistory.length, 1);
    assert.equal(loaded?.dailyPnlHistory[0]?.equityEnd, 10_120);

    // Save again with different values — upsert must overwrite, not append.
    savePaperState({
      equity: 9_900,
      highWater: 10_200,
      dayStartEquity: 10_120,
      currentDay: "2026-05-02",
      positions: [],
      dailyPnlHistory,
    });
    const second = loadPaperState();
    assert.equal(second?.equity, 9_900);
    assert.equal(second?.positions.length, 0);
  } finally {
    closeDb();
    setDbPathForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
