# Status: Paused (2026-05-17)

This repo is **paused indefinitely** and the launchd job has been unloaded.
The repo will be archived on GitHub shortly after this commit lands.

## What this bot is

TypeScript/Node paper-trading bot for BTC/USDT and ETH/USDT. LLM-driven
(sonnet-4.6 via OpenRouter) on a 15-min cycle, journaled to a local SQLite
file. Ran under launchd as `com.mingshum.trade-poc` from 2026-05-16 to
2026-05-17.

## Why it's paused

Built as a control experiment alongside two other LLM-driven trading
systems (Polymarket prediction markets + Alpaca stocks via the
`tradingagents` repo). The idea: if the same model underperforms across
all three market classes, the problem is the brain. If it only
underperforms on one, the problem is market-specific.

The control didn't pay off in the form we hoped:

| Metric | Value (final cycle, 2026-05-17) |
|---|---|
| Cycles run | 57 (across ~14 hours) |
| Decisions | 122 (100% ACCEPT, 100% HOLD) |
| Trades closed | 3 (1W / 2L) |
| Win rate | 33.3% |
| Realized PnL | -$15.06 |
| Equity | $9,974.96 (start: $10,000) |
| LLM spend | $1.44 |

100% HOLD with only 3 closed trades is too little signal to learn from.
Meanwhile the polymarket bot (same brain, different market) has 30+
decisions/day and a clear NO-EDGE verdict from `scripts/calibrate.py`.
That's where the iteration loop is fast and the feedback is concrete.

## What to do if you come back

1. **Unarchive on GitHub**, clone fresh.
2. **Rotate the OpenRouter key** in `.env` — the one this bot last used
   (2026-05-16/17 window) should be considered exposed. Check
   openrouter.ai for any spend you didn't expect.
3. **Fix the ETH MTM bug first**: every cycle logs
   `markToMarket: no lastPrice for ETH/USDT; using entry (unrealised=0)`.
   ETH price isn't flowing into equity calc. Real bug; equity numbers
   above may be wrong.
4. **Lower the HOLD bias** in the agent prompt before re-arming launchd.
   100% HOLD means no signal — better to take small risks and learn.
5. **Reload launchd** with `launchctl load ~/Library/LaunchAgents/com.mingshum.trade-poc.plist`
   AFTER you've reviewed the plist (env vars, working dir, log paths).

## What's worth salvaging even if you don't restart

- `src/scripts/select-pairs.ts` — pair selection with scoring + correlation,
  decent reference for future crypto experiments.
- `AUDIT.md` — security audit notes from the build sessions.
- `src/agent/*` — the bull/bear/trader prompt structure is comparable to
  the Python `tradingagents` framework; useful side-by-side for prompt
  engineering iteration.

## Companion systems still running

- `tradingagents` repo (`m1ngshum/tradingagents`) — polymarket-daily +
  stocks-daily routines via Claude Code Cloud. v2.1 gates shipped
  (cluster cap, cost ceiling, calibration script).
- State logged to `m1ngshum/tradingagents-state`.
