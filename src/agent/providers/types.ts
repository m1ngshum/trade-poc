import type { MarketStatePacket } from "../schema.js";

export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ProviderSample {
  /** Raw text returned by the provider — caller parses + Zod-validates. */
  raw: string;
  usage: ProviderUsage;
}

/**
 * One LLM round-trip. Throws on transport/auth/timeout errors;
 * returns raw text + usage on a successful response (even if the text
 * isn't valid JSON — that's the caller's problem).
 */
export type Provider = (
  packet: MarketStatePacket,
  systemPrompt: string,
  userMessage: string,
) => Promise<ProviderSample>;
