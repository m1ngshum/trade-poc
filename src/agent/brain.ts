import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";
import { IntentSchema, type Intent, type MarketStatePacket } from "./schema.js";

let _client: OpenAI | null = null;

function client(): OpenAI {
  if (_client) return _client;
  _client = new OpenAI({
    apiKey: CONFIG.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/m1ngshum/trade-poc",
      "X-Title": "crypto-agent-cli",
    },
  });
  return _client;
}

export interface BrainResult {
  intent: Intent;
  usage: { prompt_tokens: number; completion_tokens: number };
  samples: number;
  votes: Record<Intent["action"], number>;
}

interface SampleResult {
  intent: Intent | null;
  prompt_tokens: number;
  completion_tokens: number;
  raw: string;
}

async function sampleOnce(packet: MarketStatePacket): Promise<SampleResult> {
  // OpenRouter forwards Anthropic `cache_control` hints to Claude models when
  // the system message is sent as a content-block array. The OpenAI SDK's
  // public types don't include cache_control, so we cast at the boundary.
  const params = {
    model: CONFIG.LLM_MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: buildUserMessage(packet) },
    ],
  } as unknown as ChatCompletionCreateParamsNonStreaming;

  const completion = await client().chat.completions.create(params);

  const raw = completion.choices[0]?.message?.content ?? "";
  let parsed: Intent | null = null;
  try {
    const json = JSON.parse(raw) as unknown;
    const result = IntentSchema.safeParse(json);
    if (result.success) parsed = result.data;
    else logger.warn(`LLM sample failed schema: ${result.error.message}`);
  } catch (e) {
    logger.warn(`LLM sample non-JSON: ${(e as Error).message}`);
  }

  return {
    intent: parsed,
    prompt_tokens: completion.usage?.prompt_tokens ?? 0,
    completion_tokens: completion.usage?.completion_tokens ?? 0,
    raw,
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

  const usage = samples.reduce(
    (acc, s) => ({
      prompt_tokens: acc.prompt_tokens + s.prompt_tokens,
      completion_tokens: acc.completion_tokens + s.completion_tokens,
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
