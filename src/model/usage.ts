import { PROVIDERS, type Provider, type ProviderUsage } from "../types.js";

/** Per-provider request/token counter. Budgets read `totalRequests()`. */
export class UsageTracker {
  private readonly byProvider: Record<Provider, ProviderUsage> = {
    gemini: { requests: 0, inputTokens: 0, outputTokens: 0 },
    groq: { requests: 0, inputTokens: 0, outputTokens: 0 },
    mistral: { requests: 0, inputTokens: 0, outputTokens: 0 },
  };

  record(provider: Provider, inputTokens = 0, outputTokens = 0): void {
    const u = this.byProvider[provider];
    u.requests += 1;
    u.inputTokens += inputTokens;
    u.outputTokens += outputTokens;
  }

  totalRequests(): number {
    return PROVIDERS.reduce((n, p) => n + this.byProvider[p].requests, 0);
  }

  requestsFor(provider: Provider): number {
    return this.byProvider[provider].requests;
  }

  snapshot(): Record<Provider, ProviderUsage> {
    return {
      gemini: { ...this.byProvider.gemini },
      groq: { ...this.byProvider.groq },
      mistral: { ...this.byProvider.mistral },
    };
  }

  /** e.g. "gemini 25 / groq 4" — providers that were never used are omitted. */
  summary(): string {
    const used = PROVIDERS.filter((p) => this.byProvider[p].requests > 0);
    if (used.length === 0) return "no model calls";
    return used.map((p) => `${p} ${this.byProvider[p].requests}`).join(" / ");
  }
}
