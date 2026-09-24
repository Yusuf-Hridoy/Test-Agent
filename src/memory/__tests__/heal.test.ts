import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { closeDb, flowBySlug, openMemoryDb, type MemoryDb } from "../db.js";
import { replayFlow } from "../replay.js";
import { runRegression } from "../regress.js";
import { parseVerdict } from "../heal.js";

const ADD = "adding-an-item-updates-the-cart-badge";

const plan = JSON.stringify([
  { id: "O-01", description: "Adding an item updates the cart badge", technique: "state-transition" },
  { id: "O-02", description: "Spare two", technique: "boundary" },
  { id: "O-03", description: "Spare three", technique: "duplicate" },
  { id: "O-04", description: "Spare four", technique: "invalid-input" },
  { id: "O-05", description: "Spare five", technique: "required-field" },
]);

function idFor(t: string, re: RegExp): string {
  return t.split("\n").find((l) => /^ {2}e\d+ /.test(l) && re.test(l))?.trim().split(" ")[0] ?? "e999";
}

/** A scripted healer: one JSON reply, and a count of how often it was asked. */
function healerSaying(reply: string) {
  const state = { calls: 0 };
  const generate = async () => {
    state.calls++;
    return { text: reply, toolCalls: [], usage: {}, finishReason: "stop" };
  };
  return { state, generate: generate as never };
}

describe("healing (P3-T4)", () => {
  let app: FakeApp;
  let dir: string;
  let db: MemoryDb;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-heal-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `forbidden_elements: ["logout", "delete", "payment"]\n` +
        `budget:\n  max_steps: 40\n  max_llm_requests: 30\n  max_minutes: 5\n` +
        `model:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

    let calls = 0;
    const script: ((t: string) => { toolName: string; input: unknown })[] = [
      () => ({ toolName: "goto", input: { url: "/inventory" } }),
      (t) => ({ toolName: "click", input: { id: idFor(t, /Add to cart/) } }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: "badge is 1" } }),
    ];
    const generate = async (req: unknown) => {
      const { messages } = req as { messages: { content: unknown }[] };
      const last = messages.at(-1)!.content;
      const text = typeof last === "string" ? last : JSON.stringify(last);
      if (calls++ === 0) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      const reply =
        script[calls - 2] ??
        (() => ({ toolName: "mark_objective", input: { status: "blocked", note: "done" } }));
      const out = reply(text);
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, toolName: out.toolName, input: out.input }],
        usage: {},
        finishReason: "tool-calls",
      };
    };

    await runSession({ dir, charter: "Add an item", generate: generate as never });
    db = openMemoryDb(dir);
    await replayFlow(flowBySlug(db, ADD)!, { dir, db }); // → verified
  }, 300_000);

  afterAll(async () => {
    closeDb(db);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetRateLimiter();
    app.setAddLabel("Add to cart");
    db.prepare("DELETE FROM heal_events").run();
  });

  it("parses the two verdicts and refuses anything else", () => {
    expect(parseVerdict('{"verdict":"broken","note":"gone"}')).toEqual({
      verdict: "broken",
      note: "gone",
    });
    expect(
      parseVerdict('```json\n{"verdict":"relocated","target":{"role":"button","name":"X"}}\n```'),
    ).toEqual({ verdict: "relocated", target: { role: "button", name: "X", nth: null }, note: "relocated by the model" });
    expect(() => parseVerdict("no json here")).toThrow();
    expect(() => parseVerdict('{"verdict":"maybe"}')).toThrow();
  });

  it("spends nothing on healing when the flag is absent", async () => {
    app.setAddLabel("Put in basket");
    const healer = healerSaying('{"verdict":"broken","note":"never asked"}');
    const result = await runRegression({ dir, requested: ADD, generate: healer.generate });

    expect(result.flows[0]!.outcome).toBe("FAIL");
    expect(healer.state.calls).toBe(0);
    expect(result.healCalls).toBe(0);
  }, 300_000);

  it("relocates a renamed element, patches the flow, and demotes it to draft", async () => {
    // Re-verify first: the previous test left the flow broken.
    app.setAddLabel("Add to cart");
    await replayFlow(flowBySlug(db, ADD)!, { dir, db });
    expect(flowBySlug(db, ADD)!.status).toBe("verified");

    app.setAddLabel("Put in basket");
    const healer = healerSaying(
      '{"verdict":"relocated","target":{"role":"button","name":"Put in basket","nth":0},"note":"the button was renamed"}',
    );
    const result = await runRegression({
      dir,
      requested: ADD,
      heal: true,
      generate: healer.generate,
    });

    const clickSeq = flowBySlug(db, ADD)!.steps.find((s) => s.action === "click")!.seq;
    expect(healer.state.calls).toBe(1);
    expect(result.flows[0]!.outcome).toBe("HEALED");
    expect(result.flows[0]!.healedStep).toBe(clickSeq);
    expect(result.flows[0]!.healNote).toMatch(/renamed/);
    // Healed is not a pass: CI must still go red.
    expect(result.exitCode).toBe(1);
    expect(result.totals).toMatchObject({ passed: 0, healed: 1, failed: 0 });

    const flow = flowBySlug(db, ADD)!;
    expect(flow.status).toBe("draft");
    expect(flow.steps.find((s) => s.action === "click")!.target_name).toBe("Put in basket");
    expect(flow.last_replay_result).toBe(`healed@${clickSeq}`);

    const events = db.prepare("SELECT * FROM heal_events").all() as {
      seq: number;
      old_target: string;
      new_target: string;
      model_note: string;
      session_ref: string;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.old_target).toContain("Add to cart");
    expect(events[0]!.new_target).toContain("Put in basket");
    expect(events[0]!.session_ref).toContain("-replay-");
  }, 300_000);

  it("promotes the healed flow back to verified on a clean, heal-free replay", async () => {
    // The app now genuinely has the new label, and the flow was patched to it.
    app.setAddLabel("Put in basket");
    const result = await runRegression({ dir, requested: ADD, includeDraft: true });
    expect(result.flows[0]!.outcome).toBe("PASS");
    expect(result.healCalls).toBe(0);
    expect(flowBySlug(db, ADD)!.status).toBe("verified");

    // Put the fixture and the flow back for the remaining tests.
    db.prepare(
      "UPDATE flow_steps SET target_name = 'Add to cart' WHERE flow_id = ? AND action = 'click'",
    ).run(flowBySlug(db, ADD)!.id);
    app.setAddLabel("Add to cart");
    await replayFlow(flowBySlug(db, ADD)!, { dir, db });
  }, 300_000);

  it("fails when the relocated target does not work either — no second opinion", async () => {
    app.setAddLabel("Put in basket");
    const healer = healerSaying(
      '{"verdict":"relocated","target":{"role":"button","name":"Nowhere at all"},"note":"guessing"}',
    );
    const result = await runRegression({ dir, requested: ADD, heal: true, generate: healer.generate });

    expect(healer.state.calls).toBe(1); // asked once, never twice
    expect(result.flows[0]!.outcome).toBe("FAIL");
    expect(flowBySlug(db, ADD)!.status).toBe("broken");
    expect(db.prepare("SELECT COUNT(*) AS n FROM heal_events").get()).toEqual({ n: 0 });
  }, 300_000);

  it("reports a `broken` verdict as a failure, with the model's note as context", async () => {
    app.setAddLabel("Add to cart");
    await replayFlow(flowBySlug(db, ADD)!, { dir, db }); // → verified again
    app.setAddLabel("Put in basket");

    const healer = healerSaying(
      '{"verdict":"broken","note":"the add-to-cart control is gone from this page"}',
    );
    const result = await runRegression({ dir, requested: ADD, heal: true, generate: healer.generate });

    expect(result.flows[0]!.outcome).toBe("FAIL");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    // The FLOW failing is the evidence; the note is commentary (§1.6).
    expect(finding.oracle).toBe("regression");
    expect(finding.confidence).toBe("high");
    expect(finding.actual).toContain("Healer's note: the add-to-cart control is gone");
  }, 300_000);

  it("never heals a step a guard refused", async () => {
    const now = "2026-09-23T10:00:00+02:00";
    const start = flowBySlug(db, ADD)!.start_page_key;
    const id = Number(
      db
        .prepare(
          "INSERT INTO flows (slug, name, status, start_page_key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("log-out-flow", "Log out", "verified", start, now, now).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO flow_steps (flow_id, seq, action, target_role, target_name) VALUES (?,?,?,?,?)",
    ).run(id, 1, "click", "link", "Logout");

    const healer = healerSaying('{"verdict":"relocated","target":{"role":"link","name":"Bye"}}');
    const result = await runRegression({
      dir,
      requested: "log-out-flow",
      heal: true,
      generate: healer.generate,
    });

    expect(result.flows[0]!.outcome).toBe("REFUSED");
    expect(healer.state.calls).toBe(0);
    // A refusal is a policy decision, so the flow is not marked broken either.
    expect(flowBySlug(db, "log-out-flow")!.status).toBe("verified");
    db.prepare("DELETE FROM flows WHERE slug = 'log-out-flow'").run();
  }, 300_000);

  it("stops healing once the suite's budget is spent", async () => {
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `forbidden_elements: ["logout", "delete", "payment"]\n` +
        `budget:\n  max_steps: 40\n  max_llm_requests: 30\n  max_minutes: 5\n` +
        `model:\n  min_delay_ms: 0\n` +
        `regress:\n  max_heal_calls: 0\n`,
    );
    app.setAddLabel("Put in basket");
    const healer = healerSaying('{"verdict":"relocated","target":{"role":"button","name":"Put in basket"}}');
    const result = await runRegression({ dir, requested: ADD, heal: true, generate: healer.generate });

    expect(healer.state.calls).toBe(0); // budget refused the call before making it
    expect(result.flows[0]!.outcome).toBe("FAIL");
    expect(result.flows[0]!.healNote).toMatch(/budget spent/);
  }, 300_000);
});
