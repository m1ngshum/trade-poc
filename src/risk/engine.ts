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
 * Deterministic guardrails. Every check is fail-fast and ordered.
 * HOLD intents bypass position/size checks but still get schema-validated.
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

  // 6. Max drawdown kill — checked before size so we halt even on HOLDs.
  const drawdownLimit = CONFIG.INITIAL_EQUITY * (1 - CONFIG.MAX_DRAWDOWN_PCT / 100);
  if (packet.equity_usd < drawdownLimit) {
    return { verdict: "HALT", reason: "MAX_DRAWDOWN", intent: i };
  }

  // HOLD short-circuits the trade-specific checks.
  if (i.action === "HOLD") {
    return { verdict: "ACCEPT", intent: i };
  }

  // 3. Size cap
  if (i.size_pct_of_equity > CONFIG.MAX_POSITION_PCT) {
    return {
      verdict: "REJECT",
      reason: `SIZE_CAP: ${i.size_pct_of_equity}% > ${CONFIG.MAX_POSITION_PCT}%`,
      intent: i,
    };
  }

  // 4. Stop-loss present
  if (i.stop_loss_pct <= 0) {
    return { verdict: "REJECT", reason: "STOP_LOSS_MISSING", intent: i };
  }

  // 5. Daily loss budget — force HOLD when -3% reached for the day.
  if (packet.daily_pnl_pct < -CONFIG.DAILY_LOSS_LIMIT_PCT) {
    return { verdict: "REJECT", reason: "DAILY_LOSS_LIMIT", intent: i };
  }

  // 7. Duplicate order
  if (duplicateOrderId) {
    return { verdict: "REJECT", reason: "DUPLICATE_ORDER", intent: i };
  }

  // 8. No double position — only CLOSE is allowed when something is open.
  if (
    packet.open_position.side !== "none" &&
    (i.action === "BUY" || i.action === "SELL")
  ) {
    return { verdict: "REJECT", reason: "POSITION_ALREADY_OPEN", intent: i };
  }

  // CLOSE with no open position is a no-op error — soft reject.
  if (i.action === "CLOSE" && packet.open_position.side === "none") {
    return { verdict: "REJECT", reason: "CLOSE_WITHOUT_POSITION", intent: i };
  }

  return { verdict: "ACCEPT", intent: i };
}
