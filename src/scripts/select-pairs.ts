// Generated from prompts/select-pairs.md. Re-run prompt to regenerate.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Thresholds (tune here) ────────────────────────────────────────────────────
const CFG = {
  ATR_MIN_PCT: 0.25,         // auto-reject: below this, cost drag exceeds edge
  ATR_MAX_PCT: 1.80,         // auto-reject: above this, 0.5% stops are noise-torched
  ATR_TARGET_PCT: 0.60,      // vol_fit_score gaussian peak
  ATR_SIGMA: 0.50,           // gaussian width
  VOL_24H_MIN_USD: 50e6,     // liquidity floor
  SPREAD_MAX_BPS: 5,         // top-of-book spread ceiling
  TOP_N_CANDIDATES: 30,      // klines fetched for this many pairs
  TOP_N_CORRELATION: 10,     // correlation matrix size
  CORR_MAX: 0.60,            // max pairwise correlation in multi mode
  MEAN_REVERSION_PENALTY_THRESH: -0.10,
  MEAN_REVERSION_PENALTY_FACTOR: 0.70,
  MAX_DD_RISK_PCT: 70,       // stability_score → 0 at this drawdown
  WEIGHTS: { liquidity: 0.20, vol_fit: 0.35, trend: 0.20, stability: 0.15, spread: 0.10 },
  STABLECOIN_BASES: new Set([
    "USDC", "FDUSD", "TUSD", "DAI", "BUSD", "USDP", "EUR", "EURI",
    "AEUR", "XUSD", "PYUSD", "RLUSD", "USDT",
  ]),
  LEVERAGE_SUFFIXES: ["UP", "DOWN", "BULL", "BEAR"] as const,
  RATE_LIMIT_MS: 100, // 10 req/s — well under Binance 1200 weight/min
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────
interface ExchangeSymbol { symbol: string; baseAsset: string; quoteAsset: string; status: string }
interface Ticker24h { symbol: string; bidPrice: string; askPrice: string; quoteVolume: string }
interface FilteredPair { binanceSymbol: string; symbol: string; vol24h_usd: number; spread_bps: number }
interface PrevOutput { recommended?: Array<{ symbol: string; score: number }> }

export interface Metrics {
  symbol: string;
  binanceSymbol: string;
  atr_15m_pct_avg30d: number;
  trend_persistence_pct: number;
  mean_reversion_score: number;
  vol24h_usd: number;
  spread_bps_median: number;
  max_dd_90d_pct: number;
}

export interface ScoredMetrics extends Metrics {
  score: number;
  subscores: { liquidity: number; vol_fit: number; trend: number; stability: number; spread: number };
  reject_reason?: string;
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../");
const DATA_DIR = join(ROOT, "data");
const CACHE_DIR = join(DATA_DIR, "cache", "klines");
const PAIR_JSON = join(DATA_DIR, "pair-selection.json");
const PAIR_MD = join(DATA_DIR, "pair-selection.md");

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix: string) => args.find(a => a.startsWith(prefix))?.split("=")[1];
  return {
    multi: Math.max(1, parseInt(get("--multi") ?? "1", 10)),
    noFetch: args.includes("--no-fetch"),
    top50: get("--universe") === "top50",
    quiet: args.includes("--quiet"),
  };
}

// ── Rate-limited fetch ────────────────────────────────────────────────────────
let lastFetchAt = 0;

async function rateFetch(url: string): Promise<Response> {
  const gap = CFG.RATE_LIMIT_MS - (Date.now() - lastFetchAt);
  if (gap > 0) await new Promise<void>(r => setTimeout(r, gap));
  lastFetchAt = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  return res;
}

// ── Kline cache ───────────────────────────────────────────────────────────────
function cachePath(binanceSymbol: string, interval: string): string {
  return join(CACHE_DIR, `${binanceSymbol}-${interval}-${new Date().toISOString().slice(0, 10)}.json`);
}

function loadCache(binanceSymbol: string, interval: string): unknown[][] | null {
  const p = cachePath(binanceSymbol, interval);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as unknown[][]; } catch { return null; }
}

function saveCache(binanceSymbol: string, interval: string, data: unknown[][]): void {
  writeFileSync(cachePath(binanceSymbol, interval), JSON.stringify(data));
}

// ── Binance REST ──────────────────────────────────────────────────────────────
async function fetchExchangeSymbols(): Promise<ExchangeSymbol[]> {
  const res = await rateFetch("https://api.binance.com/api/v3/exchangeInfo");
  return ((await res.json() as { symbols: ExchangeSymbol[] }).symbols);
}

async function fetchTickers24h(): Promise<Ticker24h[]> {
  return (await rateFetch("https://api.binance.com/api/v3/ticker/24hr")).json() as Promise<Ticker24h[]>;
}

async function fetchKlines(sym: string, interval: string, limit: number, endTime?: number): Promise<unknown[][]> {
  let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  if (endTime) url += `&endTime=${endTime}`;
  return (await rateFetch(url)).json() as Promise<unknown[][]>;
}

async function fetch30dKlines(binanceSym: string, noFetch: boolean): Promise<unknown[][]> {
  const cached = loadCache(binanceSym, "15m");
  if (cached) return cached;
  if (noFetch) return [];
  // 3 × 1000 bars × 15m ≈ 31.2 days
  const all: unknown[][] = [];
  let endTime: number | undefined;
  for (let i = 0; i < 3; i++) {
    const batch = await fetchKlines(binanceSym, "15m", 1000, endTime);
    if (batch.length === 0) break;
    all.unshift(...batch);
    endTime = Number((batch[0] as unknown[])[0] ?? 0) || undefined;
    if (!endTime) break;
  }
  if (all.length > 0) saveCache(binanceSym, "15m", all);
  return all;
}

async function fetch90dDailyKlines(binanceSym: string, noFetch: boolean): Promise<unknown[][]> {
  const cached = loadCache(binanceSym, "1d");
  if (cached) return cached;
  if (noFetch) return [];
  const candles = await fetchKlines(binanceSym, "1d", 90);
  if (candles.length > 0) saveCache(binanceSym, "1d", candles);
  return candles;
}

// ── Kline field accessor ──────────────────────────────────────────────────────
function hlc(row: unknown[]) {
  return {
    high: parseFloat(String(row[2] ?? "0")),
    low: parseFloat(String(row[3] ?? "0")),
    close: parseFloat(String(row[4] ?? "0")),
  };
}

// ── Metric computation (exported for tests) ───────────────────────────────────
export function computeATR(candles: unknown[][]): number {
  if (candles.length === 0) return 0;
  let sum = 0;
  for (const row of candles) {
    const { high, low, close } = hlc(row);
    sum += close > 0 ? ((high - low) / close) * 100 : 0;
  }
  return sum / candles.length;
}

export function computeTrendPersistence(candles: unknown[][]): number {
  if (candles.length < 5) return 0;
  const closes = candles.map(r => hlc(r).close);
  let streak = 1;
  let count = 0;
  for (let i = 2; i < closes.length; i++) {
    const curr = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const prev = (closes[i - 1] ?? 0) - (closes[i - 2] ?? 0);
    streak = (curr > 0 && prev > 0) || (curr < 0 && prev < 0) ? streak + 1 : 1;
    if (streak >= 4) count++;
  }
  return (count / (closes.length - 1)) * 100;
}

export function computeMeanReversion(candles: unknown[][]): number {
  if (candles.length < 12) return 0;
  const logR: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = hlc(candles[i - 1] ?? []).close;
    const c = hlc(candles[i] ?? []).close;
    if (p > 0 && c > 0) logR.push(Math.log(c / p));
  }
  if (logR.length < 10) return 0;
  const n = logR.length - 1;
  const x = logR.slice(0, n), y = logR.slice(1);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const num = x.reduce((s, v, i) => s + (v - mx) * ((y[i] ?? 0) - my), 0);
  const dx = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0));
  const dy = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0));
  return dx === 0 || dy === 0 ? 0 : num / (dx * dy);
}

export function computeMaxDrawdown(candles: unknown[][]): number {
  if (candles.length === 0) return 0;
  let peak = hlc(candles[0] ?? []).close;
  let maxDD = 0;
  for (const row of candles) {
    const c = hlc(row).close;
    if (c > peak) peak = c;
    const dd = peak > 0 ? ((peak - c) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function clip(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

function autoReject(m: Metrics, reason: string): ScoredMetrics {
  return { ...m, score: 0, subscores: { liquidity: 0, vol_fit: 0, trend: 0, stability: 0, spread: 0 }, reject_reason: reason };
}

export function scoreCandidate(m: Metrics): ScoredMetrics {
  if (m.atr_15m_pct_avg30d < CFG.ATR_MIN_PCT)
    return autoReject(m, `ATR ${m.atr_15m_pct_avg30d.toFixed(2)}% below ${CFG.ATR_MIN_PCT}% cost floor`);
  if (m.atr_15m_pct_avg30d > CFG.ATR_MAX_PCT)
    return autoReject(m, `ATR ${m.atr_15m_pct_avg30d.toFixed(2)}% above ${CFG.ATR_MAX_PCT}% stop-noise ceiling`);
  if (m.vol24h_usd < CFG.VOL_24H_MIN_USD)
    return autoReject(m, `24h vol $${(m.vol24h_usd / 1e6).toFixed(0)}M below $50M floor`);
  if (m.spread_bps_median > CFG.SPREAD_MAX_BPS)
    return autoReject(m, `Spread ${m.spread_bps_median.toFixed(1)} bps above ${CFG.SPREAD_MAX_BPS} bps ceiling`);

  const liquidity = clip(Math.log10(m.vol24h_usd / 50e6) / 3, 0, 1);
  const atrDelta  = (m.atr_15m_pct_avg30d - CFG.ATR_TARGET_PCT) / CFG.ATR_SIGMA;
  const vol_fit   = Math.exp(-(atrDelta ** 2));
  const trend     = clip((m.trend_persistence_pct - 20) / 25, 0, 1);
  const stability = clip(1 - m.max_dd_90d_pct / CFG.MAX_DD_RISK_PCT, 0, 1);
  const spread    = clip(1 - m.spread_bps_median / CFG.SPREAD_MAX_BPS, 0, 1);
  const subscores = { liquidity, vol_fit, trend, stability, spread };

  let total = CFG.WEIGHTS.liquidity * liquidity
            + CFG.WEIGHTS.vol_fit   * vol_fit
            + CFG.WEIGHTS.trend     * trend
            + CFG.WEIGHTS.stability * stability
            + CFG.WEIGHTS.spread    * spread;

  if (m.mean_reversion_score < CFG.MEAN_REVERSION_PENALTY_THRESH)
    total *= CFG.MEAN_REVERSION_PENALTY_FACTOR;

  return { ...m, score: Math.round(total * 1000) / 1000, subscores };
}

// ── Correlation ───────────────────────────────────────────────────────────────
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const ax = a.slice(0, n), bx = b.slice(0, n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  const num = ax.reduce((s, v, i) => s + (v - ma) * ((bx[i] ?? 0) - mb), 0);
  const da = Math.sqrt(ax.reduce((s, v) => s + (v - ma) ** 2, 0));
  const db = Math.sqrt(bx.reduce((s, v) => s + (v - mb) ** 2, 0));
  return da === 0 || db === 0 ? 0 : Math.round((num / (da * db)) * 1000) / 1000;
}

function dailyLogReturns(candles: unknown[][]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = hlc(candles[i - 1] ?? []).close;
    const c = hlc(candles[i] ?? []).close;
    if (p > 0 && c > 0) out.push(Math.log(c / p));
  }
  return out;
}

// ── Markdown report ───────────────────────────────────────────────────────────
function buildRationale(m: ScoredMetrics): string {
  const parts: string[] = [];
  if (m.vol24h_usd > 1e9) parts.push(`$${(m.vol24h_usd / 1e9).toFixed(1)}B 24h liquidity`);
  parts.push(`${m.atr_15m_pct_avg30d.toFixed(2)}% 15m ATR in tradeable range`);
  if (m.trend_persistence_pct >= 25)
    parts.push(`${m.trend_persistence_pct.toFixed(0)}% trend persistence favours directional LLM calls`);
  if (m.mean_reversion_score < CFG.MEAN_REVERSION_PENALTY_THRESH)
    parts.push(`mean-reversion penalty applied (autocorr ${m.mean_reversion_score.toFixed(2)})`);
  return parts.join(". ") + ".";
}

function buildMarkdown(
  ranked: ScoredMetrics[], recommended: ScoredMetrics[], watchlist: ScoredMetrics[],
  avoided: ScoredMetrics[], corrSymbols: string[], corrMatrix: number[][],
  prevRun: PrevOutput | null, meta: { universeSize: number; filteredCount: number; generatedAt: string },
): string {
  const L: string[] = [];
  const top = recommended[0];

  L.push("# Pair Selection Report");
  L.push(`**Generated:** ${meta.generatedAt}  |  Universe: ${meta.universeSize}  |  Candidates: ${meta.filteredCount}`);
  L.push("");
  L.push("## TL;DR");
  if (top) {
    L.push(`**Recommendation: ${top.symbol}** — score=${top.score.toFixed(3)}`);
    L.push(`- ATR: ${top.atr_15m_pct_avg30d.toFixed(2)}% | Trend persistence: ${top.trend_persistence_pct.toFixed(0)}%`);
    L.push(`- Volume: $${(top.vol24h_usd / 1e9).toFixed(2)}B | Spread: ${top.spread_bps_median.toFixed(2)} bps | MaxDD 90d: ${top.max_dd_90d_pct.toFixed(1)}%`);
    L.push(`- Autocorr (mean reversion): ${top.mean_reversion_score.toFixed(3)}`);
  } else {
    L.push("No pairs met all hard constraints this run.");
  }
  L.push("");

  // Score deltas vs previous run
  if (prevRun?.recommended?.length) {
    const demotions = prevRun.recommended.filter(p => {
      const cur = ranked.find(r => r.symbol === p.symbol);
      return cur && cur.score < p.score - 0.05 && !recommended.some(r => r.symbol === p.symbol);
    });
    if (demotions.length > 0) {
      L.push("## Changes from Last Run");
      for (const d of demotions) {
        const cur = ranked.find(r => r.symbol === d.symbol);
        if (!cur) continue;
        const dest = watchlist.some(w => w.symbol === d.symbol) ? "watchlist" : "avoid";
        L.push(`- **${d.symbol}**: ${d.score.toFixed(3)} → ${cur.score.toFixed(3)}, demoted to ${dest}`);
      }
      L.push("");
    }
  }

  // Top-10 table
  L.push("## Top-10 Ranking");
  L.push("");
  L.push("| # | Symbol | Score | ATR% | Trend% | Autocorr | Vol $B | Spread bps | MaxDD% |");
  L.push("|---|--------|-------|------|--------|----------|--------|------------|--------|");
  ranked.slice(0, 10).forEach((m, i) => {
    L.push(`| ${i + 1} | ${m.symbol} | **${m.score.toFixed(3)}** | ${m.atr_15m_pct_avg30d.toFixed(2)} | ${m.trend_persistence_pct.toFixed(0)} | ${m.mean_reversion_score.toFixed(3)} | ${(m.vol24h_usd / 1e9).toFixed(1)} | ${m.spread_bps_median.toFixed(2)} | ${m.max_dd_90d_pct.toFixed(1)} |`);
  });
  L.push("");

  // Correlation matrix (top 5)
  if (corrSymbols.length >= 2) {
    const syms = corrSymbols.slice(0, 5);
    const sub  = corrMatrix.slice(0, 5).map(row => row.slice(0, 5));
    L.push("## Correlation Matrix (Top 5, 90d daily returns)");
    L.push("");
    L.push("| | " + syms.join(" | ") + " |");
    L.push("|" + syms.map(() => "---|").join("") + "---|");
    syms.forEach((sym, i) => {
      L.push(`| **${sym}** | ` + syms.map((_, j) => (sub[i]?.[j] ?? 0).toFixed(2)).join(" | ") + " |");
    });
    L.push("");
  }

  // Why not notable pairs
  const notable = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];
  const lowOrAvoided = notable.filter(s => {
    const r = [...ranked, ...avoided].find(x => x.symbol === s);
    return r && (r.score < 0.5 || r.reject_reason);
  });
  if (lowOrAvoided.length > 0) {
    L.push("## Why Not...");
    for (const sym of lowOrAvoided) {
      const f = [...ranked, ...avoided].find(x => x.symbol === sym);
      if (f) L.push(`- **${sym}**: ${f.reject_reason ?? `score ${f.score.toFixed(3)} below 0.50`}`);
    }
    L.push("");
  }

  if (watchlist.length > 0) {
    L.push("## Watchlist");
    watchlist.forEach(w => {
      L.push(`- **${w.symbol}** (score=${w.score.toFixed(3)}): ATR ${w.atr_15m_pct_avg30d.toFixed(2)}%, MaxDD ${w.max_dd_90d_pct.toFixed(1)}%`);
    });
    L.push("");
  }

  if (avoided.length > 0) {
    L.push("## Avoid This Run");
    avoided.slice(0, 10).forEach(a => {
      L.push(`- **${a.symbol}**: ${a.reject_reason ?? `score ${a.score.toFixed(3)}`}`);
    });
    L.push("");
  }

  L.push("---");
  L.push("*Method: prompts/select-pairs.md*");
  return L.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const args = parseArgs();

  let prevRun: PrevOutput | null = null;
  if (existsSync(PAIR_JSON)) {
    try { prevRun = JSON.parse(readFileSync(PAIR_JSON, "utf8")) as PrevOutput; } catch { /* stale ok */ }
  }

  // 1. Universe
  process.stderr.write("[select-pairs] Fetching exchange info…\n");
  const allSymbols = await fetchExchangeSymbols();
  const baseByBinance = new Map<string, string>();
  const eligible = allSymbols.filter(s => {
    if (s.status !== "TRADING" || s.quoteAsset !== "USDT") return false;
    if (CFG.STABLECOIN_BASES.has(s.baseAsset)) return false;
    if ((CFG.LEVERAGE_SUFFIXES as readonly string[]).some(suf => s.baseAsset.endsWith(suf))) return false;
    baseByBinance.set(s.symbol, s.baseAsset);
    return true;
  });
  const universeSize = eligible.length;

  // 2. Volume + spread filter
  process.stderr.write("[select-pairs] Fetching 24h tickers…\n");
  const tickerMap = new Map((await fetchTickers24h()).map(t => [t.symbol, t]));

  const volumeFiltered: FilteredPair[] = eligible
    .map(s => {
      const t = tickerMap.get(s.symbol);
      if (!t) return null;
      const vol = parseFloat(t.quoteVolume);
      const bid = parseFloat(t.bidPrice);
      const ask = parseFloat(t.askPrice);
      const mid = (bid + ask) / 2;
      const spread_bps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 999;
      if (vol < CFG.VOL_24H_MIN_USD || spread_bps > CFG.SPREAD_MAX_BPS) return null;
      const base = baseByBinance.get(s.symbol) ?? s.symbol.replace("USDT", "");
      return { binanceSymbol: s.symbol, symbol: `${base}/USDT`, vol24h_usd: vol, spread_bps };
    })
    .filter((x): x is FilteredPair => x !== null)
    .sort((a, b) => b.vol24h_usd - a.vol24h_usd);

  const pool       = args.top50 ? volumeFiltered.slice(0, 50) : volumeFiltered;
  const candidates = pool.slice(0, CFG.TOP_N_CANDIDATES);

  if (candidates.length < 5) {
    writeFileSync(PAIR_JSON, JSON.stringify({ error: "universe_too_small", diagnostics: { universeSize, afterVolumeSpreadFilter: volumeFiltered.length, candidates: candidates.length } }, null, 2));
    process.stderr.write("[select-pairs] ERROR: universe too small after filtering\n");
    process.exit(1);
  }

  // 3. Fetch klines + compute metrics
  process.stderr.write(`[select-pairs] Fetching 15m klines for ${candidates.length} pairs…\n`);
  const metricsAll: Metrics[] = [];

  for (const cand of candidates) {
    const k15 = await fetch30dKlines(cand.binanceSymbol, args.noFetch);
    const k1d = await fetch90dDailyKlines(cand.binanceSymbol, args.noFetch);
    if (k15.length < 100) {
      metricsAll.push({ symbol: cand.symbol, binanceSymbol: cand.binanceSymbol, atr_15m_pct_avg30d: 0, trend_persistence_pct: 0, mean_reversion_score: 0, vol24h_usd: cand.vol24h_usd, spread_bps_median: cand.spread_bps, max_dd_90d_pct: 100 });
      continue;
    }
    metricsAll.push({
      symbol: cand.symbol, binanceSymbol: cand.binanceSymbol,
      atr_15m_pct_avg30d:   computeATR(k15),
      trend_persistence_pct: computeTrendPersistence(k15),
      mean_reversion_score:  computeMeanReversion(k15),
      vol24h_usd:            cand.vol24h_usd,
      spread_bps_median:     cand.spread_bps,
      max_dd_90d_pct:        computeMaxDrawdown(k1d.length > 0 ? k1d : k15),
    });
  }

  // 4. Score + sort
  const scored   = metricsAll.map(m => scoreCandidate(m));
  const accepted = scored.filter(s => !s.reject_reason && s.score > 0).sort((a, b) => b.score - a.score);
  const avoided  = scored.filter(s => !!s.reject_reason);

  // 5. Correlation matrix
  process.stderr.write("[select-pairs] Computing correlation matrix…\n");
  const corrPool    = accepted.slice(0, CFG.TOP_N_CORRELATION);
  const returnsMap  = new Map<string, number[]>();
  for (const m of corrPool) {
    returnsMap.set(m.symbol, dailyLogReturns(await fetch90dDailyKlines(m.binanceSymbol, args.noFetch)));
  }

  const corrSymbols = corrPool.map(m => m.symbol);
  const corrMatrix: number[][] = corrSymbols.map((a, i) =>
    corrSymbols.map((b, j) => i === j ? 1 : pearson(returnsMap.get(a) ?? [], returnsMap.get(b) ?? []))
  );

  const corrWarnings = corrSymbols.flatMap((a, i) =>
    corrSymbols.slice(i + 1).map((b, jj) => {
      const c = corrMatrix[i]?.[i + 1 + jj] ?? 0;
      return Math.abs(c) > CFG.CORR_MAX
        ? { pair_a: a, pair_b: b, corr_90d_daily_returns: c, advice: `Do not run both without gross-exposure cap (corr=${c.toFixed(2)}).` }
        : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null)
  );

  // 6. Select recommendations (correlation-constrained)
  const recommendations: ScoredMetrics[] = [];
  for (const cand of accepted.slice(0, 10)) {
    if (recommendations.length >= args.multi) break;
    const tooCorr = recommendations.some(prev =>
      Math.abs(pearson(returnsMap.get(cand.symbol) ?? [], returnsMap.get(prev.symbol) ?? [])) >= CFG.CORR_MAX
    );
    if (!tooCorr) recommendations.push(cand);
  }

  const watchlist = accepted.filter(m => !recommendations.some(r => r.symbol === m.symbol)).slice(0, 5);

  // 7. Write outputs
  const generatedAt = new Date().toISOString();
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const fmtMetrics = (m: ScoredMetrics) => ({
    atr_15m_pct_avg30d:    r3(m.atr_15m_pct_avg30d),
    trend_persistence_pct: r3(m.trend_persistence_pct),
    mean_reversion_score:  r3(m.mean_reversion_score),
    vol24h_usd:            Math.round(m.vol24h_usd),
    spread_bps_median:     r3(m.spread_bps_median),
    max_dd_90d_pct:        r3(m.max_dd_90d_pct),
  });

  writeFileSync(PAIR_JSON, JSON.stringify({
    generated_at:      generatedAt,
    universe_size:     universeSize,
    filtered_count:    candidates.length,
    recommended:       recommendations.map(m => ({ symbol: m.symbol, score: m.score, metrics: fmtMetrics(m), rationale: buildRationale(m) })),
    watchlist:         watchlist.map(m => ({ symbol: m.symbol, score: m.score, metrics: fmtMetrics(m), note: `Score ${m.score.toFixed(3)}. Monitor for next run.` })),
    avoid_this_run:    avoided.slice(0, 20).map(m => ({ symbol: m.symbol, score: m.score, reason: m.reject_reason })),
    correlation_warnings: corrWarnings,
  }, null, 2));

  if (!args.quiet)
    writeFileSync(PAIR_MD, buildMarkdown(accepted, recommendations, watchlist, avoided, corrSymbols, corrMatrix, prevRun, { universeSize, filteredCount: candidates.length, generatedAt }));

  const recStr = recommendations.map(r => `${r.symbol} score=${r.score.toFixed(2)}`).join(", ") || "none";
  const wlStr  = watchlist.slice(0, 3).map(w => w.symbol).join(",") || "none";
  const avStr  = avoided.slice(0, 3).map(a => a.symbol).join(",") || "none";
  // eslint-disable-next-line no-console
  console.log(`pair-selection ${generatedAt.slice(0, 10)}: ${recStr}  watchlist=${wlStr}  avoid=${avStr}  full=${PAIR_MD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    process.stderr.write(`[select-pairs] fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
