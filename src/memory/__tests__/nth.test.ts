import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { closeDb, flowBySlug, openMemoryDb, type MemoryDb } from "../db.js";
import { replayFlow } from "../replay.js";

/**
 * The gap Phase 2 acceptance found: six identical "Add to cart" buttons make the
 * most valuable flow on a catalogue page unreplayable. Recording WHICH one was
 * clicked is fidelity, not healing — and it must survive into replay.
 */
const plan = JSON.stringify([
  { id: "O-01", description: "Add the third catalogue item to the cart", technique: "happy-path" },
  { id: "O-02", description: "Spare objective two", technique: "boundary" },
  { id: "O-03", description: "Spare objective three", technique: "duplicate" },
  { id: "O-04", description: "Spare objective four", technique: "invalid-input" },
  { id: "O-05", description: "Spare objective five", technique: "required-field" },
]);

/** The id of the Nth (1-based) snapshot line matching a name. */
function nthIdFor(promptText: string, name: RegExp, n: number): string {
  const lines = promptText.split("\n").filter((l) => /^ {2}e\d+ /.test(l) && name.test(l));
  return lines[n - 1]?.trim().split(" ")[0] ?? "e999";
}

describe("target_nth (P3-T1)", () => {
  let app: FakeApp;
  let dir: string;
  let db: MemoryDb;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-nth-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `budget:\n  max_steps: 40\n  max_llm_requests: 30\n  max_minutes: 5\n` +
        `model:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

    let calls = 0;
    const script: ((t: string) => { toolName: string; input: unknown })[] = [
      () => ({ toolName: "goto", input: { url: "/catalogue" } }),
      // The THIRD of three identical buttons.
      (t) => ({ toolName: "click", input: { id: nthIdFor(t, /Add to cart/, 3) } }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: "item C added" } }),
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

    await runSession({ dir, charter: "Add the third item", generate: generate as never });
    db = openMemoryDb(dir);
  }, 180_000);

  afterAll(async () => {
    closeDb(db);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records which of the identical buttons was clicked", () => {
    const flow = flowBySlug(db, "add-the-third-catalogue-item-to-the-cart")!;
    expect(flow).toBeTruthy();
    const click = flow.steps.find((s) => s.action === "click")!;
    expect(click.target_name).toBe("Add to cart");
    expect(click.target_nth).toBe(2); // 0-based: the third button
    expect(app.lastPicked()).toBe("Item C");
  });

  it("replays the SAME button, not merely a matching one", async () => {
    app.setCatalogue(["Item A", "Item B", "Item C"]); // clears lastPicked
    expect(app.lastPicked()).toBeUndefined();

    const flow = flowBySlug(db, "add-the-third-catalogue-item-to-the-cart")!;
    const result = await replayFlow(flow, { dir, db });

    expect(result.reason ?? "").toBe("");
    expect(result.passed).toBe(true);
    // The proof: the server saw item C, so replay clicked the third button.
    expect(app.lastPicked()).toBe("Item C");
  }, 120_000);

  it("still refuses a legacy flow with no recorded position, and says why", async () => {
    const flow = flowBySlug(db, "add-the-third-catalogue-item-to-the-cart")!;
    const click = flow.steps.find((s) => s.action === "click")!;
    // Exactly what a Phase-2-era row looks like.
    db.prepare("UPDATE flow_steps SET target_nth = NULL WHERE flow_id = ? AND seq = ?").run(
      flow.id,
      click.seq,
    );
    app.setCatalogue(["Item A", "Item B", "Item C"]);

    const result = await replayFlow(flowBySlug(db, flow.slug)!, { dir, db });
    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe(click.seq);
    expect(result.reason).toMatch(/3 elements matched/);
    expect(result.reason).toMatch(/re-record it to gain nth targeting/);
    expect(app.lastPicked()).toBeUndefined(); // nothing was clicked on a guess
  }, 120_000);

  it("teaches a legacy flow its positions when the charter is re-run", async () => {
    const flow = flowBySlug(db, "add-the-third-catalogue-item-to-the-cart")!;
    expect(flow.steps.find((s) => s.action === "click")!.target_nth).toBeNull();

    // Re-ingest the same report: same flow, now carrying a position.
    const { ingestSession } = await import("../ingest.js");
    const reportDir = fs
      .readdirSync(path.join(dir, "reports"))
      .map((d) => path.join(dir, "reports", d))
      .find((d) => fs.existsSync(path.join(d, "flows.draft.json")))!;
    const result = JSON.parse(fs.readFileSync(path.join(reportDir, "session.json"), "utf8"));
    const twin = path.join(dir, "reports", "twin");
    fs.cpSync(reportDir, twin, { recursive: true });
    const summary = ingestSession(db, { ...result, reportDir: twin }, twin);

    expect(summary.flowsCreated).toEqual([]); // not a duplicate flow
    expect(flowBySlug(db, flow.slug)!.steps.find((s) => s.action === "click")!.target_nth).toBe(2);
  });
});
