# crypto-agent-cli

Paper-trading AI agent loop. Pulls live Binance market data via CCXT, computes indicators, asks an LLM for a trading intent (with self-consistency voting), runs it through a deterministic risk layer, executes against an in-memory paper exchange, and journals every decision to SQLite. Live terminal dashboard via Ink.

No real money. No web UI.

## Quickstart

```bash
npm install
cp .env.example .env
# Set OPENROUTER_API_KEY in .env
npm run dev
```

The dashboard renders within ~5s. Press `r` to force-cycle, `q` to quit.

## Inspect the journal

```bash
npm run journal     # last 30 decisions in a table
npm run stats       # win rate, PnL, token spend $
```

## Tests

```bash
npm run typecheck   # strict TS, must be clean before any change lands
npm test            # node:test runner across risk, paper, journal, cost-tracker, data
```

## Configuration (.env)

See `.env.example`. Key knobs:

- `SYMBOLS` — comma-separated watchlist (default `BTC/USDT,ETH/USDT`).
- `TIMEFRAME` / `CYCLE_INTERVAL_MIN` — keep these matched (default `15m` / `15`).
- `LLM_PROVIDER` — `openrouter` (default), `claude-cli`, or `claude-cli-oauth`. See below.
- `LLM_MODEL` — model id, format depends on provider.
- `SELF_CONSISTENCY_N` — how many parallel LLM samples per cycle (default 3, majority-vote on `action`).
- `MAX_POSITION_PCT`, `DAILY_LOSS_LIMIT_PCT`, `MAX_DRAWDOWN_PCT` — risk guardrails. The drawdown breach is anchored to the equity **high-water mark** (not `INITIAL_EQUITY`), halts the loop, and force-flattens any open position before stopping.
- `RISK_PER_TRADE_PCT` (default 0.5) — the risk engine sizes every accepted non-HOLD trade as `min(RISK_PER_TRADE_PCT / stop_loss_pct * 100, MAX_POSITION_PCT)`. The LLM's proposed size is ignored — sizing is deterministic.
- `MIN_CONFIDENCE` (default 0.6) — non-HOLD intents below this are rejected. HOLDs always pass.
- `LLM_DAILY_BUDGET_USD` (default 5) — once today's accumulated LLM spend exceeds this, cycles short-circuit to synthetic HOLD without calling the model.

### LLM providers

**`openrouter` (default)** — calls OpenRouter's OpenAI-compatible endpoint with the configured API key. Native parallel calls, prompt caching, low per-call latency. `LLM_MODEL` uses OpenRouter's namespacing, e.g. `anthropic/claude-sonnet-4.6`.

**`claude-cli`** — spawns the local `claude` CLI in non-interactive print mode with a hardened flag set:

```
claude -p --bare --no-session-persistence \
  --permission-mode dontAsk --allowedTools "" \
  --output-format json --json-schema <Intent JSON Schema> \
  --system-prompt <SYSTEM_PROMPT> --model <LLM_MODEL>
```

`LLM_MODEL` uses the CLI's own naming (`sonnet`, `claude-sonnet-4-6`, etc). Set `LLM_FALLBACK_MODEL` to enable automatic failover when the primary is overloaded.

**Billing — read this before running.** `--bare` skips OAuth and keychain reads, so this provider **always** bills against `ANTHROPIC_API_KEY` (Anthropic Console credits). Set up Console auto-reload with a hard cap to avoid surprises. The dashboard surfaces `total_cost_usd` per cycle. This is the path Anthropic sanctions for automated agents.

**`claude-cli-oauth`** — same hardened lockdown (`--permission-mode dontAsk --allowedTools "" --json-schema`), but **drops `--bare`** so the CLI's logged-in OAuth session (Pro/Max subscription) is used. `ANTHROPIC_API_KEY` is not required and is **scrubbed from the subprocess env** if set, so the CLI cannot accidentally fall through to API-key billing.

Caveats specific to OAuth mode:
- Per Anthropic's [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), subscription-backed third-party agents are not officially supported. Personal use on your own machine is the gray area.
- Rate limits are shared with your claude.ai usage. Heavy interactive use elsewhere can throttle the bot.
- Without `--bare`, the CLI auto-discovers your `~/.claude` settings, MCP servers, and any `CLAUDE.md` in the bot's cwd. The trade-poc directory has no `CLAUDE.md`, but check your user-level config for hooks that might fire on every cycle.
- `total_cost_usd` from the CLI is typically `0` under subscription billing, so the dashboard's `Cost:` line will show `$0.0000`. `npm run stats` falls back to estimating from tokens × API list prices, which over-reports your actual subscription spend (which is just your monthly fee).

Other trade-offs (both modes):
- Each self-consistency sample spawns a separate subprocess (~3–8s per sample plus harness boot). Start with `SELF_CONSISTENCY_N=1`.
- `--permission-mode dontAsk` + empty allowlist denies every tool the model might try; `--json-schema` enforces structured output at the harness layer (no prompt-following lottery).

## Architecture

```
CCXT  →  indicators  →  MarketStatePacket  →  LLM (×N, vote)
                                              ↓
                              Intent  →  Risk engine  →  Paper exchange
                                              ↓                ↓
                                          SQLite journal  ←────┘
                                              ↓
                                          Ink dashboard
```

## Notes

- With `LLM_PROVIDER=openrouter`, the static system prompt is sent with `cache_control: ephemeral`, which OpenRouter forwards to Claude models. With `LLM_PROVIDER=claude-cli`, caching is whatever the harness applies internally.
- Stop-loss / take-profit are simulated as resting orders against the latest **closed** bar's high/low at the start of each cycle. Triggers fill at the stop or TP price (optimistic — gap-through slippage is not modeled in v0.1). When stop and TP both fall inside the same bar, the stop wins.
- Fetched OHLCV always drops the still-forming live candle, so decisions are made on settled bars only.
- Position sizing is computed deterministically from `RISK_PER_TRADE_PCT` and the LLM's proposed `stop_loss_pct`, capped at `MAX_POSITION_PCT`. The LLM's `size_pct_of_equity` is advisory.
- The journal is the source of truth; `stats.ts` reads it, `print-journal.ts` reads it. Equity, high-water mark, and the halted state do **not** persist across restarts in v0.1 — `INITIAL_EQUITY` resets each launch.

---

## Recipes (copy-paste)

### A) Run on OpenRouter (default, fastest path)

```bash
# one-time
npm install
cp .env.example .env

# then edit .env — at minimum:
#   LLM_PROVIDER=openrouter
#   OPENROUTER_API_KEY=sk-or-v1-...
#   LLM_MODEL=anthropic/claude-sonnet-4.6
#   SYMBOLS=BTC/USDT
#   SELF_CONSISTENCY_N=3

npm run dev
# press `r` to force a cycle, `q` to quit
```

### B) Run on Claude CLI (hardened, billed via ANTHROPIC_API_KEY)

```bash
# Prereqs: `claude` CLI on PATH and an Anthropic Console API key.
which claude && claude --version

# .env
LLM_PROVIDER=claude-cli
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=sonnet                  # or claude-sonnet-4-6
LLM_FALLBACK_MODEL=claude-haiku-4-5
SELF_CONSISTENCY_N=1              # start at 1 to gauge spend; raise after
SYMBOLS=BTC/USDT

npm run dev
```

The dashboard's LAST DECISION block shows `Cost: $0.00X` per cycle (sum of all self-consistency samples). Set a hard cap on Console auto-reload before letting this run unattended.

### B-OAuth) Run on Claude Max/Pro subscription (gray-area, no API credits)

```bash
# Prereqs:
which claude && claude --version
# 1. Make sure `claude` is signed into your subscription. Easiest:
claude          # interactive — pick "Sign in with Claude" if not already
# Then exit, and verify:
claude /status  # should show your subscription tier

# 2. CRITICAL — make sure ANTHROPIC_API_KEY is NOT set in the env you'll
#    launch the bot from, or the bot will warn and scrub it for safety.
unset ANTHROPIC_API_KEY

# .env
LLM_PROVIDER=claude-cli-oauth
LLM_MODEL=sonnet                  # or claude-sonnet-4-6
LLM_FALLBACK_MODEL=claude-haiku-4-5
SELF_CONSISTENCY_N=1              # subscription rate limits are shared with claude.ai
SYMBOLS=BTC/USDT
# (do NOT set ANTHROPIC_API_KEY in .env)

npm run dev
```

You'll see two warnings at startup confirming you're on the OAuth path. The dashboard's `Cost:` line will read `$0.0000` (subscription doesn't itemize per-call); your real spend is just your monthly subscription fee.

If `npm run dev` errors with auth/permission issues, run `claude` interactively once first to refresh the OAuth token, then retry.

### C) Smoke-test a single cycle without launching the dashboard

```bash
# Forces config validation and one full pipeline pass for the first symbol.
# Useful in CI / cron / preflight checks.
npx tsx -e '
  process.env.SYMBOLS = process.env.SYMBOLS || "BTC/USDT";
  const { fetchOHLCV, fetchTicker } = await import("./src/data/market.js");
  const { computeIndicators, computeChanges, timeframeMinutes } = await import("./src/data/indicators.js");
  const { classifyRegime } = await import("./src/data/regime.js");
  const { decide } = await import("./src/agent/brain.js");
  const { evaluate } = await import("./src/risk/engine.js");
  const { CONFIG } = await import("./src/config.js");

  const sym = CONFIG.SYMBOLS[0];
  const [c, t] = await Promise.all([fetchOHLCV(sym), fetchTicker(sym)]);
  const ind = computeIndicators(c);
  const ch = computeChanges(c, timeframeMinutes(CONFIG.TIMEFRAME));
  const packet = {
    symbol: sym, timestamp: new Date().toISOString(), price: t.last,
    ...ch, ...ind, volume_24h_usd: t.quoteVolume24h,
    regime: classifyRegime(ind, t.last),
    open_position: { side: "none", entry_price: 0, unrealized_pnl_pct: 0 },
    equity_usd: CONFIG.INITIAL_EQUITY, daily_pnl_pct: 0, last_3_trades: [],
  };
  const r = await decide(packet);
  console.log("intent:", r.intent.action, "conf:", r.intent.confidence,
              "tokens:", r.usage.prompt_tokens + r.usage.completion_tokens,
              "cost:", r.usage.cost_usd ?? "(n/a)");
  const v = evaluate({ intent: r.intent, packet });
  console.log("verdict:", v.verdict, v.reason ?? "");
'
```

### D) Tail the journal during a run

```bash
# Last 30 decisions (one row per cycle):
npm run journal

# Aggregate stats:
npm run stats

# Raw SQL, e.g. all REJECTs in the last hour:
sqlite3 data/journal.db "SELECT timestamp, symbol, reject_reason
  FROM decisions
  WHERE risk_verdict='REJECT' AND timestamp > datetime('now', '-1 hour')
  ORDER BY timestamp DESC;"

# Live tail of the agent log (separate terminal):
tail -f data/agent.log
```

### E) Force each risk-engine reject path (sanity check before letting it run unattended)

```bash
# 1) LOW_CONFIDENCE — every non-HOLD intent should get rejected.
MIN_CONFIDENCE=0.99 npm run dev

# 2) DAILY_LOSS_LIMIT — first losing close should trip it.
DAILY_LOSS_LIMIT_PCT=0.01 npm run dev

# 3) MAX_DRAWDOWN — first losing close should HALT the loop AND force-close
#    any open position. `npm run journal` will show one ACCEPT followed by a
#    FORCE_CLOSE trade row.
MAX_DRAWDOWN_PCT=0.01 npm run dev
```

In all three cases, `npm run journal` afterwards will show the reject reason in the rightmost column. Note: setting `MAX_POSITION_PCT=1` no longer triggers a SIZE_CAP reject — sizing is now risk-based and clamped to the cap, so the cap is always satisfied.

### F) Reset a session (wipe paper state and journal)

```bash
rm -f data/journal.db data/agent.log
# Equity does not persist across restarts in v0.1 — `INITIAL_EQUITY` from .env
# is what you start fresh with on the next `npm run dev`.
```

### G) Cron / systemd long-run (OpenRouter)

```bash
# /etc/systemd/system/crypto-agent.service
[Unit]
Description=crypto-agent-cli
After=network-online.target

[Service]
WorkingDirectory=/home/user/trade-poc
EnvironmentFile=/home/user/trade-poc/.env
ExecStart=/usr/bin/env npm run dev
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
```

Note: the Ink dashboard expects a TTY. Under systemd you'll want to either redirect the dashboard away (the journal + agent.log are the source of truth anyway) or run inside `tmux`/`screen`. For headless deploys, plan to add a `--no-dashboard` flag in v0.2.
