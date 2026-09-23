import type { Provider } from "../types.js";

/**
 * Free-tier, tool-calling-capable model IDs, checked against provider docs on
 * 2026-09-18. IDs drift; every one is overridable via `model.ids` in the config.
 */
export const DEFAULT_MODEL_IDS: Record<Provider, string> = {
  // gemini-3.6-flash also works but its free tier is 20 requests PER DAY, which
  // one agent session exhausts. flash-lite has its own (larger) quota bucket,
  // answers in ~1.5s with no thinking tokens, and does tools + vision.
  gemini: "gemini-3.1-flash-lite",
  groq: "openai/gpt-oss-120b", // Groq production model with tool use; text only
  mistral: "mistral-small-latest", // → Mistral Small 4: tool calling + image input
};

/** The env var name Magpie tells you to set for each provider. */
export const API_KEY_ENV: Record<Provider, string> = {
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/**
 * Names accepted for each provider's key, in precedence order. Google's own
 * tooling (gemini-cli, the Python SDK) uses GEMINI_API_KEY, so a key copied from
 * there works without renaming it.
 */
export const API_KEY_ENV_ALIASES: Record<Provider, string[]> = {
  gemini: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
};

/** Whether the default model accepts image parts (drives `look` degradation). */
export const HAS_VISION: Record<Provider, boolean> = {
  gemini: true,
  groq: false,
  mistral: true,
};

export function modelIdFor(provider: Provider, ids?: Partial<Record<Provider, string>>): string {
  return ids?.[provider] ?? DEFAULT_MODEL_IDS[provider];
}

export function apiKeyFor(provider: Provider): string | undefined {
  for (const name of API_KEY_ENV_ALIASES[provider]) {
    const key = process.env[name]?.trim();
    if (key) return key;
  }
  return undefined;
}
