import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import type { Intent, MarketStatePacket } from "../agent/schema.js";
import type {
  DailyPnlSnapshot,
  PaperExchangeState,
  Position,
  Trade,
} from "../exchange/paper.js";

export interface DecisionRecord {
  id: string;
  timestamp: string;
  symbol: string;
  market_state: MarketStatePacket;
  intent: Intent;
  risk_verdict: "ACCEPT" | "REJECT" | "HALT";
  reject_reason?: string;
  fill_price?: number;
  equity_after: number;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cycle_number?: number;
  prompt_version?: string;
  system_prompt_hash?: string;
  raw_response?: string;
  cost_usd?: number;
}

export interface DecisionRow {
  id: string;
  timestamp: string;
  symbol: string;
  market_state: string;
  intent: string;
  risk_verdict: string;
  reject_reason: string | null;
  fill_price: number | null;
  equity_after: number;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cycle_number: number | null;
  prompt_version: string | null;
  system_prompt_hash: string | null;
  raw_response: string | null;
  cost_usd: number | null;
}

export interface TradeRow {
  id: string;
  open_decision_id: string | null;
  close_decision_id: string | null;
  symbol: string;
  side: string;
  entry_price: number | null;
  exit_price: number | null;
  size_pct: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  opened_at: string | null;
  closed_at: string | null;
}

/**
 * Deterministic decision id keyed to (symbol, action, candleOpenMs).
 *
 * The previous version included `cycleNumber` in the hash. Because
 * `SNAPSHOT.cycleNumber` resets to 0 on every process start, an identical
 * intent issued on cycle #1 of run-1 and cycle #1 of run-2 — not unlikely
 * given the C3 sizing override produces the same `size_pct_of_equity` for
 * the same stop — would collide post-restart and silently `DUPLICATE_ORDER`
 * (E1). Anchoring on the candle open instead gives the dedupe meaningful
 * semantics: "no two identical-action intents for the same symbol within
 * the same candle window," which is restart-safe and race-safe (force-cycle
 * × scheduled timer collapse to one row per candle).
 *
 * SL/TP/size are intentionally excluded so the C3 sizing override can't
 * manufacture pseudo-uniqueness across an otherwise-duplicate intent.
 */
export function decisionId(
  symbol: string,
  action: string,
  candleOpenMs: number,
): string {
  return createHash("sha256")
    .update([symbol, action, candleOpenMs].join("|"))
    .digest("hex");
}

let _db: Database.Database | null = null;
let _pathOverride: string | null = null;

// Tests use this to point the journal at a temp file before the first call.
// Resets to CONFIG.DB_PATH if called with `null`.
export function setDbPathForTesting(path: string | null): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _pathOverride = path;
}

function db(): Database.Database {
  if (_db) return _db;
  const path = _pathOverride ?? CONFIG.DB_PATH;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
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
    CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      open_decision_id TEXT,
      close_decision_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL,
      exit_price REAL,
      size_pct REAL,
      pnl_pct REAL,
      pnl_usd REAL,
      opened_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at);

    CREATE TABLE IF NOT EXISTS paper_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      equity REAL NOT NULL,
      high_water REAL NOT NULL,
      day_start_equity REAL NOT NULL,
      current_day TEXT NOT NULL,
      positions_json TEXT NOT NULL,
      daily_pnl_history_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migrate existing journals to add columns introduced after v0.1. SQLite
  // doesn't support `ADD COLUMN IF NOT EXISTS`, so we probe table_info first.
  const existingCols = new Set(
    (
      _db.prepare("PRAGMA table_info(decisions)").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  const newCols: Array<[string, string]> = [
    ["cycle_number", "INTEGER"],
    ["prompt_version", "TEXT"],
    ["system_prompt_hash", "TEXT"],
    ["raw_response", "TEXT"],
    ["cost_usd", "REAL"],
  ];
  for (const [name, type] of newCols) {
    if (!existingCols.has(name)) {
      _db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`);
    }
  }

  return _db;
}

export function insertDecision(rec: DecisionRecord): void {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO decisions
      (id, timestamp, symbol, market_state, intent, risk_verdict,
       reject_reason, fill_price, equity_after, model, prompt_tokens, completion_tokens,
       cycle_number, prompt_version, system_prompt_hash, raw_response, cost_usd)
    VALUES
      (@id, @timestamp, @symbol, @market_state, @intent, @risk_verdict,
       @reject_reason, @fill_price, @equity_after, @model, @prompt_tokens, @completion_tokens,
       @cycle_number, @prompt_version, @system_prompt_hash, @raw_response, @cost_usd)
  `);
  const info = stmt.run({
    id: rec.id,
    timestamp: rec.timestamp,
    symbol: rec.symbol,
    market_state: JSON.stringify(rec.market_state),
    intent: JSON.stringify(rec.intent),
    risk_verdict: rec.risk_verdict,
    reject_reason: rec.reject_reason ?? null,
    fill_price: rec.fill_price ?? null,
    equity_after: rec.equity_after,
    model: rec.model,
    prompt_tokens: rec.prompt_tokens,
    completion_tokens: rec.completion_tokens,
    cycle_number: rec.cycle_number ?? null,
    prompt_version: rec.prompt_version ?? null,
    system_prompt_hash: rec.system_prompt_hash ?? null,
    raw_response: rec.raw_response ?? null,
    cost_usd: rec.cost_usd ?? null,
  });
  // E4: surface dropped duplicates so the next race cause is visible.
  if (info.changes === 0) {
    logger.warn(
      `insertDecision: duplicate id ${rec.id} ignored (already journaled)`,
    );
  }
}

export function decisionExists(id: string): boolean {
  const row = db().prepare("SELECT 1 FROM decisions WHERE id = ?").get(id);
  return Boolean(row);
}

export function insertTrade(t: Trade): void {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO trades
      (id, open_decision_id, close_decision_id, symbol, side,
       entry_price, exit_price, size_pct, pnl_pct, pnl_usd, opened_at, closed_at)
    VALUES
      (@id, @open_decision_id, @close_decision_id, @symbol, @side,
       @entry_price, @exit_price, @size_pct, @pnl_pct, @pnl_usd, @opened_at, @closed_at)
  `);
  const info = stmt.run({
    id: t.id,
    open_decision_id: t.openDecisionId ?? null,
    close_decision_id: t.closeDecisionId ?? null,
    symbol: t.symbol,
    side: t.side,
    entry_price: t.entryPrice,
    exit_price: t.exitPrice,
    size_pct: t.sizePct,
    pnl_pct: t.pnlPct,
    pnl_usd: t.pnlUsd,
    opened_at: t.openedAt,
    closed_at: t.closedAt,
  });
  // E4: same as insertDecision — log the drop instead of swallowing it.
  if (info.changes === 0) {
    logger.warn(
      `insertTrade: duplicate id ${t.id} ignored (already journaled)`,
    );
  }
}

export function getRecentDecisions(n = 20): DecisionRow[] {
  return db()
    .prepare("SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?")
    .all(n) as DecisionRow[];
}

export function getLastDecision(): DecisionRow | undefined {
  return db()
    .prepare("SELECT * FROM decisions ORDER BY timestamp DESC LIMIT 1")
    .get() as DecisionRow | undefined;
}

export function getRecentTrades(n = 20): TradeRow[] {
  return db()
    .prepare("SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?")
    .all(n) as TradeRow[];
}

export function getLast3TradesSummary(symbol: string): Array<{
  action: string;
  pnl_pct: number;
  rationale_summary: string;
}> {
  const trades = db()
    .prepare(
      "SELECT * FROM trades WHERE symbol = ? ORDER BY closed_at DESC LIMIT 3",
    )
    .all(symbol) as TradeRow[];
  return trades.map((t) => ({
    action: t.side === "long" ? "BUY→CLOSE" : "SELL→CLOSE",
    pnl_pct: t.pnl_pct ?? 0,
    rationale_summary: `${t.side} ${t.entry_price} → ${t.exit_price}`,
  }));
}

export function getStats(): {
  totalDecisions: number;
  totalTrades: number;
  acceptCount: number;
  rejectCount: number;
  haltCount: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
} {
  const dec = db()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN risk_verdict='ACCEPT' THEN 1 ELSE 0 END) AS acc,
         SUM(CASE WHEN risk_verdict='REJECT' THEN 1 ELSE 0 END) AS rej,
         SUM(CASE WHEN risk_verdict='HALT' THEN 1 ELSE 0 END) AS halt,
         COALESCE(SUM(prompt_tokens),0) AS pt,
         COALESCE(SUM(completion_tokens),0) AS ct
       FROM decisions`,
    )
    .get() as {
    total: number;
    acc: number | null;
    rej: number | null;
    halt: number | null;
    pt: number;
    ct: number;
  };
  const tr = db()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) AS losses,
         COALESCE(SUM(pnl_usd),0) AS pnl
       FROM trades`,
    )
    .get() as {
    total: number;
    wins: number | null;
    losses: number | null;
    pnl: number;
  };
  return {
    totalDecisions: dec.total,
    totalTrades: tr.total,
    acceptCount: dec.acc ?? 0,
    rejectCount: dec.rej ?? 0,
    haltCount: dec.halt ?? 0,
    wins: tr.wins ?? 0,
    losses: tr.losses ?? 0,
    totalPnlUsd: tr.pnl,
    totalPromptTokens: dec.pt,
    totalCompletionTokens: dec.ct,
  };
}

export function savePaperState(s: PaperExchangeState): void {
  db()
    .prepare(
      `INSERT INTO paper_state
         (id, equity, high_water, day_start_equity, current_day,
          positions_json, daily_pnl_history_json, updated_at)
       VALUES
         (1, @equity, @high_water, @day_start_equity, @current_day,
          @positions_json, @daily_pnl_history_json, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         equity = excluded.equity,
         high_water = excluded.high_water,
         day_start_equity = excluded.day_start_equity,
         current_day = excluded.current_day,
         positions_json = excluded.positions_json,
         daily_pnl_history_json = excluded.daily_pnl_history_json,
         updated_at = excluded.updated_at`,
    )
    .run({
      equity: s.equity,
      high_water: s.highWater,
      day_start_equity: s.dayStartEquity,
      current_day: s.currentDay,
      positions_json: JSON.stringify(s.positions),
      daily_pnl_history_json: JSON.stringify(s.dailyPnlHistory),
      updated_at: new Date().toISOString(),
    });
}

export function loadPaperState(): PaperExchangeState | null {
  const row = db()
    .prepare(
      `SELECT equity, high_water, day_start_equity, current_day,
              positions_json, daily_pnl_history_json
         FROM paper_state WHERE id = 1`,
    )
    .get() as
    | {
        equity: number;
        high_water: number;
        day_start_equity: number;
        current_day: string;
        positions_json: string;
        daily_pnl_history_json: string;
      }
    | undefined;
  if (!row) return null;
  try {
    return {
      equity: row.equity,
      highWater: row.high_water,
      dayStartEquity: row.day_start_equity,
      currentDay: row.current_day,
      positions: JSON.parse(row.positions_json) as Position[],
      dailyPnlHistory: JSON.parse(
        row.daily_pnl_history_json,
      ) as DailyPnlSnapshot[],
    };
  } catch (e) {
    // Better to start fresh than to crash on corrupted JSON. The operator
    // sees the warning in the agent log; the journal row stays untouched
    // until the next savePaperState overwrites it.
    // eslint-disable-next-line no-console
    console.warn(
      `loadPaperState: corrupted row, ignoring: ${(e as Error).message}`,
    );
    return null;
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
