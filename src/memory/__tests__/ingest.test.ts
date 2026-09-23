import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionResult, StepRecord } from "../../types.js";
import { SecretStore, REDACTED } from "../../model/redact.js";
import { closeDb, counts, flowBySlug, listFlows, openMemoryDb, pageByKey } from "../db.js";
import { ingestSession } from "../ingest.js";
import { SECRET_PLACEHOLDER } from "../types.js";

const PASSWORD = "hunter2-very-secret";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function step(n: number, over: Partial<StepRecord>): StepRecord {
  return {
    n,
    t: `2026-09-23T10:00:${String(n).padStart(2, "0")}.000+02:00`,
    actor: "model",
    action: "click",
    args: {},
    result: { ok: true, detail: "" },
    url: "https://shop.test/",
    fingerprint: `fp${n}`,
    ...over,
  };
}

/** A report folder shaped exactly like one a real run leaves behind. */
function writeFixture(): { dir: string; reportDir: string; result: SessionResult } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-ingest-"));
  dirs.push(dir);
  const reportDir = path.join(dir, "reports", "2026-09-23_10-00-00");
  fs.mkdirSync(reportDir, { recursive: true });

  const steps: StepRecord[] = [
    step(1, { actor: "harness", action: "auth_check", result: { ok: true, detail: "session ok" } }),
    step(2, { action: "fill", result: { ok: true, detail: 'Filled "Password"' } }),
    step(3, {
      action: "click",
      result: { ok: true, detail: 'Clicked "Log in".' },
      url: "https://shop.test/inventory.html",
    }),
    step(4, {
      action: "click",
      result: { ok: true, detail: 'Clicked "Add to cart".' },
      url: "https://shop.test/inventory.html",
    }),
    step(5, {
      action: "click",
      result: { ok: true, detail: 'Clicked "Cart".' },
      url: "https://shop.test/cart/17?from=header",
    }),
    step(6, {
      actor: "harness",
      action: "oracle:http_5xx",
      result: { ok: false, detail: "F-001: Server error: /api/cart" },
      url: "https://shop.test/cart/17",
    }),
  ];
  fs.writeFileSync(
    path.join(reportDir, "steps.jsonl"),
    `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`,
  );

  fs.writeFileSync(
    path.join(reportDir, "flows.draft.json"),
    JSON.stringify([
      {
        objectiveId: "O-01",
        description: "Log in with valid credentials",
        actions: [
          {
            action: "fill",
            target: { role: "textbox", name: "Username" },
            value: "standard_user",
            fromUrl: "https://shop.test/",
            url: "https://shop.test/",
          },
          {
            action: "fill",
            target: { role: "textbox", name: "Password" },
            // The drafter already redacted this on the way to disk.
            value: REDACTED,
            fromUrl: "https://shop.test/",
            url: "https://shop.test/",
          },
          {
            action: "click",
            target: { role: "button", name: "Log in" },
            fromUrl: "https://shop.test/",
            url: "https://shop.test/inventory.html",
          },
        ],
      },
      {
        objectiveId: "O-02",
        description: "Adding an item updates the cart badge",
        actions: [
          {
            action: "click",
            target: { role: "button", name: "Add to cart" },
            fromUrl: "https://shop.test/inventory.html",
            url: "https://shop.test/inventory.html",
          },
          { action: "wait", value: "500", fromUrl: "x", url: "https://shop.test/inventory.html" },
        ],
      },
    ]),
  );

  const result: SessionResult = {
    status: "COMPLETED",
    startedAt: "2026-09-23T10:00:00.000+02:00",
    endedAt: "2026-09-23T10:04:00.000+02:00",
    charter: "Log in and add an item to the cart",
    objectives: [],
    findings: [
      {
        id: "F-001",
        title: "Server error: /api/cart",
        severity: "high",
        oracle: "http_5xx",
        confidence: "high",
        expected: "requests succeed",
        actual: "500",
        steps: [4, 5, 6],
        screenshots: [],
      },
    ],
    observations: [],
    usage: {
      gemini: { requests: 12, inputTokens: 100, outputTokens: 20 },
      groq: { requests: 3, inputTokens: 10, outputTokens: 2 },
      mistral: { requests: 0, inputTokens: 0, outputTokens: 0 },
    },
    stepCount: steps.length,
    reportDir,
  };
  return { dir, reportDir, result };
}

function ingestFixture() {
  const fx = writeFixture();
  const db = openMemoryDb(fx.dir);
  const secrets = new SecretStore([PASSWORD]);
  const summary = ingestSession(db, fx.result, fx.reportDir, { secrets });
  return { ...fx, db, secrets, summary };
}

describe("ingestSession", () => {
  it("records the session, its pages, transitions, findings and flows", () => {
    const { db, summary } = ingestFixture();
    expect(summary.alreadyIngested).toBe(false);
    const c = counts(db);
    expect(c.sessions).toBe(1);
    // "/", "/inventory.html" and the parameterized "/cart/:id"
    expect(c.pages).toBe(3);
    expect(c.findings).toBe(1);
    expect(c.flows).toBe(2);

    const session = db.prepare("SELECT * FROM sessions").get() as { llm_requests: number; status: string };
    expect(session.llm_requests).toBe(15);
    expect(session.status).toBe("COMPLETED");
    closeDb(db);
  });

  it("parameterizes entity URLs and counts arrivals, not steps", () => {
    const { db } = ingestFixture();
    const cart = pageByKey(db, "shop.test/cart/:id")!;
    expect(cart).toBeTruthy();
    expect(cart.sample_url).toBe("https://shop.test/cart/17?from=header");
    // Steps 3 and 4 are both on /inventory.html: one arrival, not two.
    expect(pageByKey(db, "shop.test/inventory.html")!.visit_count).toBe(1);
    closeDb(db);
  });

  it("labels transitions with the action that caused them", () => {
    const { db } = ingestFixture();
    const rows = db
      .prepare(
        `SELECT f.page_key AS from_key, t.page_key AS to_key, x.action
         FROM transitions x JOIN pages f ON f.id = x.from_page JOIN pages t ON t.id = x.to_page`,
      )
      .all() as { from_key: string; to_key: string; action: string }[];
    expect(rows).toContainEqual({
      from_key: "shop.test/",
      to_key: "shop.test/inventory.html",
      action: 'click "Log in"',
    });
    expect(rows.map((r) => r.action)).toContain('click "Cart"');
    closeDb(db);
  });

  it("files findings against the page they fired on", () => {
    const { db } = ingestFixture();
    const finding = db.prepare("SELECT * FROM findings").get() as { page_key: string; fid: string };
    expect(finding.fid).toBe("F-001");
    expect(finding.page_key).toBe("shop.test/cart/:id");
    closeDb(db);
  });

  it("compiles passed objectives into replayable flows, dropping non-replayable tools", () => {
    const { db } = ingestFixture();
    const login = flowBySlug(db, "log-in-with-valid-credentials")!;
    expect(login.status).toBe("draft");
    expect(login.origin_objective).toBe("O-01");
    expect(login.start_page_key).toBe("shop.test/");
    expect(login.steps.map((s) => s.action)).toEqual(["fill", "fill", "click"]);
    expect(login.steps[0]!.target_role).toBe("textbox");
    expect(login.steps[2]!.url_after).toBe("shop.test/inventory.html");

    // `wait` is not replayable and must not become a step.
    const badge = flowBySlug(db, "adding-an-item-updates-the-cart-badge")!;
    expect(badge.steps.map((s) => s.action)).toEqual(["click"]);
    closeDb(db);
  });

  it("stores a redacted value as {secret}, never the literal (Hard Rule 2)", () => {
    const { db, dir } = ingestFixture();
    const login = flowBySlug(db, "log-in-with-valid-credentials")!;
    expect(login.steps[1]!.value).toBe(SECRET_PLACEHOLDER);
    expect(login.steps[0]!.value).toBe("standard_user");
    closeDb(db);

    // Sweep the whole file, WAL included: the secret must appear nowhere.
    const memoryDir = path.join(dir, "memory");
    const blob = fs
      .readdirSync(memoryDir)
      .map((f) => fs.readFileSync(path.join(memoryDir, f)).toString("latin1"))
      .join("");
    expect(blob).not.toContain(PASSWORD);
    expect(blob).not.toContain(REDACTED);
    expect(blob).toContain(SECRET_PLACEHOLDER);
  });

  it("is idempotent: re-ingesting the same report changes nothing", () => {
    const { db, result, reportDir, secrets } = ingestFixture();
    const before = counts(db);
    const visitsBefore = pageByKey(db, "shop.test/")!.visit_count;

    const second = ingestSession(db, result, reportDir, { secrets });
    expect(second.alreadyIngested).toBe(true);
    expect(counts(db)).toEqual(before);
    expect(pageByKey(db, "shop.test/")!.visit_count).toBe(visitsBefore);
    closeDb(db);
  });

  it("suffixes a colliding slug only when the steps actually differ", () => {
    const { db, result, reportDir, secrets, dir } = ingestFixture();

    // Same report, different folder → same flows: nothing new is created.
    const twin = path.join(dir, "reports", "twin");
    fs.cpSync(reportDir, twin, { recursive: true });
    const again = ingestSession(db, { ...result, reportDir: twin }, twin, { secrets });
    expect(again.flowsCreated).toEqual([]);
    expect(again.flowsSkipped).toContain("log-in-with-valid-credentials");
    expect(counts(db).flows).toBe(2);

    // Now the same objective with a different step list → a -2 flow.
    const changed = path.join(dir, "reports", "changed");
    fs.cpSync(reportDir, changed, { recursive: true });
    const drafts = JSON.parse(fs.readFileSync(path.join(changed, "flows.draft.json"), "utf8"));
    drafts[0].actions.push({
      action: "click",
      target: { role: "button", name: "Continue" },
      fromUrl: "https://shop.test/inventory.html",
      url: "https://shop.test/inventory.html",
    });
    fs.writeFileSync(path.join(changed, "flows.draft.json"), JSON.stringify(drafts));
    const third = ingestSession(db, { ...result, reportDir: changed }, changed, { secrets });
    expect(third.flowsCreated).toContain("log-in-with-valid-credentials-2");
    expect(listFlows(db)).toHaveLength(3);
    closeDb(db);
  });

  it("ingests a Phase-1-era report whose draft actions carry no fromUrl", () => {
    const { dir, reportDir, result } = writeFixture();
    // Phase 1 wrote {action, target, value, url} and nothing else.
    const drafts = JSON.parse(fs.readFileSync(path.join(reportDir, "flows.draft.json"), "utf8"));
    for (const d of drafts) for (const a of d.actions) delete a.fromUrl;
    fs.writeFileSync(path.join(reportDir, "flows.draft.json"), JSON.stringify(drafts));

    const db = openMemoryDb(dir);
    const summary = ingestSession(db, result, reportDir, { secrets: new SecretStore([PASSWORD]) });
    expect(summary.flowsCreated).toContain("log-in-with-valid-credentials");
    // Without fromUrl the best available guess is the first action's own URL:
    // approximate for old evidence, exact for anything recorded from now on.
    expect(flowBySlug(db, "log-in-with-valid-credentials")!.start_page_key).toBe("shop.test/");
    closeDb(db);
  });

  it("survives a report folder with no steps and no drafts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-ingest-empty-"));
    dirs.push(dir);
    const reportDir = path.join(dir, "reports", "empty");
    fs.mkdirSync(reportDir, { recursive: true });
    const db = openMemoryDb(dir);
    const result = { ...writeFixture().result, reportDir, findings: [] };
    const summary = ingestSession(db, result, reportDir);
    expect(summary.pages).toBe(0);
    expect(counts(db).sessions).toBe(1);
    closeDb(db);
  });
});
