import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionResult, StepRecord } from "../../types.js";
import { closeDb, counts, openMemoryDb, type MemoryDb } from "../db.js";
import { ingestSession, ingestSuite, SLOW_PAGE_THRESHOLD } from "../ingest.js";
import { fingerprintOf, normalizeTitle } from "../fingerprint.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-oracles-"));
  dirs.push(dir);
  return dir;
}

/** One session that visited /checkout, optionally finding it slow. */
function sessionOn(dir: string, n: number, slow: boolean): { result: SessionResult; reportDir: string } {
  const reportDir = path.join(dir, "reports", `run-${n}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const step: StepRecord = {
    n: 1,
    t: `2026-09-2${n}T10:00:00.000+02:00`,
    actor: "model",
    action: "click",
    args: {},
    result: { ok: true, detail: 'Clicked "Checkout"' },
    url: "https://shop.test/checkout",
    fingerprint: "fp",
  };
  fs.writeFileSync(path.join(reportDir, "steps.jsonl"), `${JSON.stringify(step)}\n`);
  const result: SessionResult = {
    status: "COMPLETED",
    startedAt: `2026-09-2${n}T10:00:00.000+02:00`,
    endedAt: `2026-09-2${n}T10:05:00.000+02:00`,
    charter: "check out",
    objectives: [],
    findings: [],
    observations: slow
      ? [{ type: "slow_page", detail: "click Checkout needed an extra 15000ms", pageKey: "shop.test/checkout" }]
      : [],
    usage: {
      gemini: { requests: 1, inputTokens: 0, outputTokens: 0 },
      groq: { requests: 0, inputTokens: 0, outputTokens: 0 },
      mistral: { requests: 0, inputTokens: 0, outputTokens: 0 },
    },
    stepCount: 1,
    reportDir,
  };
  return { result, reportDir };
}

describe("fingerprints (P3-T5 foundation)", () => {
  it("treats the same defect on different entities as one defect", () => {
    const a = fingerprintOf("Server error: /api/cart/4711", "shop.test/cart/:id", "http_5xx");
    const b = fingerprintOf("Server error: /api/cart/9982", "shop.test/cart/:id", "http_5xx");
    expect(a).toBe(b);
  });

  it("keeps different oracles, pages and defects apart", () => {
    const base = fingerprintOf("Server error: /api/cart", "shop.test/cart", "http_5xx");
    expect(fingerprintOf("Server error: /api/cart", "shop.test/cart", "console_error")).not.toBe(base);
    expect(fingerprintOf("Server error: /api/cart", "shop.test/other", "http_5xx")).not.toBe(base);
    expect(fingerprintOf("Checkout is broken", "shop.test/cart", "http_5xx")).not.toBe(base);
  });

  it("normalizes away ids and case but keeps the shape of the message", () => {
    expect(normalizeTitle("Server Error: /api/cart/4711")).toBe("server error: /api/cart/");
    expect(normalizeTitle("Console error: TypeError at 0xdeadbeefcafe")).toBe("console error: typeerror at x");
  });
});

describe("performance oracle (P3-T3)", () => {
  it(`fires only after ${SLOW_PAGE_THRESHOLD} consecutive slow visits`, () => {
    const dir = project();
    const db = openMemoryDb(dir);

    const raisedPerRun: number[] = [];
    for (let n = 1; n <= SLOW_PAGE_THRESHOLD; n++) {
      const { result, reportDir } = sessionOn(dir, n, true);
      raisedPerRun.push(ingestSession(db, result, reportDir).raised.length);
    }
    // Nothing on the first two visits; one finding on the third.
    expect(raisedPerRun).toEqual([...Array(SLOW_PAGE_THRESHOLD - 1).fill(0), 1]);

    const finding = db.prepare("SELECT * FROM findings WHERE oracle = 'performance'").get() as {
      title: string;
      severity: string;
      confidence: string;
      page_key: string;
    };
    expect(finding.title).toBe("Slow page: shop.test/checkout");
    expect(finding.severity).toBe("low");
    // One slow night is weather, not a proof.
    expect(finding.confidence).toBe("low");
    expect(finding.page_key).toBe("shop.test/checkout");
    closeDb(db);
  });

  it("does not fire when a fast visit breaks the streak", () => {
    const dir = project();
    const db = openMemoryDb(dir);
    for (const [n, slow] of [
      [1, true],
      [2, true],
      [3, false],
      [4, true],
    ] as [number, boolean][]) {
      const { result, reportDir } = sessionOn(dir, n, slow);
      ingestSession(db, result, reportDir);
    }
    expect(counts(db).findings).toBe(0);
    closeDb(db);
  });

  it("reports a recurring slow page as KNOWN rather than as news every night", () => {
    const dir = project();
    const db = openMemoryDb(dir);
    const verdicts: string[] = [];
    for (let n = 1; n <= SLOW_PAGE_THRESHOLD + 1; n++) {
      const { result, reportDir } = sessionOn(dir, n, true);
      for (const v of ingestSession(db, result, reportDir).raised) verdicts.push(v.status);
    }
    expect(verdicts).toEqual(["NEW", "KNOWN"]);
    const last = db
      .prepare("SELECT * FROM findings WHERE oracle='performance' ORDER BY id DESC LIMIT 1")
      .get() as { first_seen_session: number; session_id: number };
    // The sighting is new; the defect is not.
    expect(last.first_seen_session).toBeLessThan(last.session_id);
    closeDb(db);
  });
});

describe("regression findings across suites (P3-T3/T5)", () => {
  function suite(db: MemoryDb, reportDir: string, n: number) {
    return ingestSuite(db, {
      reportDir,
      startedAt: `2026-09-2${n}T20:00:00.000+02:00`,
      endedAt: `2026-09-2${n}T20:04:00.000+02:00`,
      status: "REGRESSION",
      charter: "regression: all",
      llmRequests: 0,
      findings: [
        {
          fid: "R-001",
          title: 'Flow "checkout" no longer passes',
          severity: "high",
          oracle: "regression",
          confidence: "high",
          pageKey: "shop.test/checkout",
        },
      ],
    });
  }

  it("is NEW the first night and KNOWN the second", () => {
    const dir = project();
    const db = openMemoryDb(dir);

    const first = suite(db, path.join(dir, "reports", "night-1"), 1);
    expect(first.verdicts[0]).toMatchObject({ status: "NEW", seenCount: 1 });

    const second = suite(db, path.join(dir, "reports", "night-2"), 2);
    expect(second.verdicts[0]).toMatchObject({ status: "KNOWN", seenCount: 2 });
    expect(second.verdicts[0]!.firstSeenAt).toBe("2026-09-21T20:00:00.000+02:00");
    closeDb(db);
  });

  it("does not double-count a suite that is ingested twice", () => {
    const dir = project();
    const db = openMemoryDb(dir);
    const where = path.join(dir, "reports", "night-1");
    suite(db, where, 1);
    const again = suite(db, where, 1);
    expect(again.alreadyIngested).toBe(true);
    expect(counts(db).findings).toBe(1);
    expect(counts(db).sessions).toBe(1);
    closeDb(db);
  });
});
