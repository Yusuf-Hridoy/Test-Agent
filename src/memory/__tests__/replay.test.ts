import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { PROVIDERS } from "../../types.js";
import { closeDb, flowBySlug, listFlows, openMemoryDb, type MemoryDb } from "../db.js";
import { replayFlow, SECRET_STEP_REASON } from "../replay.js";
import { SECRET_PLACEHOLDER } from "../types.js";

/**
 * Record with a scripted model, then replay with none. The point of the phase
 * in one test: the second run costs nothing and still drives a real browser.
 */
const plan = JSON.stringify([
  { id: "O-01", description: "Enter the shop from the landing page", technique: "happy-path" },
  { id: "O-02", description: "Adding an item updates the cart badge", technique: "state-transition" },
  { id: "O-03", description: "Unrelated objective", technique: "boundary" },
  { id: "O-04", description: "Another unrelated objective", technique: "duplicate" },
  { id: "O-05", description: "A third unrelated objective", technique: "invalid-input" },
]);

function idFor(promptText: string, name: RegExp): string {
  const line = promptText.split("\n").find((l) => /^ {2}e\d+ /.test(l) && name.test(l));
  return line?.trim().split(" ")[0] ?? "e999";
}

const script: ((t: string) => { toolName: string; input: unknown })[] = [
  (t) => ({ toolName: "click", input: { id: idFor(t, /Enter the shop/) } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "in the shop" } }),
  (t) => ({ toolName: "click", input: { id: idFor(t, /Add to cart/) } }),
  () => ({ toolName: "mark_objective", input: { status: "passed", note: "badge went to 1" } }),
  () => ({ toolName: "mark_objective", input: { status: "blocked", note: "not part of this test" } }),
  () => ({ toolName: "mark_objective", input: { status: "blocked", note: "not part of this test" } }),
  () => ({ toolName: "mark_objective", input: { status: "blocked", note: "not part of this test" } }),
];

describe("replayFlow (recorded by a scripted session, replayed with no model)", () => {
  let app: FakeApp;
  let dir: string;
  let db: MemoryDb;
  let calls = 0;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-replay-"));
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
      const text = typeof last === "string" ? last : JSON.stringify(last);
      if (calls++ === 0) {
        return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      }
      const reply =
        script[calls - 2] ??
        (() => ({ toolName: "mark_objective", input: { status: "blocked", note: "script done" } }));
      const out = reply(text);
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, toolName: out.toolName, input: out.input }],
        usage: {},
        finishReason: "tool-calls",
      };
    };

    await runSession({
      dir,
      charter: "Enter the shop and add an item",
      generate: generate as never,
    });
    db = openMemoryDb(dir);
  }, 180_000);

  afterAll(async () => {
    closeDb(db);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recorded both passed objectives as draft flows", () => {
    const slugs = listFlows(db).map((f) => f.slug);
    expect(slugs).toContain("enter-the-shop-from-the-landing-page");
    expect(slugs).toContain("adding-an-item-updates-the-cart-badge");
    expect(listFlows(db, "draft")).toHaveLength(2);
  });

  it("replays a flow against the live app and spends nothing", async () => {
    const flow = flowBySlug(db, "enter-the-shop-from-the-landing-page")!;
    const result = await replayFlow(flow, { dir, db });

    expect(result.reason ?? "").toBe("");
    expect(result.passed).toBe(true);
    expect(result.stepsRun).toBe(flow.steps.length);
    // The economic claim of Phase 2, asserted rather than assumed.
    for (const p of PROVIDERS) expect(result.usage[p].requests).toBe(0);

    // A PASS promotes a draft to verified.
    expect(flowBySlug(db, flow.slug)!.status).toBe("verified");
    expect(flowBySlug(db, flow.slug)!.last_replay_result).toBe("pass");
  }, 120_000);

  it("writes a replay report folder with steps and a trace", async () => {
    const dirs = fs.readdirSync(path.join(dir, "reports")).filter((d) => d.includes("-replay-"));
    expect(dirs.length).toBeGreaterThan(0);
    const folder = path.join(dir, "reports", dirs[0]!);
    expect(fs.existsSync(path.join(folder, "steps.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(folder, "replay.json"))).toBe(true);
    const steps = fs
      .readFileSync(path.join(folder, "steps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { actor: string });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.actor === "harness")).toBe(true);
  });

  it("fails at the exact step when the app changes, and marks the flow broken", async () => {
    const flow = flowBySlug(db, "adding-an-item-updates-the-cart-badge")!;
    const target = flow.steps.find((s) => s.target_name === "Add to cart")!;
    expect(target).toBeTruthy();

    app.setAddLabel("Put in basket"); // the button a tester would say "moved"
    const result = await replayFlow(flow, { dir, db });

    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe(target.seq);
    expect(result.reason).toMatch(/no element matched/i);
    expect(flowBySlug(db, flow.slug)!.status).toBe("broken");
    expect(flowBySlug(db, flow.slug)!.last_replay_result).toBe(`fail@${target.seq}`);

    // Evidence, not just a verdict (Hard Rule 5).
    const folder = result.reportDir;
    expect(fs.readdirSync(path.join(folder, "shots")).length).toBeGreaterThan(0);
    const detail = fs.readFileSync(path.join(folder, "steps.jsonl"), "utf8");
    expect(detail).toContain("no element matched");
  }, 120_000);

  it("refuses to replay a step whose value was a secret", async () => {
    const now = "2026-09-23T10:00:00+02:00";
    const start = flowBySlug(db, "enter-the-shop-from-the-landing-page")!.start_page_key;
    const id = Number(
      db
        .prepare(
          "INSERT INTO flows (slug, name, status, start_page_key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("log-in", "Log in", "draft", start, now, now).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO flow_steps (flow_id, seq, action, target_role, target_name, value) VALUES (?,?,?,?,?,?)",
    ).run(id, 1, "fill", "textbox", "Username", SECRET_PLACEHOLDER);

    const result = await replayFlow(flowBySlug(db, "log-in")!, { dir, db });
    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(result.reason).toBe(SECRET_STEP_REASON);
    expect(flowBySlug(db, "log-in")!.status).toBe("broken");
  }, 120_000);

  it("re-verifies a broken flow once the app is fixed again", async () => {
    app.setAddLabel("Add to cart");
    const flow = flowBySlug(db, "adding-an-item-updates-the-cart-badge")!;
    const result = await replayFlow(flow, { dir, db });
    expect(result.passed).toBe(true);
    expect(flowBySlug(db, flow.slug)!.status).toBe("verified");
  }, 120_000);
});
