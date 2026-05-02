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

  // 3. Max drawdown kill — anchored to the equity high-water mark, NOT
  //    INITIAL_EQUITY. Otherwise a doubled-up account could give back 50%
  //    of peak before tripping the 15% line. Checked before HOLD so we
  //    halt even on neutral cycles.
  const drawdownLimit =
    packet.equity_high_water * (1 - CONFIG.MAX_DRAWDOWN_PCT / 100);
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

  // 7. Stop-loss must be present and not absurdly tight. Anything below
  //    0.1% would force the sizing override (step 11) to >100% of equity.
  if (i.stop_loss_pct <= 0) {
    return { verdict: "REJECT", reason: "STOP_LOSS_MISSING", intent: i };
  }
  if (i.stop_loss_pct < 0.1) {
    return {
      verdict: "REJECT",
      reason: `STOP_TOO_TIGHT: ${i.stop_loss_pct}% < 0.1%`,
      intent: i,
    };
  }

  // 8. Duplicate order
  if (duplicateOrderId) {
    return { verdict: "REJECT", reason: "DUPLICATE_ORDER", intent: i };
  }

  // 9. No double position — only CLOSE is allowed when something is open.
  if (
    packet.open_position.side !== "none" &&
    (i.action === "BUY" || i.action === "SELL")
  ) {
    return { verdict: "REJECT", reason: "POSITION_ALREADY_OPEN", intent: i };
  }

  // 10. CLOSE with no open position is a no-op error — soft reject.
  if (i.action === "CLOSE" && packet.open_position.side === "none") {
    return { verdict: "REJECT", reason: "CLOSE_WITHOUT_POSITION", intent: i };
  }

  // 11. Risk-based sizing override — the LLM proposes a direction; the
  //     engine sizes it. Risk-per-trade as a fraction of equity divided by
  //     the stop distance, capped by MAX_POSITION_PCT. The model's proposed
  //     size_pct is overridden so a low-confidence stop-tight intent can't
  //     stake the same notional as a high-conviction wide-stop one.
  //     CLOSE keeps the LLM's size (zero) since it just exits the position.
  if (i.action === "BUY" || i.action === "SELL") {
    const riskBasedPct = (CONFIG.RISK_PER_TRADE_PCT / i.stop_loss_pct) * 100;
    const sized = Math.min(riskBasedPct, CONFIG.MAX_POSITION_PCT);
    return { verdict: "ACCEPT", intent: { ...i, size_pct_of_equity: sized } };
  }

  return { verdict: "ACCEPT", intent: i };
}
