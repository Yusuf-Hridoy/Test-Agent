import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp } from "./fakeapp.js";
import { runSession } from "../session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import type { SessionResult } from "../../types.js";

const plan = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({
    id: `O-0${i + 1}`,
    description: `Objective ${i + 1}`,
    technique: "happy-path",
  })),
);

/** A model that only ever takes screenshots — it never finishes an objective. */
function lookOnlyModel(): (req: unknown) => Promise<unknown> {
  let calls = 0;
  return async () => {
    if (calls++ === 0) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
    return {
      text: "",
      toolCalls: [{ toolCallId: `c${calls}`, toolName: "look", input: {} }],
      usage: {},
      finishReason: "tool-calls",
    };
  };
}

/** A model that only ever asks to wait — it never finishes an objective. */
function stubbornModel(): { generate: (req: unknown) => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    generate: async () => {
      if (calls++ === 0) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, toolName: "wait", input: { ms: 0 } }],
        usage: {},
        finishReason: "tool-calls",
      };
    },
  };
}

describe("harness limits (Hard Rule 3)", () => {
  let app: { url: string; close: () => Promise<void> };
  const dirs: string[] = [];

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function project(budget: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-limits-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture\nbase_url: ${app.url}\n${budget}model:\n  min_delay_ms: 0\n`,
    );
    return dir;
  }

  it("stops at max_steps no matter what the model asks for", async () => {
    const dir = project("budget:\n  max_steps: 8\n  max_llm_requests: 100\n  max_minutes: 5\n");
    const model = stubbornModel();
    const result: SessionResult = await runSession({
      dir,
      charter: "spin forever",
      generate: model.generate as never,
    });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(result.stepCount).toBeLessThanOrEqual(8 + 1); // the step that trips the limit
    expect(fs.existsSync(path.join(result.reportDir, "session.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.reportDir, "trace.zip"))).toBe(true);
  }, 120_000);

  it("stops at max_llm_requests", async () => {
    const dir = project("budget:\n  max_steps: 500\n  max_llm_requests: 6\n  max_minutes: 5\n");
    const model = stubbornModel();
    const result = await runSession({
      dir,
      charter: "spin forever",
      generate: model.generate as never,
    });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(model.calls()).toBeLessThanOrEqual(7);
  }, 120_000);

  it("blocks an objective the agent only photographs (S2)", async () => {
    const dir = project("budget:\n  max_steps: 200\n  max_llm_requests: 40\n  max_minutes: 5\n");
    const result = await runSession({
      dir,
      charter: "look forever",
      generate: lookOnlyModel() as never,
    });
    // `look` never changes the page, so the fingerprint detector must catch it.
    const steps = fs
      .readFileSync(path.join(result.reportDir, "steps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string });
    expect(steps.some((s) => s.action === "force_block")).toBe(true);
    expect(result.objectives.filter((o) => o.status === "blocked").length).toBeGreaterThan(1);
  }, 120_000);

  it("blocks an objective the agent cannot move, instead of looping on it", async () => {
    const dir = project("budget:\n  max_steps: 200\n  max_llm_requests: 60\n  max_minutes: 5\n");
    const model = stubbornModel();
    const result = await runSession({
      dir,
      charter: "spin forever",
      generate: model.generate as never,
    });
    // `wait` never changes the page, so the loop detector forces a block and the
    // session moves on through the plan rather than burning the whole budget here.
    const blocked = result.objectives.filter((o) => o.status === "blocked");
    expect(blocked.length).toBeGreaterThan(1);
    expect(blocked[0]!.note).toMatch(/stopped making progress|budget/i);
    const steps = fs
      .readFileSync(path.join(result.reportDir, "steps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string });
    expect(steps.some((s) => s.action === "force_block")).toBe(true);
  }, 120_000);
});
