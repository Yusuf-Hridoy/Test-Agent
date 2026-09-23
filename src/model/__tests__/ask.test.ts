import { beforeEach, describe, expect, it, vi } from "vitest";
import { askModel, isConnectionError, ModelExhaustedError, providerChain, _internals, _resetRateLimiter } from "../ask.js";
import { SecretStore } from "../redact.js";
import { UsageTracker } from "../usage.js";
import { parseConfig } from "../../config/load.js";
import type { CoreMessage } from "ai";

const cfg = parseConfig(
  `name: t\nbase_url: https://example.com\nmodel:\n  min_delay_ms: 0\n`,
);

function ok(text: string) {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 3 },
    finishReason: "stop",
  } as never;
}

describe("provider chain", () => {
  it("is primary then fallbacks, de-duplicated", () => {
    expect(providerChain(cfg)).toEqual(["gemini", "groq", "mistral"]);
    const odd = parseConfig(
      `name: t\nbase_url: https://example.com\nmodel:\n  primary: groq\n  fallback: [groq, gemini]\n`,
    );
    expect(providerChain(odd)).toEqual(["groq", "gemini"]);
  });
});

describe("rate-limit classification", () => {
  it("recognises quota and overload errors", () => {
    expect(_internals.isRateLimited({ statusCode: 429 })).toBe(true);
    expect(_internals.isRateLimited({ statusCode: 503 })).toBe(true);
    expect(_internals.isRateLimited({ message: "RESOURCE_EXHAUSTED: quota" })).toBe(true);
    expect(_internals.isRateLimited({ message: "invalid api key" })).toBe(false);
    expect(_internals.isRateLimited({ statusCode: 400 })).toBe(false);
  });
});

describe("askModel", () => {
  beforeEach(() => {
    _resetRateLimiter();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.MISTRAL_API_KEY = "test-mistral-key";
  });

  const req = { system: "sys", messages: [{ role: "user", content: "hi" }] as CoreMessage[], tools: {} };

  it("records usage for the provider that answered", async () => {
    const usage = new UsageTracker();
    const res = await askModel(req, cfg, usage, new SecretStore(), vi.fn().mockResolvedValue(ok("PONG")));
    expect(res.text).toBe("PONG");
    expect(res.provider).toBe("gemini");
    expect(usage.snapshot().gemini).toEqual({ requests: 1, inputTokens: 10, outputTokens: 3 });
  });

  it("retries once on 429, then fails over to the next provider", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 429, message: "rate limit" })
      .mockRejectedValueOnce({ statusCode: 429, message: "rate limit" })
      .mockResolvedValueOnce(ok("from groq"));
    const usage = new UsageTracker();
    const res = await askModel(req, cfg, usage, new SecretStore(), generate);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(res.provider).toBe("groq");
    expect(usage.requestsFor("gemini")).toBe(0);
    expect(usage.requestsFor("groq")).toBe(1);
  }, 20_000);

  it("does not retry a non-quota error, but still fails over", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 401, message: "invalid api key" })
      .mockResolvedValueOnce(ok("from groq"));
    const res = await askModel(req, cfg, new UsageTracker(), new SecretStore(), generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(res.provider).toBe("groq");
  });

  it("throws ModelExhaustedError listing every attempt", async () => {
    const generate = vi.fn().mockRejectedValue({ statusCode: 401, message: "nope" });
    await expect(
      askModel(req, cfg, new UsageTracker(), new SecretStore(), generate),
    ).rejects.toBeInstanceOf(ModelExhaustedError);
  });

  it("redacts secrets out of system and messages before sending", async () => {
    const generate = vi.fn().mockResolvedValue(ok("x"));
    const secrets = new SecretStore(["secret_sauce"]);
    await askModel(
      {
        system: "password: secret_sauce",
        messages: [{ role: "user", content: "typed secret_sauce into the field" }],
        tools: {},
      },
      cfg,
      new UsageTracker(),
      secrets,
      generate,
    );
    const sent = generate.mock.calls[0]![0] as { system: string; messages: CoreMessage[] };
    expect(sent.system).not.toContain("secret_sauce");
    expect(JSON.stringify(sent.messages)).not.toContain("secret_sauce");
  });

  it("strips images for providers without vision and reports the degradation", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 401, message: "no key" })
      .mockResolvedValueOnce(ok("x"));
    const messages = [
      { role: "user", content: [{ type: "image", image: "AAA" }, { type: "text", text: "look" }] },
    ] as CoreMessage[];
    const res = await askModel({ system: "s", messages, tools: {} }, cfg, new UsageTracker(), new SecretStore(), generate);
    const sent = generate.mock.calls[1]![0] as { messages: CoreMessage[] };
    expect(JSON.stringify(sent.messages)).not.toContain('"image"');
    expect(JSON.stringify(sent.messages)).toContain("screenshot omitted");
    expect(res.provider).toBe("groq");
    expect(res.degraded).toMatch(/no vision/);
  });
});

describe("transient provider errors", () => {
  it("recognises Google's 'high demand' wording as retryable", () => {
    expect(
      _internals.isRateLimited({
        message:
          "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
      }),
    ).toBe(true);
  });

  it("recognises transient 5xx status codes", () => {
    for (const statusCode of [500, 502, 503, 504, 529]) {
      expect(_internals.isRateLimited({ statusCode }), String(statusCode)).toBe(true);
    }
  });

  it("still treats auth and bad-request errors as permanent", () => {
    expect(_internals.isRateLimited({ statusCode: 401, message: "API key not valid" })).toBe(false);
    expect(_internals.isRateLimited({ statusCode: 404, message: "model not found" })).toBe(false);
  });
});

describe("request timeout (S2)", () => {
  it("passes an abort signal so a hung provider cannot outlive the budget", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    _resetRateLimiter();
    const generate = vi.fn().mockResolvedValue(ok("x"));
    await askModel(
      { system: "s", messages: [{ role: "user", content: "hi" }], tools: {} },
      cfg,
      new UsageTracker(),
      new SecretStore(),
      generate,
    );
    const sent = generate.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(sent.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("treats an abort/timeout as retryable", () => {
    expect(_internals.isRateLimited({ name: "TimeoutError", message: "The operation was aborted due to timeout" })).toBe(true);
  });
});

describe("network failure vs provider failure (S3/S4)", () => {
  const connErr = Object.assign(new Error("fetch failed"), {
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND generativelanguage.googleapis.com" },
  });

  it("recognises connection-level errors", () => {
    expect(isConnectionError(connErr)).toBe(true);
    expect(isConnectionError(new Error("getaddrinfo EAI_AGAIN api.groq.com"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(isConnectionError(new Error("You exceeded your current quota"))).toBe(false);
    expect(isConnectionError(new Error("API key not valid"))).toBe(false);
  });

  it("flags networkFailure when every provider failed to connect", async () => {
    _resetRateLimiter();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
    process.env.GROQ_API_KEY = "k";
    process.env.MISTRAL_API_KEY = "k";
    const generate = vi.fn().mockRejectedValue(connErr);
    await expect(
      askModel({ system: "s", messages: [{ role: "user", content: "hi" }], tools: {} }, cfg, new UsageTracker(), new SecretStore(), generate),
    ).rejects.toMatchObject({ name: "ModelExhaustedError", networkFailure: true });
  }, 30_000);

  it("does NOT flag networkFailure when the cause is quota", async () => {
    _resetRateLimiter();
    const generate = vi.fn().mockRejectedValue(new Error("You exceeded your current quota"));
    await expect(
      askModel({ system: "s", messages: [{ role: "user", content: "hi" }], tools: {} }, cfg, new UsageTracker(), new SecretStore(), generate),
    ).rejects.toMatchObject({ networkFailure: false });
  }, 60_000);
});
