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

**`claude-cli`** — spawns the local `claude` CLI in non-interactive print mode (`claude -p --bare --output-format json`). Useful when you want to run on a Claude.ai Pro/Max subscription instead of an API key. `LLM_MODEL` uses Claude's own naming, e.g. `sonnet` or `claude-sonnet-4-6`.

Trade-offs of `claude-cli`:
- Each self-consistency sample spawns a separate subprocess (slower, ~3–8s per sample plus harness boot).
- Auth follows whatever `claude` is locally signed into.
- Subscription rate limits may bite at high `SELF_CONSISTENCY_N` × short `CYCLE_INTERVAL_MIN`. Start with `SELF_CONSISTENCY_N=1` to feel out the budget.
- Tools are disabled (`--tools ""`) so the model can't accidentally do filesystem or web work — it's purely a chat completion.

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
