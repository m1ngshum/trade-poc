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
- `LLM_MODEL` — OpenRouter model id; default `anthropic/claude-sonnet-4.6`. If unavailable, drop to `anthropic/claude-sonnet-4.5`.
- `SELF_CONSISTENCY_N` — how many parallel LLM samples per cycle (default 3, majority-vote on `action`).
- `MAX_POSITION_PCT`, `DAILY_LOSS_LIMIT_PCT`, `MAX_DRAWDOWN_PCT` — risk guardrails. The drawdown breach halts the loop with a banner.

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

- LLM I/O goes through OpenRouter's OpenAI-compatible endpoint. The static system prompt is sent with `cache_control: ephemeral`, which OpenRouter forwards to Claude models.
- Stop-loss / take-profit are enforced between cycles (not real exchange orders) by checking the open position against the latest mid-price each cycle.
- The journal is the source of truth; `stats.ts` reads it, `print-journal.ts` reads it. Equity does not persist across restarts in v0.1 — the `INITIAL_EQUITY` resets each launch.
