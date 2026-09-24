import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { loadConfig } from "../../config/load.js";
import {
  closeDb,
  elementsSeenOn,
  openFrontier,
  openMemoryDb,
  pageCoverage,
  type MemoryDb,
} from "../db.js";
import { ingestSession } from "../ingest.js";

/**
 * Coverage is only honest if it counts what was seen as well as what was used,
 * and only safe if a link off the application never becomes a place to crawl.
 */
const plan = JSON.stringify([
  { id: "O-01", description: "Enter the shop from the landing page", technique: "happy-path" },
  { id: "O-02", description: "Adding an item updates the cart badge", technique: "state-transition" },
  { id: "O-03", description: "Spare three", technique: "duplicate" },
  { id: "O-04", description: "Spare four", technique: "boundary" },
  { id: "O-05", description: "Spare five", technique: "invalid-input" },
]);

function idFor(t: string, re: RegExp): string {
  return t.split("\n").find((l) => /^ {2}e\d+ /.test(l) && re.test(l))?.trim().split(" ")[0] ?? "e999";
}

describe("frontier and element coverage (P4-T2)", () => {
  let app: FakeApp;
  let dir: string;
  let db: MemoryDb;
  let host: string;
  let reportDir: string;

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    host = new URL(app.url).host;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-coverage-"));
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

    const result = await runSession({
      dir,
      charter: "Enter the shop and add an item",
      generate: generate as never,
    });
    reportDir = result.reportDir;
    db = openMemoryDb(dir);
  }, 300_000);

  afterAll(async () => {
    closeDb(db);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts linked-but-unvisited pages on the frontier, oldest first", () => {
    const open = openFrontier(db).map((f) => f.page_key);
    // /broken and /logout are linked from /inventory and were never opened.
    expect(open).toContain(`${host}/broken`);
    expect(open).toContain(`${host}/logout`);
    // Every frontier row remembers where the link was found.
    const broken = openFrontier(db).find((f) => f.page_key === `${host}/broken`)!;
    expect(broken.seen_on_page).toBe(`${host}/inventory`);
    expect(broken.sample_url).toBe(`${app.url}/broken`);
    expect(broken.visited_at).toBeNull();
  });

  it("never puts a link off the application on the frontier (Hard Rule 4)", () => {
    const all = db.prepare("SELECT page_key FROM frontier").all() as { page_key: string }[];
    expect(all.some((r) => r.page_key.includes("example.com"))).toBe(false);
    // …and the page it lives on was certainly visited, so this is not an
    // accident of never having seen the link.
    expect(elementsSeenOn(db, `${host}/inventory`).some((e) => e.name === "Our partner site")).toBe(
      true,
    );
  });

  it("marks a frontier page visited once it is actually opened", () => {
    // /inventory was linked from the landing page AND visited, so it must not
    // still be sitting on the frontier.
    const open = openFrontier(db).map((f) => f.page_key);
    expect(open).not.toContain(`${host}/inventory`);
    const row = db
      .prepare("SELECT visited_at FROM frontier WHERE page_key = ?")
      .get(`${host}/inventory`) as { visited_at: string | null } | undefined;
    if (row) expect(row.visited_at).not.toBeNull();
  });

  it("counts every element seen, and interactions only for what was used", () => {
    const inventory = elementsSeenOn(db, `${host}/inventory`);
    const names = inventory.map((e) => e.name);
    expect(names).toContain("Add to cart");
    expect(names).toContain("Broken page");
    expect(names).toContain("Logout");

    const used = inventory.find((e) => e.name === "Add to cart")!;
    expect(used.interactions).toBeGreaterThan(0);
    expect(used.role).toBe("button");
    // Seen but never touched — which is exactly what makes coverage a number.
    expect(inventory.find((e) => e.name === "Logout")!.interactions).toBe(0);
  });

  it("reports per-page coverage as interacted ÷ seen", () => {
    const coverage = pageCoverage(db);
    const inventory = coverage.find((c) => c.page_key === `${host}/inventory`)!;
    expect(inventory.seen).toBeGreaterThan(inventory.interacted);
    expect(inventory.ratio).toBeCloseTo(inventory.interacted / inventory.seen);
    expect(inventory.ratio).toBeGreaterThan(0);
    expect(inventory.ratio).toBeLessThan(1);
    // Every known page appears, including ones with nothing to click.
    expect(coverage.map((c) => c.page_key)).toContain(`${host}/`);
  });

  it("is idempotent: re-ingesting the same report changes no counts", () => {
    const before = {
      frontier: db.prepare("SELECT COUNT(*) AS n FROM frontier").get(),
      elements: db.prepare("SELECT COUNT(*) AS n FROM element_seen").get(),
      interactions: db.prepare("SELECT SUM(interactions) AS n FROM element_seen").get(),
    };
    const result = JSON.parse(fs.readFileSync(path.join(reportDir, "session.json"), "utf8"));
    const again = ingestSession(db, result, reportDir, { cfg: loadConfig(dir) });
    expect(again.alreadyIngested).toBe(true);
    expect({
      frontier: db.prepare("SELECT COUNT(*) AS n FROM frontier").get(),
      elements: db.prepare("SELECT COUNT(*) AS n FROM element_seen").get(),
      interactions: db.prepare("SELECT SUM(interactions) AS n FROM element_seen").get(),
    }).toEqual(before);
  });
});
