/**
 * UTC-daily accumulator for LLM API spend. The bot shells out to Claude (or
 * OpenRouter) once per cycle per symbol with N self-consistency samples; a
 * pricing bug or a stuck cycle loop can rack up real money fast. Once the
 * day's budget is exceeded, callers should short-circuit to a synthetic HOLD
 * instead of calling the model.
 *
 * The tracker is in-process and resets at UTC midnight. Persistence across
 * restarts is intentionally not implemented here — the SQLite journal stores
 * per-decision cost so the next run can reconstruct today's total if needed.
 */

function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class CostTracker {
  private spent = 0;
  private day: string;

  constructor(
    private readonly budgetUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = utcDateKey(now());
  }

  private rollover(): void {
    const today = utcDateKey(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }

  add(costUsd: number | undefined): void {
    if (!costUsd || costUsd <= 0) return;
    this.rollover();
    this.spent += costUsd;
  }

  getSpentToday(): number {
    this.rollover();
    return this.spent;
  }

  getBudgetUsd(): number {
    return this.budgetUsd;
  }

  // Returns true when no further spend is permitted today. A budget of 0 is
  // treated as "unlimited" so users can opt out explicitly.
  isExceeded(): boolean {
    if (this.budgetUsd <= 0) return false;
    this.rollover();
    return this.spent >= this.budgetUsd;
  }
}
