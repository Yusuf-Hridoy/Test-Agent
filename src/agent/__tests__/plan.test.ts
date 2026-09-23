import { describe, expect, it, vi } from "vitest";
import { extractJsonArray, parsePlan, planSession, PlanFailedError } from "../plan.js";
import { buildExecutorMessages, capSnapshot, executorSystemPrompt, PLANNER_SYSTEM_PROMPT } from "../prompts.js";
import { parseConfig } from "../../config/load.js";
import { SecretStore } from "../../model/redact.js";
import { UsageTracker } from "../../model/usage.js";
import { _resetRateLimiter } from "../../model/ask.js";
import type { Objective, Snapshot } from "../../types.js";

const validPlan = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({
    id: `O-0${i + 1}`,
    description: `Objective ${i + 1}`,
    technique: "happy-path",
  })),
);

describe("plan parsing", () => {
  it("finds the array inside code fences and prose", () => {
    expect(extractJsonArray("Sure!\n```json\n[1,2]\n```\nHope that helps")).toBe("[1,2]");
    expect(extractJsonArray("[{}]")).toBe("[{}]");
    expect(() => extractJsonArray("no array here")).toThrow(/no JSON array/);
  });

  it("validates and normalises objective ids", () => {
    const plan = parsePlan(validPlan);
    expect(plan).toHaveLength(5);
    expect(plan[0]).toMatchObject({ id: "O-01", status: "planned", technique: "happy-path" });

    const oddIds = JSON.stringify(
      Array.from({ length: 5 }, () => ({ id: "first", description: "an objective", technique: "boundary" })),
    );
    expect(parsePlan(oddIds).map((o) => o.id)).toEqual(["O-01", "O-02", "O-03", "O-04", "O-05"]);

    const duplicates = JSON.stringify(
      Array.from({ length: 5 }, () => ({ id: "O-01", description: "an objective", technique: "boundary" })),
    );
    expect(new Set(parsePlan(duplicates).map((o) => o.id)).size).toBe(5);
  });

  it("rejects a plan that is too short or has a bad technique", () => {
    expect(() => parsePlan('[{"id":"O-01","description":"d","technique":"happy-path"}]')).toThrow();
    expect(() =>
      parsePlan(
        JSON.stringify(
          Array.from({ length: 5 }, () => ({ id: "O-01", description: "an objective", technique: "vibes" })),
        ),
      ),
    ).toThrow();
  });
});

const snap: Snapshot = {
  url: "https://app.test/",
  title: "App",
  elements: [{ id: "e1", role: "button", name: "Login", tag: "button" }],
  pageText: "hello",
};

describe("planSession", () => {
  const cfg = parseConfig(`name: t\nbase_url: https://app.test\nmodel:\n  min_delay_ms: 0\n`);

  beforeAllKeys();

  it("retries once with the parse error, then succeeds", async () => {
    _resetRateLimiter();
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "I'd love to help!", toolCalls: [], usage: {}, finishReason: "stop" })
      .mockResolvedValueOnce({ text: validPlan, toolCalls: [], usage: {}, finishReason: "stop" });
    const plan = await planSession({
      charter: "test the login",
      snapshot: snap,
      cfg,
      usage: new UsageTracker(),
      secrets: new SecretStore(),
      generate,
    } as never);
    expect(plan).toHaveLength(5);
    expect(generate).toHaveBeenCalledTimes(2);
    const retry = generate.mock.calls[1]![0] as { messages: { content: string }[] };
    expect(JSON.stringify(retry.messages)).toContain("STRICT JSON ONLY");
  });

  it("throws PlanFailedError after two unusable replies", async () => {
    _resetRateLimiter();
    const generate = vi.fn().mockResolvedValue({ text: "nope", toolCalls: [], usage: {}, finishReason: "stop" });
    await expect(
      planSession({
        charter: "c",
        snapshot: snap,
        cfg,
        usage: new UsageTracker(),
        secrets: new SecretStore(),
        generate,
      } as never),
    ).rejects.toBeInstanceOf(PlanFailedError);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

function beforeAllKeys() {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  process.env.GROQ_API_KEY = "test-key";
  process.env.MISTRAL_API_KEY = "test-key";
}

describe("executor prompt", () => {
  const objective: Objective = {
    id: "O-02",
    description: "Cart badge shows 1 after adding an item",
    technique: "happy-path",
    status: "in-progress",
  };

  it("interpolates objective and remaining budget", () => {
    const p = executorSystemPrompt({ objective: objective.description, stepsLeft: 46, llmLeft: 31 });
    expect(p).toContain("Work ONLY on the current objective: Cart badge shows 1");
    expect(p).toContain("Budget remaining: 46 steps, 31 model calls.");
    expect(p.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("sends only the latest snapshot, plus history and oracle notes", () => {
    const messages = buildExecutorMessages({
      objective,
      snapshot: snap,
      history: ["click e1 → OK", "goto / → OK"],
      oracleNotes: ["http_5xx fired — Server error"],
    });
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content as string;
    expect(text).toContain("CURRENT OBJECTIVE O-02");
    expect(text).toContain("LATEST PAGE SNAPSHOT");
    expect(text).toContain("SYSTEM ORACLE NOTE: http_5xx fired");
    expect(text).toContain("- click e1 → OK");
  });

  it("attaches a pending screenshot as an image part", () => {
    const messages = buildExecutorMessages({
      objective,
      snapshot: snap,
      history: [],
      oracleNotes: [],
      pendingScreenshot: "AAAA",
    });
    const parts = messages[0]!.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
  });

  it("keeps only the last 6 history lines", () => {
    const messages = buildExecutorMessages({
      objective,
      snapshot: snap,
      history: Array.from({ length: 10 }, (_, i) => `step ${i}`),
      oracleNotes: [],
    });
    const text = messages[0]!.content as string;
    expect(text).not.toContain("step 3");
    expect(text).toContain("step 9");
  });
});

describe("capSnapshot", () => {
  const long = (n: number) => "x".repeat(n);

  it("leaves a small snapshot alone", () => {
    expect(capSnapshot("short", 100)).toBe("short");
  });

  it("truncates page text before touching elements", () => {
    const rendered = `URL: /\nELEMENTS (1):\n  e1 button "Go" button\nPAGE TEXT:\n${long(5000)}`;
    const out = capSnapshot(rendered, 1000);
    expect(out.length).toBeLessThanOrEqual(1050);
    expect(out).toContain('e1 button "Go"');
    expect(out).toContain("page text truncated");
  });

  it("drops the tail of the element list when that is not enough", () => {
    const els = Array.from({ length: 200 }, (_, i) => `  e${i + 1} button "Button ${i}" button`).join("\n");
    const out = capSnapshot(`URL: /\nELEMENTS (200):\n${els}\nPAGE TEXT:\n${long(500)}`, 1200);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toContain("e1 button");
    expect(out).not.toContain("e199 button");
  });
});

describe("planner prompt (S6)", () => {
  it("requires impossible charter requirements to be planned, not substituted", () => {
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/EVERY explicit requirement in the charter must appear/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/Never silently replace an impossible/);
  });

  it("does not tell the planner to omit charter-mandated unsafe actions", () => {
    // Safety is the harness's job (CLAUDE.md §3); omitting the objective just
    // hides that the charter was never tested.
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/Never plan logout, account deletion, payments or purchases/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/let the harness\s+refuse the unsafe action/);
  });
});
