# `trade-poc` audit — May 2026

This document is a code-grounded review of the `m1ngshum/trade-poc` paper-trading bot. Every claim points to a real file and line. Findings are tagged:

- `[FIXED]` — patched in this PR.
- `[DEFERRED]` — intentionally not fixed in this PR; explained below.
- `[BLOCKED]` — cannot be fixed until the missing data layer (`src/data/{market,indicators,regime}.ts`) ships.

A separate **Strengths** section calls out things the code already gets right that a generic checklist might miss.

## Methodology

Read every TypeScript file under `src/` plus `package.json`, `tsconfig.json`, `.env.example`, and `.gitignore`. Did not run the bot live (no exchange credentials, and the data layer doesn't exist anyway). Verified against `npm run typecheck` (baseline = 3 pre-existing errors, all from the missing data layer) and against the new `npm test` suite added by this PR.

## Architecture in one cycle

```
SIGINT/quit ─────────────────────────────────────────────────┐
                                                             ▼
main.ts: setTimeout loop
  └─> data/market.ts       ❌ MISSING — fetches OHLCV + ticker via CCXT
  └─> exchange.checkExits() ─ between-cycle SL/TP check ─────► SQLite trades row
  └─> data/indicators.ts   ❌ MISSING — RSI/MACD/EMA200/ATR
  └─> data/regime.ts       ❌ MISSING — trending/ranging/volatile classifier
  └─> agent/brain.ts       ─ N self-consistency samples ────► LLM provider
       │                                                        │
       │                                                        ▼
       │                                                  agent/providers/{claude-cli,openrouter}.ts
       ▼
  agent/cost-tracker.ts    ─ UTC daily budget gate         (synthetic HOLD if exceeded)
  risk/engine.ts           ─ deterministic guardrails ──── ► verdict
  exchange/paper.ts        ─ in-memory positions, fees, equity
  journal/db.ts            ─ SQLite (WAL) decisions + trades
  state.ts → bus.emit("cycle") → ui/dashboard.tsx (Ink)
```

## Critical findings

### C1 — Build is broken: data layer missing  `[BLOCKED]`

`src/main.ts:3-9` imports `./data/market.js`, `./data/indicators.js`, `./data/regime.js`. None of these files exist. `npm run typecheck` produces:

```
src/main.ts(3,41): error TS2307: Cannot find module './data/market.js'
src/main.ts(8,8):  error TS2307: Cannot find module './data/indicators.js'
src/main.ts(9,32): error TS2307: Cannot find module './data/regime.js'
```

That means **the bot does not currently run.** `package.json` already declares `ccxt@^4.5.0` and `trading-signals@^7.0.0`, so the intent is clear; the files just aren't checked in. Recommend a follow-up PR that ships the data layer with attention to:

- Drop the in-progress live candle (`ohlcv.slice(0, -1)`) before computing indicators.
- Fetch `limit ≥ 250` so the EMA200 has the closes it needs.
- Gate trading on `closed_candles.length >= 200` (warm-up).
- Wrap CCXT calls in retry-with-backoff for `NetworkError`/`RateLimitExceeded`/`ExchangeNotAvailable`.
- Return `bid` and `ask` from the ticker so `paper.ts` can model the spread.

### C2 — Confidence threshold lived only in the prompt  `[FIXED]`

`src/agent/prompt.ts` instructed the model: *"If confidence < 0.6, return HOLD."* But `src/risk/engine.ts` never compared `confidence` to any threshold. A model that ignored the instruction passed straight through to `paper.fill()`.

Fixed by adding `MIN_CONFIDENCE` to `src/config.ts:33` and a `LOW_CONFIDENCE` reject in `src/risk/engine.ts:55-61`.

### C3 — Position size is flat-% of equity, not stop-distance-based  `[DEFERRED]`

`src/exchange/paper.ts:183` computes `sizeUsd = (intent.size_pct_of_equity / 100) * equityAtOpen`. With `MAX_POSITION_PCT=20` and a wide stop, the trade risks too much; with a tight stop, too little. Real risk-managed sizing is `equity * RISK_PCT_PER_TRADE / stop_distance`, which produces consistent dollar-risk per trade.

Deferred because the fix changes the meaning of `Intent.size_pct_of_equity` and requires coordinated changes to the prompt, schema, risk engine, and paper exchange. Worth its own design discussion.

### C4 — Stop-loss and take-profit are checked between cycles, not intra-bar  `[BLOCKED]`

`src/exchange/paper.ts:213-227` reacts to `lastPrice` at cycle start. With `CYCLE_INTERVAL_MIN=15` (`src/config.ts:17`), a wick that punches through the stop and recovers will exit at whatever `last` happens to be 15 minutes later — which can be far past the stop, or past the take-profit, depending on direction.

Blocked: realistic intra-bar simulation requires the candle highs/lows from the missing data layer.

### C5 — Default taker fee was half of Binance reality  `[FIXED]`

`src/exchange/paper.ts:7` had `TAKER_FEE = 0.0005` (5 bps). Binance spot taker is 10 bps. The 2× understatement made every backtest look better than live.

Fixed to `0.001` and exported for tests. Documented at the constant.

### C6 — `feePaidUsd` reporting bug  `[FIXED]`

`src/exchange/paper.ts:142` (pre-fix) set `feePaidUsd: trade.pnlUsd < 0 ? -trade.pnlUsd * TAKER_FEE : trade.pnlUsd * TAKER_FEE`. Fees are charged on **notional**, not on `|PnL|`. Equity math at `src/exchange/paper.ts:201` was already correct (`pos.sizeUsd * TAKER_FEE`); the bug only affected the `FillResult.feePaidUsd` field used by callers and analytics.

Fixed at `src/exchange/paper.ts:175`. Regression test in `tests/paper.test.ts`.

### C7 — `decisionExists` dedupe was effectively dead code  `[FIXED]`

Pre-fix `decisionId(symbol, action, timestamp)` at `src/journal/db.ts:54-62` hashed `new Date().toISOString()` from `src/main.ts:43`. Two cycles at different moments could not collide, so the `DUPLICATE_ORDER` reject (`src/risk/engine.ts:70` pre-fix) only fired on a same-millisecond re-run — essentially never. The intent was crash-restart idempotency; the implementation didn't deliver it.

Fixed by changing the signature to `decisionId(cycleNumber, symbol, action, stop, tp, size)` (`src/journal/db.ts:54-82`) and plumbing `SNAPSHOT.cycleNumber` from `src/main.ts:88-96`. Now a re-run that issues the same intent in the same cycle is detected; an unintended distinct decision still gets a fresh id.

### C8 — Prompt and raw response not journaled  `[FIXED]`

`src/journal/db.ts` (pre-fix) stored the parsed intent and the market_state but not the system prompt, the raw model output, or any version tag. Once `src/agent/prompt.ts` was edited, you couldn't replay an old decision.

Fixed by:
- Adding `PROMPT_VERSION` and `systemPromptHash()` exports in `src/agent/prompt.ts`.
- Bubbling `raw_response` through `src/agent/brain.ts` (interface + sites).
- Adding columns `cycle_number`, `prompt_version`, `system_prompt_hash`, `raw_response`, `cost_usd` to the `decisions` table in `src/journal/db.ts:71-91` with a migration block (`PRAGMA table_info` + `ALTER TABLE`) that covers existing user journals.
- Filling them in from `src/main.ts:113-128`.

## High findings

### H9 — Zod schemas accepted extra fields silently  `[FIXED]`

`src/agent/schema.ts` did not call `.strict()` on `IntentSchema`, `MarketStatePacketSchema`, `OpenPositionSchema`, or `Last3TradeSchema`. A hallucinated extra field like `liquidate_all: true` was silently dropped instead of rejected.

Fixed by appending `.strict()` to each schema. Regression test: `tests/risk.test.ts` line `"hallucinated extra field → SCHEMA_INVALID reject (Zod strict)"`.

### H10 — Symbol allow-list lives only in the risk engine  `[DEFERRED]`

`src/risk/engine.ts:35` checks `CONFIG.SYMBOLS.includes(i.symbol)`. The schema does not. An LLM hallucinating `"BTC"` (no slash) gets a clean reject rather than a clean accept on the intended symbol. A cleaner design would drop `symbol` from the LLM's response shape and inject it server-side from `packet.symbol`. Schema-shape change, deferred.

### H11 — No daily LLM cost cap  `[FIXED]`

Pre-fix, `src/agent/providers/claude-cli.ts:142` extracted `total_cost_usd` and `src/agent/brain.ts:104-107` accumulated it per cycle, but there was no hard ceiling. A pricing bug or a stuck cycle loop (e.g. force-cycle hotkey held down) could spend real money without alerting.

Fixed by:
- Adding `LLM_DAILY_BUDGET_USD` to `src/config.ts:34` (default `5`).
- Creating `src/agent/cost-tracker.ts` with UTC-daily reset.
- Short-circuiting `runSymbolCycle` to a synthetic HOLD when the budget is exceeded (`src/main.ts:79-85`, helper `syntheticHold` in `src/agent/brain.ts:155-164`).
- Surfacing budget state on the dashboard (`src/state.ts`, `src/ui/dashboard.tsx`).

### H12 — Subprocess timeout 90s is generous  `[DEFERRED]`

`src/agent/providers/claude-cli.ts:23`. With `SELF_CONSISTENCY_N=3` running in parallel, a stuck Claude can stall a cycle for 90s. 30s is plenty for non-thinking modes. Tunable, not a bug — left as-is.

### H13 — `--max-turns` not pinned on the Claude CLI  `[FIXED]`

`src/agent/providers/claude-cli.ts:52-72` (pre-fix) did not pass `--max-turns`. Empty `--allowedTools ""` already prevents tool use, but `--max-turns 1` is belt-and-braces against any unexpected agentic behavior.

Fixed at `src/agent/providers/claude-cli.ts:60-61`.

### H14 — Cycle is not aligned to candle close  `[BLOCKED]`

`src/main.ts:163-169` sleeps `cycleMs` from end-of-cycle, so over hours the cycle drifts relative to the candle clock. With `TIMEFRAME=15m` and `CYCLE_INTERVAL_MIN=15` the bot can run on indicators computed mid-bar.

Blocked on the data layer — `timeframeMinutes(...)` lives in the missing `src/data/indicators.ts`.

### H15 — JS `number` for all money math  `[DEFERRED]`

`src/exchange/paper.ts` uses IEEE 754 `number` for equity, position size, fees, and PnL. After thousands of cycles, drift produces phantom satoshi-scale positions and off-by-cent daily PnL.

Deferred: a `Decimal.js` (or `big.js`) migration touches every money site and warrants its own PR with thorough tests. Mitigation in the meantime: every realised PnL flows through one path (`closePosition` at `src/exchange/paper.ts:233`) and could be quantized there as a stop-gap.

### H16 — Daily PnL rollover edge case  `[FIXED]`

Pre-fix, `src/exchange/paper.ts:59-65`'s `rolloverIfNewDay()` reset `dayStartEquity` without recording yesterday's daily PnL. A fill at 23:59:59 UTC followed by a read at 00:00:01 UTC would silently zero the realised day.

Fixed by capturing each completed day's start/end into `dailyPnlHistory` before zeroing (`src/exchange/paper.ts:80-91`), exposed via `getDailyPnlHistory()`. Regression test in `tests/paper.test.ts`.

### H17 — `sizePct` recorded against post-fill equity  `[FIXED]`

Pre-fix, `closePosition` at `src/exchange/paper.ts:212` used the (drifted) `this.equity` to compute `sizePct`. A position that lost half its value reported a `sizePct` higher than what was actually risked at entry — wrong attribution.

Fixed by snapshotting `equityAtOpen` on the `Position` (`src/exchange/paper.ts:181-200`) and using it for `sizePct` (`src/exchange/paper.ts:245-247`). Regression test in `tests/paper.test.ts`.

### H18 — No state persistence across restarts  `[DEFERRED]`

`src/main.ts:25` instantiates `new PaperExchange()` fresh on every boot. Open positions, realised PnL, and `dayStartEquity` are lost. Combined with the old timestamp-based `decisionId`, you couldn't even detect a restart-mid-position from the journal.

Deferred: the right fix needs design — do we reload positions and continue, or refuse to start with an unclosed position and warn the operator? Both are reasonable. Out of scope for this PR.

### H19 — Fills at deterministic mid, no slippage or spread  `[BLOCKED]`

`src/main.ts:92` passes `ticker.midPrice` to `fill()`. Realistic paper trading: market BUY at ask, market SELL at bid, plus an ATR-scaled slippage term. Blocked on the data layer (need `ticker.bid`/`ticker.ask`).

### H20 — Engine check ordering buried the real reject reason  `[FIXED]`

Pre-fix, `src/risk/engine.ts:65` placed the daily-loss limit *after* size and stop-loss checks. A malformed intent submitted after the daily limit was hit got rejected with "SIZE_CAP" or "STOP_LOSS_MISSING" instead of "DAILY_LOSS_LIMIT" — making it hard to spot the actual operating constraint in logs.

Fixed by reordering: schema → symbol → kill-switch (HALT) → HOLD short-circuit → daily-loss → confidence → size → stop → duplicate → position checks. Regression test in `tests/risk.test.ts`: *"daily loss limit fires before SIZE/STOP checks"*.

### H21 — No tests existed at all  `[FIXED]`

For a money-handling system (even paper), this is itself a critical gap. This PR adds 4 test files, 34 tests total:

- `tests/risk.test.ts` (16 tests) — every reject/halt/accept branch, including adversarial intents.
- `tests/paper.test.ts` (9 tests) — round-trip PnL math, fee math, exits, daily rollover, sizePct attribution, and a regression for C5.
- `tests/cost-tracker.test.ts` (5 tests) — accumulation, UTC date rollover, `isExceeded`, "0 disables" semantics.
- `tests/journal.test.ts` (4 tests) — `decisionId` determinism, WAL mode probe, new-column round-trip, legacy-journal migration.

All run on Node's built-in `node:test` runner via `tsx`. **No new dependencies.** New script: `npm test` in `package.json`.

## Medium findings

### M22 — Provider asymmetry on temperature  `[DEFERRED]`

`src/agent/providers/openrouter.ts:34` sets `temperature: 0.3`; `src/agent/providers/claude-cli.ts` does not pass `--temperature`, inheriting whatever default the CLI uses. Self-consistency voting depends on samples differing — the two providers will produce different vote distributions.

### M23 — Empty `Promise.allSettled` outcome  `[DEFERRED — partial]`

`src/agent/brain.ts:124-131` returns `syntheticHold(symbol, "no valid LLM samples")` on a total LLM failure. Good fail-closed behavior. Surfacing a separate `llm_failures_today` counter on the dashboard would make it easier to spot operational issues that masquerade as a HOLD-rich agent. Not added in this PR.

### M24 — Self-consistency tie-break uses LLM-self-reported confidence  `[NOTE]`

`src/agent/brain.ts:139` correctly requires strict majority over the runner-up; `src/agent/brain.ts:141-148` falls back to HOLD on tie. The off-by-one warning in generic checklists doesn't apply. Within the winning action, `src/agent/brain.ts:150-152` picks the highest-confidence sample — that confidence number is itself LLM-self-reported and biased. Worth knowing; not changing.

### M25 — System prompt passed as a single CLI argument  `[DEFERRED]`

`src/agent/providers/claude-cli.ts:64-65`. On Linux ARG_MAX is comfortably large (~128KB-2MB), but if the prompt or market packet grow, this will eventually bite. Move to stdin or `--system-prompt-file` when/if it matters.

### M26 — Dashboard reads from in-memory `SNAPSHOT`  `[DEFERRED]`

`src/state.ts`, `src/main.ts:130-131`. After a crash, the dashboard misrepresents the last cycle until the next cycle runs. Have it pull from `getLastDecision()` on mount.

### M27 — Prompt version surfaced in journal  `[FIXED]`

Covered by C8. `PROMPT_VERSION = "v1"` is now exported from `src/agent/prompt.ts` and stored alongside every decision row.

### M28 — Cycle interval shorter than timeframe burns LLM cost  `[DEFERRED]`

`src/config.ts:16-17`. If a user sets `CYCLE_INTERVAL_MIN=1` with `TIMEFRAME=15m`, they call the LLM 15× per closed candle for the same indicators. A startup warning when `CYCLE_INTERVAL_MIN < timeframeMinutes(TIMEFRAME)` would help — blocked on data-layer.

### M29 — `claude-cli-oauth` is a documented Anthropic ToS gray-area  `[NOTE]`

`src/agent/providers/claude-cli.ts:36-43`, `src/config.ts:70-85`. Subscription billing for automated agents is **not officially supported** by Anthropic. The team handles it correctly (scrubs `ANTHROPIC_API_KEY` from the spawned env, warns at startup), but operators should know the mode could be rate-limited or terminated server-side without warning.

### M30 — `ccxt` and `trading-signals` deps declared but unused  `[BLOCKED]`

`package.json` lists them; nothing in `src/` imports them yet. Will be consumed by the missing data layer.

## Strengths the bot already has

A generic checklist would warn about each of these — the code already handles them correctly:

- **WAL mode**: `src/journal/db.ts:75` (`PRAGMA journal_mode = WAL`) — durability under crash.
- **Tool lockdown on Claude CLI**: `src/agent/providers/claude-cli.ts:56-59` (`--permission-mode dontAsk`, `--allowedTools ""`). Prompt-injection via market data cannot exfiltrate `.env`.
- **Schema enforcement at the harness**: `--json-schema` (`src/agent/providers/claude-cli.ts:62-63`) is stricter than prompt-only schema instructions.
- **OAuth env scrubbing**: `src/agent/providers/claude-cli.ts:77-82` removes `ANTHROPIC_API_KEY` so the CLI cannot silently fall back to API-key billing in subscription mode.
- **Subprocess timeout**: `src/agent/providers/claude-cli.ts:91-94` kills hung Claude calls with `SIGKILL` and rejects.
- **Stop-loss / take-profit checked before the LLM call**: `src/main.ts:68-74` reduces gap-risk if the LLM step fails.
- **Daily reset uses UTC**: `src/exchange/paper.ts:55-57` (`d.toISOString().slice(0, 10)`).
- **Self-consistency vote requires strict majority**: `src/agent/brain.ts:139` (`top[1] > (second?.[1] ?? 0)`); ties and no-majority fall back to HOLD.
- **Fail-closed defaults everywhere**: schema invalid, no LLM samples, no majority, budget exceeded, halt latched — all collapse to HOLD via `holdIntent()` / `syntheticHold()`.
- **Halt latches**: `src/main.ts:147,152` short-circuits subsequent cycles after a HALT.
- **HALT precedes HOLD short-circuit**: `src/risk/engine.ts:31-35` ensures even a HOLD-only agent cannot evade the kill switch.
- **All timestamps via `new Date().toISOString()` (UTC)**: every site, no naive `Date()` arithmetic.

## Closing note

A few opinionated points, founder-to-founder:

1. **An LLM as the trading brain is, today, a worse signal generator than a 50-line momentum filter.** Build this to learn the plumbing. Don't let "Claude said BUY" replace "the EMA200 says trend-up". The LLM's edge, if any, is in *meta* judgment (regime detection, "should I be flat right now?"), not in micro-signal generation.
2. **Run paper for 30+ days at minimum** with real CCXT data, full fees, and full slippage before considering anything live. If you can't beat buy-and-hold over a month of paper, you absolutely won't beat it live.
3. **The journal is the most important file in this repo.** Replay-from-DB is the property that lets you iterate. With the C8 fix in this PR, every decision now journals enough to reconstruct the LLM's actual input and output.
4. **Treat the risk engine like a smart contract.** Small, audited, tested, immutable per-deploy. The brain can change weekly; the risk engine should not.

Don't go live until: every Critical item is closed, every High item is closed or explicitly accepted, the daily-loss kill switch has been tested with a forced losing sequence in paper, and the data layer ships.
