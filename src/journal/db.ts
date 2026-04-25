import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.js";
import type { Intent, MarketStatePacket } from "../agent/schema.js";
import type { Trade } from "../exchange/paper.js";

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

export function decisionId(
  symbol: string,
  action: string,
  timestamp: string,
): string {
  return createHash("sha256")
    .update(`${symbol}|${action}|${timestamp}`)
    .digest("hex");
}

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(CONFIG.DB_PATH), { recursive: true });
  _db = new Database(CONFIG.DB_PATH);
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
  `);
  return _db;
}

export function insertDecision(rec: DecisionRecord): void {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO decisions
      (id, timestamp, symbol, market_state, intent, risk_verdict,
       reject_reason, fill_price, equity_after, model, prompt_tokens, completion_tokens)
    VALUES
      (@id, @timestamp, @symbol, @market_state, @intent, @risk_verdict,
       @reject_reason, @fill_price, @equity_after, @model, @prompt_tokens, @completion_tokens)
  `);
  stmt.run({
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
  });
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
  stmt.run({
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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
