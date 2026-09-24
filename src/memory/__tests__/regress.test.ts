import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { PROVIDERS } from "../../types.js";
import { closeDb, flowBySlug, listFlows, openMemoryDb, type MemoryDb } from "../db.js";
import { replayFlow } from "../replay.js";
import {
  executedCount,
  exitCodeFor,
  runRegression,
  selectFlows,
  skipWarning,
  suiteSchema,
  tally,
} from "../regress.js";
import { renderSuiteReport } from "../../report/suite.js";
import { renderSuiteTerminal } from "../../report/terminal.js";

const ENTER = "enter-the-shop-from-the-landing-page";
const ADD = "adding-an-item-updates-the-cart-badge";
const BROKEN_PAGE = "the-broken-page-renders";

const plan = JSON.stringify([
  { id: "O-01", description: "Enter the shop from the landing page", technique: "happy-path" },
  { id: "O-02", description: "Adding an item updates the cart badge", technique: "state-transition" },
  { id: "O-03", description: "The broken page renders", technique: "happy-path" },
  { id: "O-04", description: "Spare objective four", technique: "duplicate" },
  { id: "O-05", description: "Spare objective five", technique: "boundary" },
]);

function idFor(t: string, re: RegExp): string {
  return t.split("\n").find((l) => /^ {2}e\d+ /.test(l) && re.test(l))?.trim().split(" ")[0] ?? "e999";
}

describe("regression suite (P3-T2)", () => {
  let app: FakeApp;
  let dir: string;
  let db: MemoryDb;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-regress-"));
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
      (t) => ({ toolName: "click", input: { id: idFor(t, /Enter the shop/) } }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: "in the shop" } }),
      (t) => ({ toolName: "click", input: { id: idFor(t, /Add to cart/) } }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: "badge is 1" } }),
      (t) => ({ toolName: "click", input: { id: idFor(t, /Broken page/) } }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: "rendered" } }),
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

    await runSession({ dir, charter: "Shop end to end", generate: generate as never });
    db = openMemoryDb(dir);

    // Promote two of the three flows by replaying them; the third stays draft.
    for (const slug of [ENTER, ADD]) {
      await replayFlow(flowBySlug(db, slug)!, { dir, db });
    }
  }, 300_000);

  afterAll(async () => {
    closeDb(db);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("selects verified flows and explains every flow it skips", () => {
    expect(listFlows(db, "verified").map((f) => f.slug).sort()).toEqual([ADD, ENTER].sort());
    const selection = selectFlows(db, "all");
    expect(selection.run.map((f) => f.slug).sort()).toEqual([ADD, ENTER].sort());
    expect(selection.skipped.map((s) => s.flow.slug)).toEqual([BROKEN_PAGE]);
    expect(selection.skipped[0]!.why).toMatch(/draft/);

    // --include-draft widens the net; a named flow runs whatever its status.
    expect(selectFlows(db, "all", true).run).toHaveLength(3);
    expect(selectFlows(db, BROKEN_PAGE).run.map((f) => f.slug)).toEqual([BROKEN_PAGE]);
    expect(selectFlows(db, "no-such-flow").missing).toBe("no-such-flow");
  });

  it("runs a mixed suite, spends nothing, and reports each outcome", async () => {
    app.setAddLabel("Put in basket"); // one verified flow now fails
    const result = await runRegression({ dir, requested: "all" });

    const byFlow = Object.fromEntries(result.flows.map((f) => [f.slug, f]));
    expect(byFlow[ENTER]!.outcome).toBe("PASS");
    expect(byFlow[ADD]!.outcome).toBe("FAIL");
    expect(byFlow[ADD]!.failedAt).toBe(1);
    expect(byFlow[ADD]!.statusAfter).toBe("broken");
    // The skipped flow is listed, not quietly dropped.
    expect(byFlow[BROKEN_PAGE]!.outcome).toBe("SKIPPED");
    expect(byFlow[BROKEN_PAGE]!.reason).toMatch(/draft/);

    expect(result.totals).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    // ADD was verified a moment ago, so its failure is a regression, seen once.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ oracle: "regression", status: "NEW", seenCount: 1 });
    expect(result.exitCode).toBe(1);
    // Zero model calls for a whole suite — the economic promise of the phase.
    expect(result.healCalls).toBe(0);
    for (const p of PROVIDERS) expect(result.usage[p].requests).toBe(0);

    app.setAddLabel("Add to cart");
  }, 300_000);

  it("raises a regression finding when a flow that used to pass stops passing", async () => {
    // ENTER is verified and still works; ADD was verified and is now broken.
    app.setAddLabel("Put in basket");
    await replayFlow(flowBySlug(db, ADD)!, { dir, db }); // fail it once more
    app.setAddLabel("Add to cart");
    await replayFlow(flowBySlug(db, ADD)!, { dir, db }); // …and back to verified
    app.setAddLabel("Put in basket");

    const result = await runRegression({ dir, requested: ADD });
    expect(result.flows[0]!.outcome).toBe("FAIL");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.oracle).toBe("regression");
    // The flow failing IS the evidence, so this is not a guess.
    expect(finding.confidence).toBe("high");
    expect(finding.severity).toBe("high");
    expect(finding.flow).toBe(ADD);
    expect(finding.failedAt).toBe(1);
    // It cites when the flow last worked — that is what makes it a regression
    // rather than "this flow is broken".
    expect(finding.lastPassAt).toBeTruthy();
    expect(finding.expected).toContain(finding.lastPassAt!);
    // The mixed suite above already reported this defect once, so tonight's
    // sighting is not news — that is the whole point of the fingerprint.
    expect(finding.status).toBe("KNOWN");

    const second = await runRegression({ dir, requested: ADD });
    expect(second.findings[0]!.status).toBe("KNOWN");
    expect(second.findings[0]!.seenCount).toBe(finding.seenCount + 1);

    const html = renderSuiteReport(second);
    expect(html).toContain("Known findings (1)");
    expect(html).toContain("Nothing new");
    expect(html).toContain("oracle-regression");

    app.setAddLabel("Add to cart");
  }, 300_000);

  it("writes a schema-valid suite.json and a self-contained HTML report", async () => {
    const result = await runRegression({ dir, requested: ENTER });
    const file = path.join(result.reportDir, "suite.json");
    const parsed = suiteSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    expect(parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe("");
    expect(result.exitCode).toBe(0);

    const html = renderSuiteReport(result);
    expect(html).not.toMatch(/(src|href)="https?:\/\//i);
    expect(html).toContain("ALL PASS");
    expect(html).toContain(ENTER);
  }, 300_000);

  it("maps outcomes to CI exit codes", () => {
    const base = { total: 1, passed: 0, failed: 0, refused: 0, healed: 0, skipped: 0, untested: 0 };
    expect(exitCodeFor({ ...base, passed: 1 }, false)).toBe(0);
    expect(exitCodeFor({ ...base, failed: 1 }, false)).toBe(1);
    // Healed is NOT a pass: something ran, but nobody proved the app still works.
    expect(exitCodeFor({ ...base, healed: 1 }, false)).toBe(1);
    expect(exitCodeFor({ ...base, untested: 1 }, false)).toBe(2);
    expect(exitCodeFor({ ...base, passed: 1 }, true)).toBe(2);
    expect(exitCodeFor({ ...base, refused: 1 }, false)).toBe(3);
    // A suite where everything was skipped has not failed…
    expect(exitCodeFor({ ...base, skipped: 1 }, false)).toBe(0);
    // …unless the caller says a shrinking suite is itself a failure.
    expect(exitCodeFor({ ...base, skipped: 1 }, false, true)).toBe(1);
    expect(exitCodeFor({ ...base, passed: 1 }, false, true)).toBe(0);
    // Nothing selected at all (cold cache, empty memory) counts too.
    expect(exitCodeFor({ ...base, total: 0 }, false, true)).toBe(1);
    // The more specific codes keep their meaning: they need different fixes.
    expect(exitCodeFor({ ...base, skipped: 1, untested: 1 }, false, true)).toBe(2);
    expect(exitCodeFor({ ...base, skipped: 1, refused: 1 }, false, true)).toBe(3);
  });

  it("counts what actually ran, and warns when that is less than the suite", () => {
    const base = { total: 4, passed: 0, failed: 0, refused: 0, healed: 0, skipped: 4, untested: 0 };
    expect(executedCount(base)).toBe(0);
    expect(skipWarning(base)).toBe("⚠ 4 flows skipped — suite exercised 0 of 4");
    expect(skipWarning({ ...base, total: 5, passed: 1 })).toBe(
      "⚠ 4 flows skipped — suite exercised 1 of 5",
    );
    expect(skipWarning({ ...base, skipped: 1, total: 1 })).toBe(
      "⚠ 1 flow skipped — suite exercised 0 of 1",
    );
    expect(skipWarning({ ...base, total: 0, skipped: 0 })).toMatch(/nothing to regress against/);
    // A healthy suite stays quiet.
    expect(skipWarning({ ...base, skipped: 0, passed: 4 })).toBe("");
  });

  it("exits 1 on a suite that exercised nothing — but only when asked", async () => {
    // Every flow broken: the suite still "passes" because skipping is not
    // failing, which is exactly the way this design can go quietly green.
    db.prepare("UPDATE flows SET status = 'broken'").run();

    const quiet = await runRegression({ dir, requested: "all" });
    expect(quiet.totals.skipped).toBe(3);
    expect(executedCount(quiet.totals)).toBe(0);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.selection.failOnSkipped).toBe(false);

    // …but it says so loudly, on the last line where a reader will see it.
    const summary = renderSuiteTerminal(quiet, "/tmp/report.html");
    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "⚠ 3 flows skipped — suite exercised 0 of 3 (use --fail-on-skipped to make this exit 1)",
    );

    const strict = await runRegression({ dir, requested: "all", failOnSkipped: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.selection.failOnSkipped).toBe(true);
    // With the flag on, the hint to turn it on would be noise.
    expect(renderSuiteTerminal(strict, "/tmp/report.html")).not.toContain("--fail-on-skipped to make");
    expect(suiteSchema.safeParse(JSON.parse(JSON.stringify(strict))).success).toBe(true);
  }, 300_000);

  it("counts outcomes without double-counting", () => {
    expect(
      tally([
        { outcome: "PASS" },
        { outcome: "FAIL" },
        { outcome: "SKIPPED" },
        { outcome: "SKIPPED" },
      ] as never),
    ).toEqual({ total: 4, passed: 1, failed: 1, refused: 0, healed: 0, skipped: 2, untested: 0 });
  });
});
