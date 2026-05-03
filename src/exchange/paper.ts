import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import type { Intent } from "../agent/schema.js";

// Binance spot taker is 10 bps standard, 7.5 bps with BNB discount. We model
// the standard rate; tests can override via the constructor. Anything lower
// silently flatters backtest results vs live.
export const TAKER_FEE = 0.001; // 0.1%

export interface Bar {
  high: number;
  low: number;
  close: number;
}

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
  // Equity snapshot at the moment this position was opened, before fees were
  // deducted. Used to attribute sizePct on the closed-trade row to entry-time
  // equity rather than the (drifting) post-fee equity.
  equityAtOpen: number;
}

export interface DailyPnlSnapshot {
  day: string;
  equityStart: number;
  equityEnd: number;
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

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
}

export interface PaperExchangeState {
  equity: number;
  highWater: number;
  dayStartEquity: number;
  currentDay: string;
  positions: Position[];
  dailyPnlHistory: DailyPnlSnapshot[];
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

export class PaperExchange {
  private equity: number;
  // High-water mark of equity since the process started. Drives the
  // max-drawdown kill switch — anchoring the kill line to peak equity (not
  // INITIAL_EQUITY) so a $20k account can't bleed back to $8.5k and call it
  // "still within the 15% allowance". Reset each launch (no persistence).
  private highWater: number;
  private positions: Map<string, Position> = new Map();
  private history: Trade[] = [];
  private dayStartEquity: number;
  private currentDay: string;
  // Records each completed UTC day's start/end equity so the dashboard or
  // an external auditor can reconstruct daily PnL even after rollover. Kept
  // in-memory only; the SQLite journal can derive the same series from the
  // equity_after column of the decisions table if persistence is needed.
  private dailyPnlHistory: DailyPnlSnapshot[] = [];

  constructor(
    initialEquity: number = CONFIG.INITIAL_EQUITY,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.equity = initialEquity;
    this.highWater = initialEquity;
    this.dayStartEquity = initialEquity;
    this.currentDay = utcDateKey(this.now());
  }

  private bumpHighWater(): void {
    if (this.equity > this.highWater) this.highWater = this.equity;
  }

  private rolloverIfNewDay(): void {
    const today = utcDateKey(this.now());
    if (today !== this.currentDay) {
      // Capture yesterday's day before zeroing — otherwise a fill at
      // 23:59:59 UTC followed by a read at 00:00:01 UTC would silently
      // collapse the day's realised PnL.
      this.dailyPnlHistory.push({
        day: this.currentDay,
        equityStart: this.dayStartEquity,
        equityEnd: this.equity,
      });
      this.currentDay = today;
      this.dayStartEquity = this.equity;
    }
  }

  getDailyPnlHistory(): readonly DailyPnlSnapshot[] {
    return this.dailyPnlHistory;
  }

  getEquity(): number {
    this.rolloverIfNewDay();
    return this.equity;
  }

  getHighWater(): number {
    return this.highWater;
  }

  getDailyPnlPct(): number {
    this.rolloverIfNewDay();
    if (this.dayStartEquity <= 0) return 0;
    return ((this.equity - this.dayStartEquity) / this.dayStartEquity) * 100;
  }

  /**
   * E2: realised equity + unrealised P&L on every open position. Drives the
   * daily-loss limit and max-DD halt so a position that grinds down without
   * touching its stop still trips the kill switch — otherwise `equity_usd`
   * lags reality by an entire bleed cycle.
   *
   * Falls back to entry price (zero unrealised) when a position has no
   * `lastPrice` in the supplied map and logs a warning. In normal operation
   * the cycle that calls this always has a fresh ticker for the symbol.
   */
  markToMarket(lastPrices: Map<string, number>): number {
    this.rolloverIfNewDay();
    let mtm = this.equity;
    for (const pos of this.positions.values()) {
      const px = lastPrices.get(pos.symbol);
      if (px === undefined || !Number.isFinite(px)) {
        logger.warn(
          `markToMarket: no lastPrice for ${pos.symbol}; using entry (unrealised=0)`,
        );
        continue;
      }
      const dir = pos.side === "long" ? 1 : -1;
      const movePct = ((px - pos.entryPrice) / pos.entryPrice) * dir;
      mtm += movePct * pos.sizeUsd;
    }
    return mtm;
  }

  /** Realised + unrealised daily P&L in percent, used by the kill switch. */
  getDailyPnlPctMTM(lastPrices: Map<string, number>): number {
    this.rolloverIfNewDay();
    if (this.dayStartEquity <= 0) return 0;
    return (
      ((this.markToMarket(lastPrices) - this.dayStartEquity) /
        this.dayStartEquity) *
      100
    );
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
   * Apply an accepted intent against a live quote. Market orders cross the
   * spread: BUY/CLOSE-short fill at the ask, SELL/CLOSE-long fill at the bid.
   * Modelling spread (rather than mid) is the difference between honest paper
   * PnL and a backtest that quietly skims half a spread per trade.
   */
  fill(intent: Intent, quote: Quote, decisionId?: string): FillResult {
    this.rolloverIfNewDay();

    if (intent.action === "HOLD") {
      return {
        intent,
        fillPrice: quote.mid,
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
          fillPrice: quote.mid,
          position: null,
          trade: null,
          equityAfter: this.equity,
          feePaidUsd: 0,
        };
      }
      // Closing a long sells into the bid; closing a short buys at the ask.
      const exitPrice = pos.side === "long" ? quote.bid : quote.ask;
      const trade = this.closePosition(pos, exitPrice, decisionId);
      return {
        intent,
        fillPrice: exitPrice,
        position: null,
        trade,
        equityAfter: this.equity,
        // Fees are charged on notional, not on |PnL|. The previous
        // implementation reported |pnlUsd| * fee which made small wins look
        // like they paid trivial fees and large losses look extortionate.
        feePaidUsd: pos.sizeUsd * TAKER_FEE,
      };
    }

    // BUY or SELL — open a new position. Snapshot equity *before* the fee is
    // deducted so the closed-trade row attributes risk to entry-time equity.
    const equityAtOpen = this.equity;
    const side: "long" | "short" = intent.action === "BUY" ? "long" : "short";
    // Open a long at the ask, a short at the bid.
    const fillPrice = side === "long" ? quote.ask : quote.bid;
    const sizeUsd = (intent.size_pct_of_equity / 100) * equityAtOpen;
    const fee = sizeUsd * TAKER_FEE;
    const qty = fillPrice > 0 ? sizeUsd / fillPrice : 0;

    this.equity -= fee;
    this.bumpHighWater();

    const pos: Position = {
      symbol: intent.symbol,
      side,
      entryPrice: fillPrice,
      sizeUsd,
      qty,
      stopLossPct: intent.stop_loss_pct,
      takeProfitPct: intent.take_profit_pct,
      openedAt: this.now().toISOString(),
      openDecisionId: decisionId,
      equityAtOpen,
    };
    this.positions.set(intent.symbol, pos);

    return {
      intent,
      fillPrice,
      position: pos,
      trade: null,
      equityAfter: this.equity,
      feePaidUsd: fee,
    };
  }

  /**
   * Models stop-loss / take-profit as resting orders that fire intra-bar:
   * triggered when the bar's high/low reaches the stop or TP level, filled
   * at the trigger price (optimistic — gap-through slippage is not modeled
   * in v0.1). The previous mid-only check missed wicks that hit the stop
   * and recovered, which silently inflated paper PnL vs live.
   *
   * When both stop and TP fall inside the same bar, the stop wins
   * (conservative — without tick-level data we can't know which fired
   * first, so we assume the worse outcome).
   */
  checkExits(symbol: string, bar: Bar, decisionId?: string): Trade | null {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    if (!(bar.low <= bar.high)) return null;

    const stopPrice =
      pos.side === "long"
        ? pos.entryPrice * (1 - pos.stopLossPct / 100)
        : pos.entryPrice * (1 + pos.stopLossPct / 100);
    const tpPrice =
      pos.side === "long"
        ? pos.entryPrice * (1 + pos.takeProfitPct / 100)
        : pos.entryPrice * (1 - pos.takeProfitPct / 100);

    const stopHit =
      pos.side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    const tpHit =
      pos.side === "long" ? bar.high >= tpPrice : bar.low <= tpPrice;

    if (stopHit) return this.closePosition(pos, stopPrice, decisionId);
    if (tpHit) return this.closePosition(pos, tpPrice, decisionId);
    return null;
  }

  /**
   * Force-close every open position at the supplied last price. Used by the
   * HALT path so a max-drawdown breach can't leave a position bleeding
   * unattended. Falls back to entry price (zero realised PnL beyond fees)
   * when a price is missing — that case is logged and should never happen
   * in normal operation.
   */
  closeAll(lastPrices: Map<string, number>, closeDecisionId?: string): Trade[] {
    const trades: Trade[] = [];
    for (const pos of Array.from(this.positions.values())) {
      let exit = lastPrices.get(pos.symbol);
      if (exit === undefined || !Number.isFinite(exit)) {
        logger.warn(
          `closeAll: no price for ${pos.symbol}, closing at entry ${pos.entryPrice}`,
        );
        exit = pos.entryPrice;
      }
      trades.push(this.closePosition(pos, exit, closeDecisionId));
    }
    return trades;
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
    this.bumpHighWater();

    // Attribute sizePct against entry-time equity (pre-fee), not the
    // post-fill equity. Otherwise a position that lost half its value would
    // record a sizePct higher than what was actually risked at open.
    const sizePctAtEntry =
      pos.equityAtOpen > 0 ? (pos.sizeUsd / pos.equityAtOpen) * 100 : 0;
    const closedAt = this.now().toISOString();
    const trade: Trade = {
      id: `${pos.symbol}-${pos.openedAt}-${closedAt}`,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      sizePct: sizePctAtEntry,
      pnlPct,
      pnlUsd: netPnlUsd,
      openedAt: pos.openedAt,
      closedAt,
      openDecisionId: pos.openDecisionId,
      closeDecisionId,
    };
    this.history.push(trade);
    this.positions.delete(pos.symbol);
    return trade;
  }

  /**
   * Snapshot every persistable field. Trade history is intentionally omitted —
   * the SQLite `trades` table is the source of truth for closed trades; this
   * snapshot only covers state that lives nowhere else.
   */
  exportState(): PaperExchangeState {
    return {
      equity: this.equity,
      highWater: this.highWater,
      dayStartEquity: this.dayStartEquity,
      currentDay: this.currentDay,
      positions: Array.from(this.positions.values()),
      dailyPnlHistory: [...this.dailyPnlHistory],
    };
  }

  restoreState(s: PaperExchangeState): void {
    this.equity = s.equity;
    this.highWater = s.highWater;
    this.dayStartEquity = s.dayStartEquity;
    this.currentDay = s.currentDay;
    this.positions = new Map(s.positions.map((p) => [p.symbol, p]));
    this.dailyPnlHistory = [...s.dailyPnlHistory];
  }
}
