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
  openEphemeralDb,
  openFrontier,
  openMemoryDb,
  pageCoverage,
  type MemoryDb,
} from "../db.js";
import {
  asPercent,
  COVERAGE_CAVEAT,
  coverageReport,
  coverageSchema,
} from "../coverage.js";
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

/**
 * Hand-built memory with numbers a reader can check by eye, so the report is
 * pinned to arithmetic rather than to whatever the code happens to produce.
 */
describe("coverage report (P4-T4)", () => {
  function fixture(): MemoryDb {
    const db = openEphemeralDb();
    const now = "2026-09-24T10:00:00+02:00";
    const page = db.prepare(
      "INSERT INTO pages (page_key, sample_url, title, first_seen, last_seen) VALUES (?,?,?,?,?)",
    );
    page.run("shop.test/", "https://shop.test/", "Home", now, now);
    page.run("shop.test/b", "https://shop.test/b", "Basket", now, now);
    page.run("shop.test/c", "https://shop.test/c", "Contact", now, now);

    const el = db.prepare(
      "INSERT INTO element_seen (page_key, role, name, first_seen, last_seen, interactions) VALUES (?,?,?,?,?,?)",
    );
    // Home: 4 seen, 1 used → 25%
    el.run("shop.test/", "button", "Search", now, now, 3);
    el.run("shop.test/", "link", "Basket", now, now, 0);
    el.run("shop.test/", "link", "Contact", now, now, 0);
    el.run("shop.test/", "textbox", "Query", now, now, 0);
    // Basket: 2 seen, 2 used → 100%
    el.run("shop.test/b", "button", "Checkout", now, now, 1);
    el.run("shop.test/b", "button", "Empty basket", now, now, 2);
    // Contact: nothing interactive at all

    const front = db.prepare(
      "INSERT INTO frontier (page_key, sample_url, first_seen, seen_on_page, visited_at) VALUES (?,?,?,?,?)",
    );
    front.run("shop.test/d", "https://shop.test/d", "2026-09-24T09:00:00+02:00", "shop.test/", null);
    front.run("shop.test/e", "https://shop.test/e", "2026-09-24T09:30:00+02:00", "shop.test/b", null);
    front.run("shop.test/b", "https://shop.test/b", now, "shop.test/", now); // already visited

    const flow = db.prepare(
      "INSERT INTO flows (slug, name, status, start_page_key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    const verified = flow.run("checkout", "Check out", "verified", "shop.test/b", now, now);
    flow.run("draft-one", "A draft", "draft", "shop.test/", now, now);
    flow.run("broken-one", "A broken one", "broken", "shop.test/", now, now);
    db.prepare(
      "INSERT INTO flow_steps (flow_id, seq, action, target_name, url_after) VALUES (?,?,?,?,?)",
    ).run(verified.lastInsertRowid, 1, "click", "Checkout", "shop.test/b");
    return db;
  }

  it("counts pages as visited plus frontier", () => {
    const db = fixture();
    const report = coverageReport(db);
    expect(report.pages).toEqual({ known: 5, visited: 3, frontier: 2 });
    db.close();
  });

  it("totals elements across pages: 3 of 6 used", () => {
    const db = fixture();
    const report = coverageReport(db);
    expect(report.elements).toEqual({ seen: 6, interacted: 3, ratio: 0.5 });
    expect(asPercent(report.elements.ratio)).toBe("50%");
    db.close();
  });

  it("ranks the least-exercised page first, and counts verified flows per page", () => {
    const db = fixture();
    const report = coverageReport(db);
    expect(report.worstPages[0]).toEqual({
      pageKey: "shop.test/",
      title: "Home",
      seen: 4,
      interacted: 1,
      ratio: 0.25,
      verifiedFlows: 0,
    });
    const basket = report.worstPages.find((p) => p.pageKey === "shop.test/b")!;
    expect(basket.ratio).toBe(1);
    expect(basket.verifiedFlows).toBe(1);
    // A page with nothing to click scores 1: it cannot be under-explored, and
    // ranking it worst would send the explorer back to it forever.
    expect(report.worstPages.find((p) => p.pageKey === "shop.test/c")!.ratio).toBe(1);
    db.close();
  });

  it("lists only unvisited frontier pages, oldest first, with their referrer", () => {
    const db = fixture();
    const report = coverageReport(db);
    expect(report.frontier.map((f) => f.pageKey)).toEqual(["shop.test/d", "shop.test/e"]);
    expect(report.frontier[0]!.seenOnPage).toBe("shop.test/");
    db.close();
  });

  it("counts flows by status and ships the caveat with the data", () => {
    const db = fixture();
    const report = coverageReport(db);
    expect(report.flows).toEqual({ total: 3, verified: 1, draft: 1, broken: 1 });
    expect(report.note).toBe(COVERAGE_CAVEAT);
    expect(coverageSchema.safeParse(report).success).toBe(true);
    db.close();
  });

  it("says 100% rather than NaN when nothing has been seen at all", () => {
    const db = openEphemeralDb();
    const report = coverageReport(db);
    expect(report.elements).toEqual({ seen: 0, interacted: 0, ratio: 1 });
    expect(report.pages).toEqual({ known: 0, visited: 0, frontier: 0 });
    expect(coverageSchema.safeParse(report).success).toBe(true);
    db.close();
  });
});
