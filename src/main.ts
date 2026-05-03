import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { fetchOHLCV, fetchTicker } from "./data/market.js";
import {
  computeChanges,
  computeIndicators,
  timeframeMinutes,
} from "./data/indicators.js";
import { classifyRegime } from "./data/regime.js";
import { decide, syntheticHold } from "./agent/brain.js";
import { PROMPT_VERSION, systemPromptHash } from "./agent/prompt.js";
import { CostTracker } from "./agent/cost-tracker.js";
import type { MarketStatePacket } from "./agent/schema.js";
import { evaluate } from "./risk/engine.js";
import { PaperExchange } from "./exchange/paper.js";
import {
  closeDb,
  decisionExists,
  decisionId,
  getLast3TradesSummary,
  insertDecision,
  insertTrade,
  loadPaperState,
  savePaperState,
} from "./journal/db.js";
import { bus, SNAPSHOT, type CycleSnapshot } from "./state.js";
import { renderDashboard } from "./ui/dashboard.js";

const exchange = new PaperExchange();
const restored = loadPaperState();
if (restored) {
  exchange.restoreState(restored);
}
const costTracker = new CostTracker(CONFIG.LLM_DAILY_BUDGET_USD);
const tfMinutes = timeframeMinutes(CONFIG.TIMEFRAME);
const tfMs = tfMinutes * 60_000;
// Wait this many ms past a candle close before firing the cycle so the
// exchange has finalised the bar. 5s comfortably covers most spot venues.
const CYCLE_BUFFER_MS = 5_000;
const PROMPT_HASH = systemPromptHash();

let halted = false;
let cycleTimer: NodeJS.Timeout | null = null;
// Single in-flight guard: the dashboard's "force cycle" key and the timer can
// otherwise both fire runCycle concurrently, racing on the singleton
// PaperExchange / costTracker / SNAPSHOT.cycleNumber.
let inFlight: Promise<void> | null = null;
let shuttingDown = false;

function buildPacket(
  symbol: string,
  candles: Awaited<ReturnType<typeof fetchOHLCV>>,
  ticker: Awaited<ReturnType<typeof fetchTicker>>,
  lastPrices: Map<string, number>,
): MarketStatePacket {
  const ind = computeIndicators(candles);
  const changes = computeChanges(candles, tfMinutes);
  const regime = classifyRegime(ind, ticker.last);
  const openPos = exchange.getOpenPositionSnapshot(symbol, ticker.last);
  return {
    symbol,
    timestamp: new Date().toISOString(),
    price: ticker.last,
    change_1h_pct: changes.change_1h_pct,
    change_4h_pct: changes.change_4h_pct,
    change_24h_pct: changes.change_24h_pct,
    rsi_14: ind.rsi_14,
    macd_histogram: ind.macd_histogram,
    ema200_distance_pct: ind.ema200_distance_pct,
    atr_14: ind.atr_14,
    volume_24h_usd: ticker.quoteVolume24h,
    regime,
    open_position: openPos,
    // E2: kill switches see realised + unrealised. equity_high_water stays
    // realised (a peak is a peak — not an MTM swing).
    equity_usd: exchange.markToMarket(lastPrices),
    equity_high_water: exchange.getHighWater(),
    daily_pnl_pct: exchange.getDailyPnlPctMTM(lastPrices),
    last_3_trades: getLast3TradesSummary(symbol),
  };
}

interface SymbolCycleResult {
  lastPrice: number;
  haltTriggered: boolean;
}

async function runSymbolCycle(
  symbol: string,
  cycleStart: number,
  lastPrices: Map<string, number>,
): Promise<SymbolCycleResult> {
  const [candles, ticker] = await Promise.all([
    fetchOHLCV(symbol),
    fetchTicker(symbol),
  ]);
  // Refresh this symbol's last price as soon as we have it, so MTM in
  // buildPacket sees a current quote (not the stale entry-price fallback).
  lastPrices.set(symbol, ticker.last);

  // Auto-close on stop-loss / take-profit using the LATEST CLOSED bar's
  // high/low. Mid-price-only checks miss intra-bar wicks.
  const lastBar = candles[candles.length - 1];
  const exitTrade = lastBar
    ? exchange.checkExits(symbol, {
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
      })
    : null;
  if (exitTrade) {
    logger.info(
      `Auto-exit ${symbol}: pnl=${exitTrade.pnlPct.toFixed(2)}% @ ${exitTrade.exitPrice}`,
    );
    insertTrade(exitTrade);
  }

  const packet = buildPacket(symbol, candles, ticker, lastPrices);
  const brain = costTracker.isExceeded()
    ? syntheticHold(
        symbol,
        `LLM_BUDGET_EXCEEDED: spent=$${costTracker.getSpentToday().toFixed(4)} budget=$${costTracker.getBudgetUsd()}`,
      )
    : await decide(packet);
  costTracker.add(brain.usage.cost_usd);

  // E1: dedupe per (symbol, action, candle window). Restart-safe and
  // race-safe vs the old (cycleNumber, symbol, action, stop, tp, size) key,
  // which collided on cycle #1 across restarts.
  const candleOpenMs = Math.floor(cycleStart / tfMs) * tfMs;
  const id = decisionId(symbol, brain.intent.action, candleOpenMs);
  const duplicate = decisionExists(id);

  const risk = evaluate({
    intent: brain.intent,
    packet,
    duplicateOrderId: duplicate,
  });

  // The risk engine may resize the LLM's proposed intent (C3 sizing
  // override). Use the engine-output intent for the fill and journal so
  // the trade log reflects what was actually executed; the original
  // LLM text is preserved separately in `raw_response`.
  const intentForFill = risk.intent ?? brain.intent;

  let fillPrice: number | undefined;
  let trade: typeof exitTrade = null;

  if (risk.verdict === "ACCEPT") {
    const fill = exchange.fill(
      intentForFill,
      { bid: ticker.bid, ask: ticker.ask, mid: ticker.midPrice },
      id,
    );
    fillPrice = fill.fillPrice;
    if (fill.trade) {
      trade = fill.trade;
      insertTrade(fill.trade);
    }
  }

  const record = {
    id,
    timestamp: packet.timestamp,
    symbol,
    market_state: packet,
    intent: intentForFill,
    risk_verdict: risk.verdict,
    reject_reason: risk.reason,
    fill_price: fillPrice,
    equity_after: exchange.getEquity(),
    model: CONFIG.LLM_MODEL,
    prompt_tokens: brain.usage.prompt_tokens,
    completion_tokens: brain.usage.completion_tokens,
    cycle_number: SNAPSHOT.cycleNumber,
    prompt_version: PROMPT_VERSION,
    system_prompt_hash: PROMPT_HASH,
    raw_response: brain.raw_response,
    cost_usd: brain.usage.cost_usd,
  };
  insertDecision(record);

  const snap: CycleSnapshot = {
    cycleStart,
    nextCycleAt: nextAlignedFire(),
    symbol,
    packet,
    intent: intentForFill,
    brain,
    verdict: risk.verdict,
    rejectReason: risk.reason,
    fillPrice,
    equityAfter: exchange.getEquity(),
    trade: trade ?? exitTrade ?? null,
    recentTrades: exchange.getRecentTrades(5),
    llmSpentTodayUsd: costTracker.getSpentToday(),
    llmBudgetUsd: costTracker.getBudgetUsd(),
    llmBudgetExceeded: costTracker.isExceeded(),
  };
  SNAPSHOT.lastCycle = snap;
  bus.emit("cycle", snap);

  logger.info(
    `cycle ${SNAPSHOT.cycleNumber} ${symbol} ${intentForFill.action} ` +
      `verdict=${risk.verdict}${risk.reason ? `(${risk.reason})` : ""} ` +
      `equity=${exchange.getEquity().toFixed(2)} ` +
      `tokens=${brain.usage.prompt_tokens}+${brain.usage.completion_tokens}`,
  );

  // Write-through persistence: one tiny upsert per symbol per cycle so a
  // hard kill never loses more than the in-flight LLM call's worth of state.
  // Cost is negligible vs the LLM call that just happened.
  savePaperState(exchange.exportState());

  return { lastPrice: ticker.last, haltTriggered: risk.verdict === "HALT" };
}

function flattenAllPositions(
  lastPrices: Map<string, number>,
  candleOpenMs: number,
): void {
  const forceId = decisionId("ALL", "FORCE_CLOSE", candleOpenMs);
  const forced = exchange.closeAll(lastPrices, forceId);
  for (const t of forced) {
    insertTrade(t);
    logger.error(
      `HALT-flatten ${t.symbol} ${t.side}: pnl=${t.pnlPct.toFixed(2)}% @ ${t.exitPrice}`,
    );
  }
  savePaperState(exchange.exportState());
}

async function runCycle(): Promise<void> {
  // Idempotent under concurrent calls: a second caller (e.g. dashboard force
  // key while the timer's cycle is mid-flight) awaits the in-progress one
  // instead of starting a parallel run.
  if (inFlight) return inFlight;
  if (halted) return;
  inFlight = (async () => {
    SNAPSHOT.cycleNumber++;
    const cycleStart = Date.now();
    const candleOpenMs = Math.floor(cycleStart / tfMs) * tfMs;
    const lastPrices = new Map<string, number>();

    for (const symbol of CONFIG.SYMBOLS) {
      if (halted) break;
      try {
        const res = await runSymbolCycle(symbol, cycleStart, lastPrices);
        lastPrices.set(symbol, res.lastPrice);
        if (res.haltTriggered) {
          halted = true;
          logger.error("MAX_DRAWDOWN reached — flattening all positions.");
          flattenAllPositions(lastPrices, candleOpenMs);
          break;
        }
      } catch (e) {
        const msg = (e as Error).message;
        SNAPSHOT.lastError = `${symbol}: ${msg}`;
        logger.error(`cycle error for ${symbol}: ${msg}`);
      }
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

// Absolute time of the next aligned cycle fire. Anchoring to the candle clock
// (not to "now + cycleMs") keeps the bot from drifting later and later as
// LLM latency accumulates.
function nextAlignedFire(now: number = Date.now()): number {
  return Math.ceil(now / tfMs) * tfMs + CYCLE_BUFFER_MS;
}

function scheduleNext(): void {
  if (halted || shuttingDown) return;
  const now = Date.now();
  const fireAt = nextAlignedFire(now);
  // Floor at 1s so a cycle that just finished doesn't immediately re-fire on
  // the same candle close.
  const delay = Math.max(1_000, fireAt - now);
  cycleTimer = setTimeout(async () => {
    await runCycle();
    scheduleNext();
  }, delay);
}

/**
 * E3: SIGTERM/SIGINT/SIGHUP arriving mid-cycle used to drop the cycle's
 * journal rows because shutdown ran synchronously and exited before the
 * in-flight runSymbolCycle could insert. Now we await the in-flight cycle
 * (max 30s grace, so a stuck LLM call can't hang shutdown forever) before
 * the final `savePaperState` and `closeDb`. Under systemd, set
 * `TimeoutStopSec=45` so the grace fits inside the default stop window.
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (cycleTimer) clearTimeout(cycleTimer);
  if (inFlight) {
    logger.info("shutdown: awaiting in-flight cycle (max 30s)…");
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((r) => setTimeout(r, 30_000)),
      ]);
    } catch (e) {
      logger.warn(
        `shutdown: in-flight cycle threw: ${(e as Error).message}`,
      );
    }
  }
  try {
    savePaperState(exchange.exportState());
  } catch (e) {
    logger.error(`shutdown: savePaperState failed: ${(e as Error).message}`);
  }
  closeDb();
  process.exit(0);
}

async function main(): Promise<void> {
  logger.info(
    `Starting crypto-agent-cli — symbols=${CONFIG.SYMBOLS.join(",")} ` +
      `tf=${CONFIG.TIMEFRAME} model=${CONFIG.LLM_MODEL}`,
  );
  // E5: replaces the dropped CYCLE_INTERVAL_MIN-vs-TIMEFRAME warning
  // (M28). Since the scheduler is anchored to candle close + buffer, there
  // is no separate cycle interval to compare against — describe what the
  // scheduler actually does.
  logger.info(
    `scheduler: aligned to ${CONFIG.TIMEFRAME} close + ${CYCLE_BUFFER_MS / 1000}s buffer`,
  );
  if (restored) {
    logger.info(
      `Restored paper state: equity=${restored.equity.toFixed(2)} ` +
        `positions=${restored.positions.length} day=${restored.currentDay}`,
    );
  }

  renderDashboard({
    onForceCycle: async () => {
      if (cycleTimer) clearTimeout(cycleTimer);
      await runCycle();
      scheduleNext();
    },
    onQuit: () => {
      void shutdown();
    },
  });

  await runCycle();
  scheduleNext();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    void shutdown();
  });
}

main().catch((e) => {
  logger.error(`fatal: ${(e as Error).message}`);
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
