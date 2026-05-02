import { CONFIG } from "../config.js";
import type { Intent, MarketStatePacket } from "../agent/schema.js";
import { IntentSchema } from "../agent/schema.js";

export type Verdict = "ACCEPT" | "REJECT" | "HALT";

export interface RiskResult {
  verdict: Verdict;
  reason?: string;
}

export interface RiskInputs {
  intent: unknown;
  packet: MarketStatePacket;
  duplicateOrderId?: boolean;
}

/**
 * Deterministic guardrails. Every check is fail-fast and ordered. HOLD
 * intents bypass trade-specific checks but still get schema-validated and
 * are still subject to the kill-switch.
 *
 * Order matters: the daily-loss limit fires before size/stop-loss checks
 * so a malformed intent submitted after the daily limit reports the right
 * reason code. The confidence cutoff lives in the engine (not just the
 * prompt) so a model that ignores the instruction is still gated.
 */
export function evaluate({
  intent,
  packet,
  duplicateOrderId,
}: RiskInputs): { verdict: Verdict; reason?: string; intent?: Intent } {
  // 1. Schema valid
  const parsed = IntentSchema.safeParse(intent);
  if (!parsed.success) {
    return { verdict: "REJECT", reason: `SCHEMA_INVALID: ${parsed.error.message}` };
  }
  const i = parsed.data;

  // 2. Symbol whitelist
  if (!CONFIG.SYMBOLS.includes(i.symbol)) {
    return { verdict: "REJECT", reason: `SYMBOL_NOT_WHITELISTED: ${i.symbol}`, intent: i };
  }

  // 3. Max drawdown kill — checked before HOLD short-circuit so we halt
  //    the loop even when the model is sitting tight.
  const drawdownLimit = CONFIG.INITIAL_EQUITY * (1 - CONFIG.MAX_DRAWDOWN_PCT / 100);
  if (packet.equity_usd < drawdownLimit) {
    return { verdict: "HALT", reason: "MAX_DRAWDOWN", intent: i };
  }

  // 4. HOLD short-circuits trade-specific checks.
  if (i.action === "HOLD") {
    return { verdict: "ACCEPT", intent: i };
  }

  // 5. Daily loss budget — fires before SIZE/STOP so the verdict reason
  //    surfaces "we're past the daily limit" cleanly in logs.
  if (packet.daily_pnl_pct < -CONFIG.DAILY_LOSS_LIMIT_PCT) {
    return { verdict: "REJECT", reason: "DAILY_LOSS_LIMIT", intent: i };
  }

  // 6. Confidence cutoff — the prompt asks the model to HOLD below this
  //    threshold; the engine enforces it regardless of what the model says.
  if (i.confidence < CONFIG.MIN_CONFIDENCE) {
    return {
      verdict: "REJECT",
      reason: `LOW_CONFIDENCE: ${i.confidence} < ${CONFIG.MIN_CONFIDENCE}`,
      intent: i,
    };
  }

  // 7. Size cap
  if (i.size_pct_of_equity > CONFIG.MAX_POSITION_PCT) {
    return {
      verdict: "REJECT",
      reason: `SIZE_CAP: ${i.size_pct_of_equity}% > ${CONFIG.MAX_POSITION_PCT}%`,
      intent: i,
    };
  }

  // 8. Stop-loss present
  if (i.stop_loss_pct <= 0) {
    return { verdict: "REJECT", reason: "STOP_LOSS_MISSING", intent: i };
  }

  // 9. Duplicate order
  if (duplicateOrderId) {
    return { verdict: "REJECT", reason: "DUPLICATE_ORDER", intent: i };
  }

  // 10. No double position — only CLOSE is allowed when something is open.
  if (
    packet.open_position.side !== "none" &&
    (i.action === "BUY" || i.action === "SELL")
  ) {
    return { verdict: "REJECT", reason: "POSITION_ALREADY_OPEN", intent: i };
  }

  // 11. CLOSE with no open position is a no-op error — soft reject.
  if (i.action === "CLOSE" && packet.open_position.side === "none") {
    return { verdict: "REJECT", reason: "CLOSE_WITHOUT_POSITION", intent: i };
  }

  return { verdict: "ACCEPT", intent: i };
}
