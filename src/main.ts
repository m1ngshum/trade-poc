import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { fetchOHLCV, fetchTicker } from "./data/market.js";
import {
  computeChanges,
  computeIndicators,
  timeframeMinutes,
} from "./data/indicators.js";
import { classifyRegime } from "./data/regime.js";
import { decide } from "./agent/brain.js";
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
} from "./journal/db.js";
import { bus, SNAPSHOT, type CycleSnapshot } from "./state.js";
import { renderDashboard } from "./ui/dashboard.js";

const exchange = new PaperExchange();
const tfMinutes = timeframeMinutes(CONFIG.TIMEFRAME);
const cycleMs = CONFIG.CYCLE_INTERVAL_MIN * 60_000;

let halted = false;
let cycleTimer: NodeJS.Timeout | null = null;

function buildPacket(
  symbol: string,
  candles: Awaited<ReturnType<typeof fetchOHLCV>>,
  ticker: Awaited<ReturnType<typeof fetchTicker>>,
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
    equity_usd: exchange.getEquity(),
    daily_pnl_pct: exchange.getDailyPnlPct(),
    last_3_trades: getLast3TradesSummary(symbol),
  };
}

async function runSymbolCycle(symbol: string, cycleStart: number): Promise<void> {
  const [candles, ticker] = await Promise.all([
    fetchOHLCV(symbol),
    fetchTicker(symbol),
  ]);

  // Auto-close on stop-loss / take-profit before asking the LLM.
  const exitTrade = exchange.checkExits(symbol, ticker.last);
  if (exitTrade) {
    logger.info(
      `Auto-exit ${symbol} at ${ticker.last}: pnl=${exitTrade.pnlPct.toFixed(2)}%`,
    );
    insertTrade(exitTrade);
  }

  const packet = buildPacket(symbol, candles, ticker);
  const brain = await decide(packet);

  const id = decisionId(symbol, brain.intent.action, packet.timestamp);
  const duplicate = decisionExists(id);

  const risk = evaluate({
    intent: brain.intent,
    packet,
    duplicateOrderId: duplicate,
  });

  let fillPrice: number | undefined;
  let trade: typeof exitTrade = null;

  if (risk.verdict === "ACCEPT") {
    const fill = exchange.fill(brain.intent, ticker.midPrice, id);
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
    intent: brain.intent,
    risk_verdict: risk.verdict,
    reject_reason: risk.reason,
    fill_price: fillPrice,
    equity_after: exchange.getEquity(),
    model: CONFIG.LLM_MODEL,
    prompt_tokens: brain.usage.prompt_tokens,
    completion_tokens: brain.usage.completion_tokens,
  };
  insertDecision(record);

  const snap: CycleSnapshot = {
    cycleStart,
    nextCycleAt: cycleStart + cycleMs,
    symbol,
    packet,
    intent: brain.intent,
    brain,
    verdict: risk.verdict,
    rejectReason: risk.reason,
    fillPrice,
    equityAfter: exchange.getEquity(),
    trade: trade ?? exitTrade ?? null,
    recentTrades: exchange.getRecentTrades(5),
  };
  SNAPSHOT.lastCycle = snap;
  bus.emit("cycle", snap);

  logger.info(
    `cycle ${SNAPSHOT.cycleNumber} ${symbol} ${brain.intent.action} ` +
      `verdict=${risk.verdict}${risk.reason ? `(${risk.reason})` : ""} ` +
      `equity=${exchange.getEquity().toFixed(2)} ` +
      `tokens=${brain.usage.prompt_tokens}+${brain.usage.completion_tokens}`,
  );

  if (risk.verdict === "HALT") {
    halted = true;
    logger.error("MAX_DRAWDOWN reached — halting loop.");
  }
}

async function runCycle(): Promise<void> {
  if (halted) return;
  SNAPSHOT.cycleNumber++;
  const cycleStart = Date.now();

  for (const symbol of CONFIG.SYMBOLS) {
    if (halted) break;
    try {
      await runSymbolCycle(symbol, cycleStart);
    } catch (e) {
      const msg = (e as Error).message;
      SNAPSHOT.lastError = `${symbol}: ${msg}`;
      logger.error(`cycle error for ${symbol}: ${msg}`);
    }
  }
}

function scheduleNext(): void {
  if (halted) return;
  cycleTimer = setTimeout(async () => {
    await runCycle();
    scheduleNext();
  }, cycleMs);
}

async function main(): Promise<void> {
  logger.info(
    `Starting crypto-agent-cli — symbols=${CONFIG.SYMBOLS.join(",")} ` +
      `tf=${CONFIG.TIMEFRAME} interval=${CONFIG.CYCLE_INTERVAL_MIN}m model=${CONFIG.LLM_MODEL}`,
  );

  renderDashboard({
    onForceCycle: async () => {
      if (cycleTimer) clearTimeout(cycleTimer);
      await runCycle();
      scheduleNext();
    },
    onQuit: () => {
      if (cycleTimer) clearTimeout(cycleTimer);
      closeDb();
      process.exit(0);
    },
  });

  await runCycle();
  scheduleNext();
}

process.on("SIGINT", () => {
  if (cycleTimer) clearTimeout(cycleTimer);
  closeDb();
  process.exit(0);
});

main().catch((e) => {
  logger.error(`fatal: ${(e as Error).message}`);
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
