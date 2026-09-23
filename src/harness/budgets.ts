import type { MagpieConfig } from "../types.js";
import type { UsageTracker } from "../model/usage.js";

export type BudgetHit = "steps" | "llm" | "time" | null;

/**
 * Hard Rule 3: limits live in plain code wrapping the loop. Nothing the model
 * outputs can extend them.
 */
export class Budget {
  private steps = 0;
  readonly startedAt: number;

  constructor(
    private readonly cfg: MagpieConfig,
    private readonly usage: UsageTracker,
    startedAt: number = Date.now(),
  ) {
    this.startedAt = startedAt;
  }

  countStep(): number {
    return ++this.steps;
  }

  get stepsUsed(): number {
    return this.steps;
  }

  get llmUsed(): number {
    return this.usage.totalRequests();
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  stepsLeft(): number {
    return Math.max(0, this.cfg.budget.max_steps - this.steps);
  }

  llmLeft(): number {
    return Math.max(0, this.cfg.budget.max_llm_requests - this.llmUsed);
  }

  minutesLeft(): number {
    return Math.max(0, this.cfg.budget.max_minutes - this.elapsedMs / 60_000);
  }

  /** Which limit (if any) is spent. Checked before every iteration. */
  hit(): BudgetHit {
    if (this.steps >= this.cfg.budget.max_steps) return "steps";
    if (this.llmUsed >= this.cfg.budget.max_llm_requests) return "llm";
    if (this.elapsedMs >= this.cfg.budget.max_minutes * 60_000) return "time";
    return null;
  }

  /** e.g. "34/80 steps · 29/60 LLM calls · 6.2/20 min" */
  summary(): string {
    const mins = (this.elapsedMs / 60_000).toFixed(1);
    return (
      `${this.steps}/${this.cfg.budget.max_steps} steps · ` +
      `${this.llmUsed}/${this.cfg.budget.max_llm_requests} LLM calls · ` +
      `${mins}/${this.cfg.budget.max_minutes} min`
    );
  }
}

export function describeBudgetHit(hit: Exclude<BudgetHit, null>): string {
  switch (hit) {
    case "steps":
      return "step budget exhausted";
    case "llm":
      return "model-request budget exhausted";
    case "time":
      return "time budget exhausted";
  }
}
