import { createHash } from "node:crypto";
import type { MarketStatePacket } from "./schema.js";

// Bump on every meaningful edit to SYSTEM_PROMPT or buildUserMessage. Stored
// alongside each decision so a regression in win-rate can be correlated with
// a prompt change.
export const PROMPT_VERSION = "v1";

export const SYSTEM_PROMPT = `You are a crypto trading analyst. You will receive a MarketStatePacket and must respond with ONLY a valid JSON object matching the Intent schema. No preamble. No markdown. No explanation outside the rationale field.

The Intent schema is:
{
  "action": "BUY" | "SELL" | "HOLD" | "CLOSE",
  "symbol": string,
  "size_pct_of_equity": number,   // 1-20
  "stop_loss_pct": number,        // 0.5-5
  "take_profit_pct": number,      // > 0
  "confidence": number,           // 0-1
  "rationale": string             // 1-2 sentences
}

Rules:
- HOLD is always valid. Never force a trade.
- size_pct_of_equity must be between 1 and 20.
- stop_loss_pct must be between 0.5 and 5.
- If confidence < 0.6, return HOLD.
- If open_position.side != "none" and action = "BUY" or "SELL", return HOLD instead (use CLOSE to exit, then re-enter on a later cycle).
- If you would BUY but already long, or SELL but already short, return HOLD.
- Output JSON only.`;

export function buildUserMessage(packet: MarketStatePacket): string {
  return `Current market state:
${JSON.stringify(packet)}

Respond with your Intent JSON now.`;
}

export function systemPromptHash(): string {
  return createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 16);
}
