import { CONFIG } from "../config.js";
import type { Intent } from "../agent/schema.js";

const TAKER_FEE = 0.0005; // 0.05%

export interface Position {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  sizeUsd: number; // notional at entry
  qty: number; // base asset qty
  stopLossPct: number;
  takeProfitPct: number;
  openedAt: string;
  openDecisionId?: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  sizePct: number;
  pnlPct: number;
  pnlUsd: number;
  openedAt: string;
  closedAt: string;
  openDecisionId?: string;
  closeDecisionId?: string;
}

export interface FillResult {
  intent: Intent;
  fillPrice: number;
  position: Position | null;
  trade: Trade | null;
  equityAfter: number;
  feePaidUsd: number;
}

function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

export class PaperExchange {
  private equity: number;
  private positions: Map<string, Position> = new Map();
  private history: Trade[] = [];
  private dayStartEquity: number;
  private currentDay: string;

  constructor(initialEquity: number = CONFIG.INITIAL_EQUITY) {
    this.equity = initialEquity;
    this.dayStartEquity = initialEquity;
    this.currentDay = utcDateKey();
  }

  private rolloverIfNewDay(): void {
    const today = utcDateKey();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.dayStartEquity = this.equity;
    }
  }

  getEquity(): number {
    this.rolloverIfNewDay();
    return this.equity;
  }

  getDailyPnlPct(): number {
    this.rolloverIfNewDay();
    if (this.dayStartEquity <= 0) return 0;
    return ((this.equity - this.dayStartEquity) / this.dayStartEquity) * 100;
  }

  getOpenPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getOpenPositionSnapshot(symbol: string, lastPrice: number): {
    side: "long" | "short" | "none";
    entry_price: number;
    unrealized_pnl_pct: number;
  } {
    const p = this.positions.get(symbol);
    if (!p) return { side: "none", entry_price: 0, unrealized_pnl_pct: 0 };
    const direction = p.side === "long" ? 1 : -1;
    const upnl =
      p.entryPrice > 0
        ? ((lastPrice - p.entryPrice) / p.entryPrice) * 100 * direction
        : 0;
    return {
      side: p.side,
      entry_price: p.entryPrice,
      unrealized_pnl_pct: upnl,
    };
  }

  getRecentTrades(n = 5): Trade[] {
    return this.history.slice(-n).reverse();
  }

  /**
   * Apply an accepted intent at midPrice. Returns a FillResult describing
   * what happened (open new, close existing, or no-op for HOLD).
   */
  fill(intent: Intent, midPrice: number, decisionId?: string): FillResult {
    this.rolloverIfNewDay();

    if (intent.action === "HOLD") {
      return {
        intent,
        fillPrice: midPrice,
        position: this.positions.get(intent.symbol) ?? null,
        trade: null,
        equityAfter: this.equity,
        feePaidUsd: 0,
      };
    }

    if (intent.action === "CLOSE") {
      const pos = this.positions.get(intent.symbol);
      if (!pos) {
        return {
          intent,
          fillPrice: midPrice,
          position: null,
          trade: null,
          equityAfter: this.equity,
          feePaidUsd: 0,
        };
      }
      const trade = this.closePosition(pos, midPrice, decisionId);
      return {
        intent,
        fillPrice: midPrice,
        position: null,
        trade,
        equityAfter: this.equity,
        feePaidUsd: trade.pnlUsd < 0 ? -trade.pnlUsd * TAKER_FEE : trade.pnlUsd * TAKER_FEE,
      };
    }

    // BUY or SELL — open a new position.
    const side: "long" | "short" = intent.action === "BUY" ? "long" : "short";
    const sizeUsd = (intent.size_pct_of_equity / 100) * this.equity;
    const fee = sizeUsd * TAKER_FEE;
    const qty = midPrice > 0 ? sizeUsd / midPrice : 0;

    this.equity -= fee;

    const pos: Position = {
      symbol: intent.symbol,
      side,
      entryPrice: midPrice,
      sizeUsd,
      qty,
      stopLossPct: intent.stop_loss_pct,
      takeProfitPct: intent.take_profit_pct,
      openedAt: new Date().toISOString(),
      openDecisionId: decisionId,
    };
    this.positions.set(intent.symbol, pos);

    return {
      intent,
      fillPrice: midPrice,
      position: pos,
      trade: null,
      equityAfter: this.equity,
      feePaidUsd: fee,
    };
  }

  /**
   * Check the open position against stop-loss / take-profit using the latest
   * mid price; if either is breached, close it. Used between LLM cycles to
   * give SL/TP execution semantics without a separate order book.
   */
  checkExits(symbol: string, lastPrice: number, decisionId?: string): Trade | null {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    const direction = pos.side === "long" ? 1 : -1;
    const movePct = ((lastPrice - pos.entryPrice) / pos.entryPrice) * 100 * direction;
    if (movePct <= -pos.stopLossPct || movePct >= pos.takeProfitPct) {
      return this.closePosition(pos, lastPrice, decisionId);
    }
    return null;
  }

  private closePosition(
    pos: Position,
    exitPrice: number,
    closeDecisionId?: string,
  ): Trade {
    const direction = pos.side === "long" ? 1 : -1;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 * direction;
    const grossPnlUsd = (pnlPct / 100) * pos.sizeUsd;
    const fee = pos.sizeUsd * TAKER_FEE;
    const netPnlUsd = grossPnlUsd - fee;

    this.equity += netPnlUsd;

    const trade: Trade = {
      id: `${pos.symbol}-${pos.openedAt}-${new Date().toISOString()}`,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      sizePct: pos.sizeUsd / (this.equity > 0 ? this.equity : 1) * 100,
      pnlPct,
      pnlUsd: netPnlUsd,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      openDecisionId: pos.openDecisionId,
      closeDecisionId,
    };
    this.history.push(trade);
    this.positions.delete(pos.symbol);
    return trade;
  }
}
