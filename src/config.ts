import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  EXCHANGE: z.string().default("binance"),
  SYMBOLS: z
    .string()
    .default("BTC/USDT")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  TIMEFRAME: z.string().default("15m"),
  CYCLE_INTERVAL_MIN: z.coerce.number().positive().default(15),

  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  LLM_MODEL: z.string().default("anthropic/claude-sonnet-4.6"),
  SELF_CONSISTENCY_N: z.coerce.number().int().min(1).max(9).default(3),

  INITIAL_EQUITY: z.coerce.number().positive().default(10_000),
  MAX_POSITION_PCT: z.coerce.number().positive().max(100).default(20),
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().default(3),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(15),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DB_PATH: z.string().default("./data/journal.db"),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid configuration:");
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const CONFIG = parsed.data;
export type Config = typeof CONFIG;
