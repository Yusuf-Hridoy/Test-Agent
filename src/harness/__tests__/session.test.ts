import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp } from "./fakeapp.js";
import { runSession } from "../session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { writeHtmlReport } from "../../report/html.js";
import { loadConfig } from "../../config/load.js";
import type { SessionResult, StepRecord } from "../../types.js";

/** One scripted model reply. */
type Reply = (text: string) => { toolName: string; input: unknown } | { plainText: string };

const plan = JSON.stringify([
  { id: "O-01", description: "Enter the shop from the landing page", technique: "happy-path" },
  { id: "O-02", description: "Adding an item updates the cart badge", technique: "state-transition" },
  { id: "O-03", description: "The broken page logs nothing to the console", technique: "happy-path" },
  { id: "O-04", description: "Checking out does not fail server-side", technique: "happy-path" },
  { id: "O-05", description: "Destructive and off-site actions are refused", technique: "boundary" },
]);

/** Find the snapshot id the harness just offered for an element name. */
function idFor(promptText: string, name: RegExp): string {
  const line = promptText.split("\n").find((l) => /^ {2}e\d+ /.test(l) && name.test(l));
  return line?.trim().split(" ")[0] ?? "e999";
}

const script: Reply[] = [
  // O-01
  (t) => ({ toolName: "click", input: { id: idFor(t, /Enter the shop/) } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "landed on the inventory page" } }),
  // O-02 — includes a plain-text stall and a `look`
  () => ({ plainText: "Let me think about this one." }),
  () => ({ toolName: "look", input: {} }),
  (t) => ({ toolName: "click", input: { id: idFor(t, /Add to cart/) } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "badge went to 1" } }),
  // O-03 — the broken page logs a console error (hard oracle fires)
  (t) => ({ toolName: "click", input: { id: idFor(t, /Broken page/) } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "page rendered" } }),
  // O-04 — checkout 500s (hard oracle) and the model also reports its own finding
  () => ({ toolName: "goto", input: { url: "/inventory" } }),
  (t) => ({ toolName: "click", input: { id: idFor(t, /Check out/) } }),
  () => ({
    toolName: "report_finding",
    input: {
      title: "Checkout fails silently",
      severity: "high",
      expected: "Checking out confirms the order",
      actual: "Nothing happens on screen and the request fails",
    },
  }),
  () => ({ toolName: "mark_objective", input: { status: "blocked", note: "checkout is broken" } }),
  // O-05 — both guards refuse
  (t) => ({ toolName: "click", input: { id: idFor(t, /Logout/) } }),
  () => ({ toolName: "goto", input: { url: "https://evil.example.com/steal" } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "both actions were refused" } }),
];

describe("runSession (scripted model, local app)", () => {
  let app: { url: string; close: () => Promise<void> };
  let dir: string;
  let result: SessionResult;
  let steps: StepRecord[];
  let calls = 0;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-session-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `forbidden_elements: ["logout", "delete", "payment"]\n` +
        `budget:\n  max_steps: 60\n  max_llm_requests: 40\n  max_minutes: 5\n` +
        `model:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

    const generate = async (req: unknown) => {
      const { messages } = req as { messages: { content: unknown }[] };
      const last = messages.at(-1)!.content;
      const text =
        typeof last === "string"
          ? last
          : (last as { type: string; text?: string }[])
              .map((p) => (p.type === "text" ? p.text : "[image]"))
              .join("\n");

      if (calls++ === 0) {
        return { text: plan, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
      }
      const reply = script[calls - 2];
      if (!reply) {
        return { text: "", toolCalls: [{ toolCallId: `c${calls}`, toolName: "mark_objective", input: { status: "blocked", note: "script exhausted" } }], usage: {}, finishReason: "tool-calls" };
      }
      const out = reply(text);
      if ("plainText" in out) {
        return { text: out.plainText, toolCalls: [], usage: {}, finishReason: "stop" };
      }
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, toolName: out.toolName, input: out.input }],
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: "tool-calls",
      };
    };

    result = await runSession({
      dir,
      charter: "Shop end to end and check nothing destructive is possible",
      generate: generate as never,
    });
    steps = fs
      .readFileSync(path.join(result.reportDir, "steps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as StepRecord);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("completes the session and plans every objective", () => {
    expect(result.status).toBe("COMPLETED");
    expect(result.objectives).toHaveLength(5);
    expect(result.objectives.map((o) => o.status)).not.toContain("planned");
    expect(result.objectives.map((o) => o.status)).not.toContain("in-progress");
  });

  it("writes session.json and checkpoint.json as parseable JSON", () => {
    // Regression (S1): redacting the serialized text truncated any string
    // holding `token=…`, leaving an unparseable file behind.
    for (const file of ["session.json", "checkpoint.json"]) {
      const text = fs.readFileSync(path.join(result.reportDir, file), "utf8");
      expect(() => JSON.parse(text), file).not.toThrow();
    }
  });

  it("writes the whole report-folder contract (brief §1.6)", () => {
    for (const file of ["steps.jsonl", "session.json", "checkpoint.json", "flows.draft.json", "trace.zip"]) {
      expect(fs.existsSync(path.join(result.reportDir, file)), file).toBe(true);
    }
    expect(fs.statSync(path.join(result.reportDir, "trace.zip")).size).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(result.reportDir, "shots")).length).toBeGreaterThan(0);
  });

  it("appends more than ten parseable steps, each with a fingerprint", () => {
    expect(steps.length).toBeGreaterThan(10);
    expect(result.stepCount).toBe(steps.length);
    for (const s of steps) {
      expect(s.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(["model", "harness"]).toContain(s.actor);
    }
    const modelSteps = steps.filter((s) => s.actor === "model" && s.action !== "look");
    expect(modelSteps.every((s) => s.fingerprint.length > 0)).toBe(true);
  });

  it("fires hard oracles for the console error and the 5xx, at high confidence", () => {
    const oracles = result.findings.map((f) => f.oracle);
    expect(oracles).toContain("console_error");
    expect(oracles).toContain("http_5xx");
    const hard = result.findings.filter((f) => f.oracle !== "llm_judgment");
    expect(hard.every((f) => f.confidence === "high")).toBe(true);
    const fiveHundred = result.findings.find((f) => f.oracle === "http_5xx")!;
    expect(fiveHundred.severity).toBe("high");
    expect(fiveHundred.network?.join()).toContain("500");
  });

  it("ignores failed requests to hosts outside the app under test (S1)", () => {
    // The fixture page fires a 401 telemetry call via a different host spelling
    // (localhost vs 127.0.0.1), which puts it outside scope.include.
    expect(result.findings.some((f) => /telemetry/i.test(JSON.stringify(f)))).toBe(false);
    expect(result.observations.some((o) => o.type === "third_party_request_failed")).toBe(true);
  });

  it("files one finding per defect, not one per occurrence (S1)", () => {
    const keys = result.findings.map((f) => `${f.oracle}|${f.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("records the model's own finding as low-confidence llm_judgment (Hard Rule 8)", () => {
    const judged = result.findings.find((f) => f.oracle === "llm_judgment")!;
    expect(judged.confidence).toBe("low");
    expect(judged.title).toBe("Checkout fails silently");
    expect(judged.objectiveId).toBe("O-04");
  });

  it("gives every finding evidence that exists on disk", () => {
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      // Hard Rule 5 — never an empty repro, even when the model reports before
      // it acts (S6: the PayPal finding arrived as an objective's first move).
      expect(f.steps.length, `${f.id} repro steps`).toBeGreaterThan(0);
      expect(f.screenshots.length, `${f.id} screenshots`).toBeGreaterThan(0);
      for (const shot of f.screenshots) {
        expect(fs.existsSync(path.join(result.reportDir, shot)), shot).toBe(true);
      }
    }
  });

  it("marks an objective that produced findings as `finding`, not `passed`", () => {
    const o3 = result.objectives.find((o) => o.id === "O-03")!;
    expect(o3.status).toBe("finding");
  });

  it("refuses the forbidden element and the off-scope navigation (Hard Rule 4)", () => {
    const refusals = steps.filter((s) => !s.result.ok).map((s) => s.result.detail ?? "");
    expect(refusals.some((d) => /REFUSED: 'Logout' matches forbidden element 'logout'/.test(d))).toBe(true);
    expect(refusals.some((d) => /BLOCKED by scope guard: .*outside allowed scope/.test(d))).toBe(true);
    // A refusal is never an application finding.
    expect(result.findings.some((f) => /logout|evil\.example/i.test(f.title))).toBe(false);
  });

  it("nudges a plain-text reply back to a tool call instead of counting a step", () => {
    expect(steps.some((s) => s.action === "look")).toBe(true);
    const clicks = steps.filter((s) => s.action === "click");
    expect(clicks.length).toBeGreaterThanOrEqual(4);
  });

  it("drafts Phase-2 flows for passed objectives only, with role+name targets", () => {
    const flows = JSON.parse(fs.readFileSync(path.join(result.reportDir, "flows.draft.json"), "utf8"));
    const ids = flows.map((f: { objectiveId: string }) => f.objectiveId);
    expect(ids).toContain("O-01");
    expect(ids).not.toContain("O-04"); // blocked
    // Targets must name the element the model actually clicked, resolved against
    // the snapshot it saw — not the renumbered one that follows the action.
    const first = flows.find((f: { objectiveId: string }) => f.objectiveId === "O-01");
    expect(first.actions[0].target).toEqual({ role: "link", name: "Enter the shop" });
    for (const flow of flows) {
      for (const action of flow.actions) {
        expect(action).not.toHaveProperty("id");
        if (action.target) expect(Object.keys(action.target).sort()).toEqual(["name", "role"]);
      }
    }
  });

  it("renders a self-contained HTML report from the run", () => {
    const html = writeHtmlReport({
      result,
      cfg: loadConfig(dir),
      steps,
      budgetSummary: "x",
      providerSummary: "gemini 16",
    });
    const text = fs.readFileSync(html, "utf8");
    expect(text).not.toMatch(/(src|href)="https?:\/\//i);
    expect(text).toContain("data:image/png;base64,");
    expect(text).toContain("F-001");
  });
});
