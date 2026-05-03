import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z
  .object({
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

    LLM_PROVIDER: z
      .enum(["openrouter", "claude-cli", "claude-cli-oauth"])
      .default("openrouter"),
    OPENROUTER_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default("anthropic/claude-sonnet-4.6"),
    LLM_FALLBACK_MODEL: z.string().optional(),
    SELF_CONSISTENCY_N: z.coerce.number().int().min(1).max(9).default(3),
    CLAUDE_CLI_PATH: z.string().default("claude"),

    INITIAL_EQUITY: z.coerce.number().positive().default(10_000),
    MAX_POSITION_PCT: z.coerce.number().positive().max(100).default(20),
    DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().default(3),
    MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(15),
    MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    // Fraction of equity put at risk on each accepted non-HOLD trade.
    // Final position size = min(RISK_PER_TRADE_PCT / stop_loss_pct * 100,
    // MAX_POSITION_PCT). Lower = safer; the LLM-proposed size is overridden.
    RISK_PER_TRADE_PCT: z.coerce.number().positive().default(0.5),
    LLM_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(5),

    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DB_PATH: z.string().default("./data/journal.db"),
  })
  .superRefine((v, ctx) => {
    if (v.LLM_PROVIDER === "openrouter" && !v.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENROUTER_API_KEY"],
        message: "OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter",
      });
    }
    if (v.LLM_PROVIDER === "claude-cli" && !v.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message:
          "ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude-cli (--bare skips OAuth/keychain; subscription auth is not supported)",
      });
    }
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

// Loud startup notices that don't belong as schema errors.
if (CONFIG.LLM_PROVIDER === "claude-cli-oauth") {
  // eslint-disable-next-line no-console
  console.warn(
    "[config] LLM_PROVIDER=claude-cli-oauth — using your local `claude` CLI's " +
      "OAuth login (subscription billing). Anthropic does not officially support " +
      "subscription-backed automated agents; rate limits are shared with claude.ai usage.",
  );
  if (CONFIG.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "[config] ANTHROPIC_API_KEY is set in your env. The CLI normally prefers " +
        "API-key auth over OAuth, which would defeat oauth mode — the provider " +
        "scrubs it from the spawned subprocess to keep you on subscription.",
    );
  }
}
