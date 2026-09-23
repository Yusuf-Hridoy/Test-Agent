import { generateText, type CoreMessage, type ToolSet } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";
import type { MagpieConfig, Provider } from "../types.js";
import { sleep } from "../util.js";
import { apiKeyFor, HAS_VISION, modelIdFor } from "./providers.js";
import type { SecretStore } from "./redact.js";
import type { UsageTracker } from "./usage.js";

export class ModelExhaustedError extends Error {
  constructor(
    public readonly attempts: string[],
    /**
     * Every provider failed with a connection-level error, i.e. the machine has
     * no working network — an environment problem, not a spent budget. Without
     * this a real outage (Wi-Fi off) ends the session as BUDGET_EXHAUSTED,
     * because the model call fails before any browser action can be classified.
     */
    public readonly networkFailure = false,
  ) {
    super(`All model providers failed:\n${attempts.map((a) => `  - ${a}`).join("\n")}`);
    this.name = "ModelExhaustedError";
  }
}

/** Connection-level failures: the request never reached the provider. */
export function isConnectionError(err: unknown): boolean {
  const e = err as { message?: string; name?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? "";
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ECONNRESET|EPIPE)$/.test(code)) {
    return true;
  }
  const msg = `${e?.name ?? ""} ${e?.message ?? ""} ${e?.cause?.message ?? ""}`.toLowerCase();
  return /econnrefused|enotfound|eai_again|enetunreach|enetdown|ehostunreach|econnreset|fetch failed|network error|socket hang up|getaddrinfo|dns/.test(
    msg,
  );
}

/** Test seam: lets a unit test stand in for the SDK call. */
export type GenerateFn = typeof generateText;

export interface AskRequest {
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
}

export interface AskToolCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
}

export interface AskResult {
  provider: Provider;
  modelId: string;
  text: string;
  toolCalls: AskToolCall[];
  finishReason: string;
  /** Set when the request had to be degraded (e.g. images dropped). */
  degraded?: string;
}

const RETRY_BACKOFF_MS = 10_000;
/**
 * No provider call may hang the session. Hard Rule 3 puts every limit in the
 * harness, and an unbounded HTTP request would quietly outlive max_minutes —
 * one live probe of `gemini-flash-latest` never answered at all.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** Last call time per provider, so min_delay_ms is honoured across the session. */
const lastCallAt = new Map<Provider, number>();

/** Test seam: reset the rate-limiter clock. */
export function _resetRateLimiter(): void {
  lastCallAt.clear();
}

function buildModel(provider: Provider, cfg: MagpieConfig): LanguageModel {
  const apiKey = apiKeyFor(provider);
  if (!apiKey) throw new Error(`no API key`);
  const id = modelIdFor(provider, cfg.model.ids);
  switch (provider) {
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(id);
    case "groq":
      return createGroq({ apiKey })(id);
    case "mistral":
      return createMistral({ apiKey })(id);
  }
}

/** [primary, ...fallback], de-duplicated, order preserved. */
export function providerChain(cfg: MagpieConfig): Provider[] {
  return [...new Set<Provider>([cfg.model.primary, ...cfg.model.fallback])];
}

/**
 * Transient provider-side failures worth one backoff+retry before failing over.
 * Providers word these very differently — Google says "experiencing high demand"
 * for what Anthropic calls "overloaded" and OpenAI calls a rate limit.
 */
function isRateLimited(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string; name?: string };
  const code = e?.statusCode ?? e?.status;
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504 || code === 529) {
    return true;
  }
  const msg = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /rate.?limit|quota|too many requests|overloaded|resource.?exhausted|unavailable|high demand|try again later|temporarily|capacity|server error|timeout|timed out|aborted/.test(
    msg,
  );
}

function redactMessages(messages: CoreMessage[], secrets: SecretStore): CoreMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { ...m, content: secrets.redact(m.content) } as CoreMessage;
    }
    const parts = (m.content as unknown[]).map((part) => {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text" && typeof p.text === "string") {
        return { ...p, text: secrets.redact(p.text) };
      }
      return part;
    });
    return { ...m, content: parts } as CoreMessage;
  });
}

function hasImagePart(messages: CoreMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as unknown[]).some((p) => (p as { type?: string })?.type === "image"),
  );
}

/** Drop image parts for providers without vision, leaving a note in their place. */
function stripImages(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = (m.content as unknown[]).filter(
      (p) => (p as { type?: string })?.type !== "image",
    );
    if (parts.length === (m.content as unknown[]).length) return m;
    parts.push({ type: "text", text: "[screenshot omitted: provider has no vision]" });
    return { ...m, content: parts } as CoreMessage;
  });
}

/**
 * One single-shot model call, rate-limited, redacted, with retry + failover.
 * The agent loop lives in the harness — never in the SDK (CLAUDE.md §3).
 */
export async function askModel(
  req: AskRequest,
  cfg: MagpieConfig,
  usage: UsageTracker,
  secrets: SecretStore,
  generate: GenerateFn | undefined = generateText,
): Promise<AskResult> {
  const attempts: string[] = [];
  let sawFailure = false;
  let allConnectionFailures = true;
  const system = secrets.redact(req.system);
  const redacted = redactMessages(req.messages, secrets);
  const carriesImages = hasImagePart(redacted);

  for (const provider of providerChain(cfg)) {
    let model: LanguageModel;
    try {
      model = buildModel(provider, cfg);
    } catch (err) {
      attempts.push(`${provider}: ${(err as Error).message}`);
      continue;
    }

    const modelId = modelIdFor(provider, cfg.model.ids);
    let degraded: string | undefined;
    let messages = redacted;
    if (carriesImages && !HAS_VISION[provider]) {
      messages = stripImages(redacted);
      degraded = `${provider} has no vision — screenshot dropped from this request`;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      await respectRateLimit(provider, cfg.model.min_delay_ms);
      try {
        const res = await (generate ?? generateText)({
          model,
          system,
          messages,
          tools: req.tools,
          toolChoice: "auto",
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        usage.record(provider, res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0);
        return {
          provider,
          modelId,
          text: res.text ?? "",
          toolCalls: (res.toolCalls ?? []).map((c) => ({
            toolName: c.toolName as string,
            input: (c as { input: unknown }).input,
            toolCallId: c.toolCallId,
          })),
          finishReason: String(res.finishReason ?? "unknown"),
          ...(degraded ? { degraded } : {}),
        };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        sawFailure = true;
        if (!isConnectionError(err)) allConnectionFailures = false;
        attempts.push(`${provider} (${modelId}): ${message.slice(0, 200)}`);
        if (attempt === 0 && isRateLimited(err)) {
          await sleep(RETRY_BACKOFF_MS);
          continue; // one retry after backoff, then fail over
        }
        break;
      }
    }
  }

  throw new ModelExhaustedError(attempts, sawFailure && allConnectionFailures);
}

async function respectRateLimit(provider: Provider, minDelayMs: number): Promise<void> {
  const last = lastCallAt.get(provider);
  if (last !== undefined) {
    const wait = minDelayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastCallAt.set(provider, Date.now());
}

export const _internals = { isRateLimited, redactMessages, stripImages, hasImagePart };
