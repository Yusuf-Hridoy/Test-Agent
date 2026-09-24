import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import type { SessionResult, StepRecord } from "../../types.js";
import { closeDb, openFrontier, openMemoryDb } from "../db.js";

/**
 * Explore reuses the whole Phase 1 engine; only the source of objectives
 * changes. These tests pin the part that is new: where it goes, in what order,
 * what it is told about each page, and that budgets — not a crawl limit — are
 * what stop it.
 */
interface Harness {
  dir: string;
  app: FakeApp;
  prompts: { explorer: string[]; executor: string[] };
  run: (budget?: string) => Promise<{ result: SessionResult; steps: StepRecord[] }>;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function harness(): Promise<Harness> {
  _resetRateLimiter();
  const app = await startFakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-explore-"));
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  cleanup.push(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

  const prompts = { explorer: [] as string[], executor: [] as string[] };

  const write = (budget: string) =>
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `forbidden_elements: ["logout", "delete", "payment"]\n` +
        `${budget}` +
        `model:\n  min_delay_ms: 0\n`,
    );

  /** One objective per page, executed with a single click when one is offered. */
  const generate = async (req: unknown) => {
    const { messages } = req as { messages: { content: unknown }[] };
    const last = messages.at(-1)!.content;
    const text =
      typeof last === "string"
        ? last
        : (last as { type: string; text?: string }[])
            .map((p) => (p.type === "text" ? p.text : "[image]"))
            .join("\n");

    if (/Propose at most/.test(text)) {
      prompts.explorer.push(text);
      // Name the first link on the page, so the objective is executable.
      const link = text.split("\n").find((l) => /^ {2}e\d+ link "/.test(l));
      const name = /"([^"]+)"/.exec(link ?? "")?.[1];
      return {
        text: JSON.stringify(
          name
            ? [{ description: `Follow "${name}" and see where it goes`, technique: "happy-path" }]
            : [],
        ),
        toolCalls: [],
        usage: {},
        finishReason: "stop",
      };
    }

    prompts.executor.push(text);
    const want = /Follow "([^"]+)"/.exec(text)?.[1];
    const line = want
      ? text.split("\n").find((l) => /^ {2}e\d+ /.test(l) && l.includes(`"${want}"`))
      : undefined;
    const id = line?.trim().split(" ")[0];
    const already = /YOUR RECENT ACTIONS/.test(text);
    if (id && !already) {
      return {
        text: "",
        toolCalls: [{ toolCallId: "c", toolName: "click", input: { id } }],
        usage: {},
        finishReason: "tool-calls",
      };
    }
    return {
      text: "",
      toolCalls: [
        {
          toolCallId: "c",
          toolName: "mark_objective",
          input: { status: "passed", note: "followed it" },
        },
      ],
      usage: {},
      finishReason: "tool-calls",
    };
  };

  return {
    dir,
    app,
    prompts,
    run: async (budget = `budget:\n  max_steps: 60\n  max_llm_requests: 40\n  max_minutes: 5\n`) => {
      write(budget);
      const result = await runSession({
        dir,
        charter: "explore",
        explore: true,
        generate: generate as never,
      });
      const steps = fs
        .readFileSync(path.join(result.reportDir, "steps.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as StepRecord);
      return { result, steps };
    },
  };
}

describe("explore mode (P4-T3)", () => {
  it("starts from base_url when memory is empty, then follows what it finds", async () => {
    const h = await harness();
    const { result, steps } = await h.run();
    const host = new URL(h.app.url).host;

    expect(result.status).toBe("COMPLETED");

    // An empty project has exactly one place to start.
    const queued = steps.find((s) => s.action === "explore_queue")!;
    expect(queued.result.detail).toContain("1 base");

    // Pages found while working are appended, and visited on later turns.
    const discovered = steps.filter((s) => s.action === "explore_discovered");
    expect(discovered.length).toBeGreaterThan(0);
    const announced = discovered.map((s) => s.result.detail ?? "").join(" ");
    expect(announced).toContain(`${host}/broken`);

    const visits = steps.filter((s) => s.action === "explore_visit").map((s) => s.url);
    expect(visits.length).toBeGreaterThanOrEqual(2);

    // Objectives were generated per page, and each remembers its page.
    expect(h.prompts.explorer.length).toBeGreaterThanOrEqual(2);
    expect(result.objectives.length).toBeGreaterThanOrEqual(2);
    expect(result.objectives.every((o) => o.page)).toBe(true);

    // …and the whole thing landed in memory like any other session.
    const db = openMemoryDb(h.dir);
    try {
      const pages = db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number };
      expect(pages.n).toBeGreaterThanOrEqual(3);
      // A page it actually opened is no longer frontier.
      expect(openFrontier(db).map((f) => f.page_key)).not.toContain(`${host}/inventory`);
    } finally {
      closeDb(db);
    }
  }, 300_000);

  it("never queues or visits a page outside scope (Hard Rule 4)", async () => {
    const h = await harness();
    const { steps } = await h.run();

    const everything = JSON.stringify(steps);
    expect(everything).not.toContain("example.com");

    const db = openMemoryDb(h.dir);
    try {
      const rows = db.prepare("SELECT page_key FROM frontier").all() as { page_key: string }[];
      expect(rows.some((r) => r.page_key.includes("example.com"))).toBe(false);
    } finally {
      closeDb(db);
    }
  }, 300_000);

  it("tells each page's generator what is untouched and what flows already cover", async () => {
    const h = await harness();
    // A verified flow on the inventory page: explore must be told not to
    // re-test ground that replays for free.
    const db = openMemoryDb(h.dir);
    const host = new URL(h.app.url).host;
    const now = "2026-09-24T10:00:00+02:00";
    const id = Number(
      db
        .prepare(
          "INSERT INTO flows (slug, name, status, start_page_key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("badge-flow", "Cart badge updates when an item is added", "verified", `${host}/`, now, now)
        .lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO flow_steps (flow_id, seq, action, target_role, target_name, url_after) VALUES (?,?,?,?,?,?)",
    ).run(id, 1, "click", "button", "Add to cart", `${host}/inventory`);
    closeDb(db);

    await h.run();

    const inventoryPrompt = h.prompts.explorer.find((p) => p.includes("/inventory"));
    expect(inventoryPrompt).toBeTruthy();
    expect(inventoryPrompt!).toContain("ALREADY COVERED BY VERIFIED FLOWS");
    expect(inventoryPrompt!).toContain("Cart badge updates when an item is added");
    // Everything on a freshly-seen page counts as untouched.
    expect(inventoryPrompt!).toMatch(/NEVER INTERACTED WITH \(\d+\)/);
    expect(inventoryPrompt!).toContain('button "Add to cart"');
  }, 300_000);

  it("lets budgets, not a crawl limit, stop the exploration", async () => {
    const h = await harness();
    const { result, steps } = await h.run(
      `budget:\n  max_steps: 60\n  max_llm_requests: 3\n  max_minutes: 5\n`,
    );

    expect(result.status).toBe("BUDGET_EXHAUSTED");
    // It stopped part-way through a queue it had already extended.
    const visits = steps.filter((s) => s.action === "explore_visit");
    expect(visits.length).toBeLessThanOrEqual(2);
    const llm = result.usage.gemini.requests;
    expect(llm).toBeLessThanOrEqual(3);
    // Whatever it did manage is still ingested and still reported.
    expect(fs.existsSync(path.join(result.reportDir, "session.json"))).toBe(true);
    expect(result.objectives.length).toBeGreaterThan(0);
  }, 300_000);
});
