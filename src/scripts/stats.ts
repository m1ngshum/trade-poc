import { CONFIG } from "../config.js";
import { closeDb, getStats } from "../journal/db.js";

// USD per 1M tokens. Update if you change LLM_MODEL — these are OpenRouter
// list prices for Anthropic models (input, output).
const PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-opus-4.7": { input: 15, output: 75 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
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
  `LLM spend:          ${usd != null ? `$${usd.toFixed(4)}` : "(unknown — add pricing for this model)"}`,
];

// eslint-disable-next-line no-console
console.log(lines.join("\n"));
closeDb();
