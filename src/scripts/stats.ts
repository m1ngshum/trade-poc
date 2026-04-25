import { CONFIG } from "../config.js";
import { closeDb, getStats } from "../journal/db.js";

// USD per 1M tokens (Anthropic April 2026 list prices). Keyed by every model
// string that any provider might emit — OpenRouter (`anthropic/<name>`),
// Claude CLI canonical (`claude-<family>-<x>-<y>`), and the short aliases
// (`sonnet`/`opus`/`haiku`, which we map to the latest of each family).
const PRICING: Record<string, { input: number; output: number }> = {
  // Sonnet 4.6 / 4.5 — same price
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  sonnet: { input: 3, output: 15 },

  // Opus 4.7 / 4.6 / 4.5
  "anthropic/claude-opus-4.7": { input: 15, output: 75 },
  "anthropic/claude-opus-4.6": { input: 15, output: 75 },
  "anthropic/claude-opus-4.5": { input: 15, output: 75 },
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  opus: { input: 15, output: 75 },

  // Haiku 4.5
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  haiku: { input: 1, output: 5 },
};

const s = getStats();
const winRate = s.totalTrades > 0 ? (s.wins / s.totalTrades) * 100 : 0;
const acceptRate =
  s.totalDecisions > 0 ? (s.acceptCount / s.totalDecisions) * 100 : 0;
const rejectRate =
  s.totalDecisions > 0 ? (s.rejectCount / s.totalDecisions) * 100 : 0;

const price = PRICING[CONFIG.LLM_MODEL];
const usd = price
  ? (s.totalPromptTokens * price.input + s.totalCompletionTokens * price.output) / 1_000_000
  : null;

const lines = [
  `Model:              ${CONFIG.LLM_MODEL}`,
  `Decisions:          ${s.totalDecisions}  (accept=${s.acceptCount} ${acceptRate.toFixed(1)}%, reject=${s.rejectCount} ${rejectRate.toFixed(1)}%, halt=${s.haltCount})`,
  `Trades closed:      ${s.totalTrades}  (wins=${s.wins}, losses=${s.losses})`,
  `Win rate:           ${winRate.toFixed(1)}%`,
  `Total realized PnL: $${s.totalPnlUsd.toFixed(2)}`,
  `Tokens:             prompt=${s.totalPromptTokens.toLocaleString()}  completion=${s.totalCompletionTokens.toLocaleString()}`,
  `LLM spend:          ${usd != null ? `$${usd.toFixed(4)}` : `(no pricing entry for "${CONFIG.LLM_MODEL}" — add one to src/scripts/stats.ts)`}`,
];

// eslint-disable-next-line no-console
console.log(lines.join("\n"));
closeDb();
