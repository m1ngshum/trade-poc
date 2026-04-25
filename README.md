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

## Configuration (.env)

See `.env.example`. Key knobs:

- `SYMBOLS` — comma-separated watchlist (default `BTC/USDT,ETH/USDT`).
- `TIMEFRAME` / `CYCLE_INTERVAL_MIN` — keep these matched (default `15m` / `15`).
- `LLM_PROVIDER` — `openrouter` (default) or `claude-cli`. See below.
- `LLM_MODEL` — model id, format depends on provider.
- `SELF_CONSISTENCY_N` — how many parallel LLM samples per cycle (default 3, majority-vote on `action`).
- `MAX_POSITION_PCT`, `DAILY_LOSS_LIMIT_PCT`, `MAX_DRAWDOWN_PCT` — risk guardrails. The drawdown breach halts the loop with a banner.

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

**Billing — read this before running.** `--bare` skips OAuth and keychain reads, so this provider **always** bills against `ANTHROPIC_API_KEY` (Anthropic Console credits). Per Anthropic's [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), subscription (Pro/Max) auth is not supported for third-party agents. Set up Console auto-reload with a hard cap to avoid surprises. The dashboard surfaces `total_cost_usd` per cycle.

Other trade-offs:
- Each self-consistency sample spawns a separate subprocess (~3–8s per sample plus harness boot). Start with `SELF_CONSISTENCY_N=1` to gauge spend.
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
- Stop-loss / take-profit are enforced between cycles (not real exchange orders) by checking the open position against the latest mid-price each cycle.
- The journal is the source of truth; `stats.ts` reads it, `print-journal.ts` reads it. Equity does not persist across restarts in v0.1 — the `INITIAL_EQUITY` resets each launch.

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
# 1) SIZE_CAP — small position cap, watch a >1% intent get rejected.
MAX_POSITION_PCT=1 npm run dev

# 2) DAILY_LOSS_LIMIT — first losing close should trip it.
DAILY_LOSS_LIMIT_PCT=0.01 npm run dev

# 3) MAX_DRAWDOWN — first losing close should HALT the loop.
MAX_DRAWDOWN_PCT=0.01 npm run dev
```

In all three cases, `npm run journal` afterwards will show the reject reason in the rightmost column.

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
