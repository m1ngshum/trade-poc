import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";
import { claudeCliProvider } from "./providers/claude-cli.js";
import { openrouterProvider } from "./providers/openrouter.js";
import type { Provider } from "./providers/types.js";
import { IntentSchema, type Intent, type MarketStatePacket } from "./schema.js";

function selectProvider(): Provider {
  switch (CONFIG.LLM_PROVIDER) {
    case "openrouter":
      return openrouterProvider;
    case "claude-cli":
    case "claude-cli-oauth":
      return claudeCliProvider;
    default: {
      const _exhaustive: never = CONFIG.LLM_PROVIDER;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}

export interface BrainResult {
  intent: Intent;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd?: number;
  };
  samples: number;
  votes: Record<Intent["action"], number>;
}

interface SampleResult {
  intent: Intent | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd?: number;
  raw: string;
}

function extractJson(raw: string): string {
  // Some models wrap JSON in ```json ... ``` despite the system prompt.
  // Pull the first balanced object if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) return fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

async function sampleOnce(packet: MarketStatePacket): Promise<SampleResult> {
  const provider = selectProvider();
  const result = await provider(packet, SYSTEM_PROMPT, buildUserMessage(packet));

  let parsed: Intent | null = null;
  try {
    const json = JSON.parse(extractJson(result.raw)) as unknown;
    const validated = IntentSchema.safeParse(json);
    if (validated.success) parsed = validated.data;
    else logger.warn(`LLM sample failed schema: ${validated.error.message}`);
  } catch (e) {
    logger.warn(`LLM sample non-JSON: ${(e as Error).message}`);
  }

  return {
    intent: parsed,
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    cost_usd: result.costUsd,
    raw: result.raw,
  };
}

function holdIntent(symbol: string, rationale: string): Intent {
  return {
    action: "HOLD",
    symbol,
    size_pct_of_equity: 0,
    stop_loss_pct: 0.5,
    take_profit_pct: 0.5,
    confidence: 0,
    rationale,
  };
}

export async function decide(packet: MarketStatePacket): Promise<BrainResult> {
  const n = CONFIG.SELF_CONSISTENCY_N;
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => sampleOnce(packet)),
  );

  const samples: SampleResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") samples.push(r.value);
    else logger.warn(`LLM sample errored: ${(r.reason as Error)?.message}`);
  }

  const usage = samples.reduce<BrainResult["usage"]>(
    (acc, s) => ({
      prompt_tokens: acc.prompt_tokens + s.prompt_tokens,
      completion_tokens: acc.completion_tokens + s.completion_tokens,
      cost_usd:
        s.cost_usd === undefined
          ? acc.cost_usd
          : (acc.cost_usd ?? 0) + s.cost_usd,
    }),
    { prompt_tokens: 0, completion_tokens: 0 },
  );

  const valid = samples.filter(
    (s): s is SampleResult & { intent: Intent } => s.intent !== null,
  );

  const votes: Record<Intent["action"], number> = {
    BUY: 0,
    SELL: 0,
    HOLD: 0,
    CLOSE: 0,
  };
  for (const s of valid) votes[s.intent.action]++;

  if (valid.length === 0) {
    return {
      intent: holdIntent(packet.symbol, "no valid LLM samples"),
      usage,
      samples: samples.length,
      votes,
    };
  }

  const sorted = (Object.entries(votes) as Array<[Intent["action"], number]>)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const top = sorted[0]!;
  const second = sorted[1];
  const isMajority = top[1] > (second?.[1] ?? 0);

  if (!isMajority) {
    return {
      intent: holdIntent(packet.symbol, "no LLM majority"),
      usage,
      samples: samples.length,
      votes,
    };
  }

  const winners = valid.filter((s) => s.intent.action === top[0]);
  winners.sort((a, b) => b.intent.confidence - a.intent.confidence);

  return {
    intent: winners[0]!.intent,
    usage,
    samples: samples.length,
    votes,
  };
}
