import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FindingBuilder, confidenceFor, oracleFindingsFor } from "../findings.js";
import { FlowDrafter } from "../flows.js";
import { StepLog } from "../steps.js";
import { SecretStore } from "../../model/redact.js";
import type { Drained } from "../../browser/collect.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-ev-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const drained = (over: Partial<Drained> = {}): Drained => ({
  console: [],
  network: [],
  crashed: false,
  ...over,
});

describe("FindingBuilder", () => {
  it("builds a complete, numbered Finding", () => {
    const b = new FindingBuilder();
    const f = b.add({
      title: "  Cart badge does not clear  ",
      severity: "high",
      oracle: "llm_judgment",
      expected: "badge disappears",
      actual: "badge still shows 1",
      objectiveId: "O-04",
      steps: [9, 3, 5],
      screenshots: ["shots/003_a.png", undefined],
      evidence: drained({ console: ["console.error: boom"] }),
    });
    expect(f).toMatchObject({
      id: "F-001",
      title: "Cart badge does not clear",
      confidence: "low",
      objectiveId: "O-04",
      steps: [3, 5, 9],
      screenshots: ["shots/003_a.png"],
      console: ["console.error: boom"],
    });
    expect(f.network).toBeUndefined();
    expect(b.add({ ...f, title: "A different defect", screenshots: [] }).id).toBe("F-002");
  });

  it("marks hard oracles high-confidence and llm_judgment low (Hard Rule 8)", () => {
    expect(confidenceFor("console_error")).toBe("high");
    expect(confidenceFor("http_5xx")).toBe("high");
    expect(confidenceFor("crash")).toBe("high");
    expect(confidenceFor("llm_judgment")).toBe("low");
  });
});

describe("oracleFindingsFor", () => {
  it("returns nothing for a clean drain", () => {
    expect(oracleFindingsFor(drained())).toEqual([]);
  });

  it("raises a high-severity finding for a 5xx", () => {
    const [f] = oracleFindingsFor(drained({ network: ["GET https://app.test/api/cart → 500"] }));
    expect(f).toMatchObject({ oracle: "http_5xx", severity: "high" });
    expect(f!.title).toContain("/api/cart");
  });

  it("separates 4xx, console errors and crashes", () => {
    const out = oracleFindingsFor(
      drained({
        network: ["GET https://app.test/missing → 404"],
        console: ["console.error: TypeError: x is not a function"],
        crashed: true,
      }),
    );
    expect(out.map((o) => o.oracle)).toEqual(["crash", "http_4xx_unexpected", "console_error"]);
  });
});

describe("FlowDrafter", () => {
  it("writes parseable JSON for passed objectives only", () => {
    const dir = tmp();
    const file = path.join(dir, "flows.draft.json");
    const flows = new FlowDrafter(file, new SecretStore(["hunter2pass"]));

    flows.record({ action: "fill", target: { role: "textbox", name: "Password" }, value: "hunter2pass", url: "https://app.test/login" });
    flows.record({ action: "click", target: { role: "button", name: "Login" }, url: "https://app.test/login" });
    flows.commit("O-01", "Log in");

    flows.record({ action: "click", target: { role: "button", name: "Nope" }, url: "https://app.test/x" });
    flows.discard();
    flows.finish();

    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].objectiveId).toBe("O-01");
    expect(parsed[0].actions).toHaveLength(2);
    expect(JSON.stringify(parsed)).not.toContain("hunter2pass");
    expect(JSON.stringify(parsed)).not.toContain('"id"');
  });

  it("always leaves a parseable file, even with no passed objectives", () => {
    const dir = tmp();
    const file = path.join(dir, "flows.draft.json");
    new FlowDrafter(file, new SecretStore()).finish();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
  });
});

describe("StepLog", () => {
  it("appends one redacted JSON object per line as it happens", () => {
    const dir = tmp();
    const file = path.join(dir, "steps.jsonl");
    const log = new StepLog(file, new SecretStore(["hunter2pass"]));

    log.append({
      actor: "model",
      action: "fill",
      args: { id: "e2", text: "hunter2pass" },
      result: { ok: true, detail: 'Filled "Password"' },
      url: "https://app.test/login",
      fingerprint: "abc123",
    });
    // Readable before close: crash-safety is the point.
    const midRun = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(midRun).toHaveLength(1);

    log.append({
      actor: "harness",
      action: "oracle:console_error",
      args: {},
      result: { ok: false, detail: "F-001" },
      url: "https://app.test/login",
      fingerprint: "abc123",
    });
    log.close();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.n)).toEqual([1, 2]);
    expect(lines[0].args.text).toBe("«redacted»");
    expect(lines[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(log.sliceFor([2])).toHaveLength(1);
  });
});

describe("FindingBuilder de-duplication (S1)", () => {
  it("files one finding for the same defect seen repeatedly", () => {
    const b = new FindingBuilder();
    const input = {
      title: "Unexpected 401: /api/cart",
      severity: "medium" as const,
      oracle: "http_4xx_unexpected" as const,
      expected: "request succeeds",
      actual: "401 returned",
      objectiveId: "O-01",
      steps: [3],
      screenshots: ["shots/001_a.png"],
    };
    const first = b.add(input);
    const second = b.add({ ...input, steps: [7], screenshots: ["shots/002_b.png"] });

    expect(b.count).toBe(1);
    expect(second.id).toBe(first.id);
    expect(first.steps).toEqual([3, 7]);
    expect(first.screenshots).toEqual(["shots/001_a.png", "shots/002_b.png"]);
    expect(first.actual).toContain("seen 2 times");

    b.add({ ...input, steps: [9], screenshots: [] });
    expect(first.actual).toContain("seen 3 times");
    expect(first.actual).not.toContain("seen 2 times");
  });

  it("keeps genuinely different defects apart", () => {
    const b = new FindingBuilder();
    const base = {
      severity: "high" as const,
      expected: "e",
      actual: "a",
      steps: [1],
      screenshots: [],
    };
    b.add({ ...base, title: "Server error: /a", oracle: "http_5xx" });
    b.add({ ...base, title: "Server error: /b", oracle: "http_5xx" });
    b.add({ ...base, title: "Server error: /a", oracle: "console_error" });
    expect(b.count).toBe(3);
  });
});

describe("browser-generated console noise", () => {
  it("never files a finding for 'Failed to load resource'", () => {
    const out = oracleFindingsFor(
      drained({ console: ["console.error: Failed to load resource: the server responded with a status of 401"] }),
    );
    expect(out).toEqual([]);
  });
});

describe("StepLog.recent (S6 repro fallback)", () => {
  it("returns the most recent step numbers", () => {
    const dir = tmp();
    const log = new StepLog(path.join(dir, "steps.jsonl"), new SecretStore());
    for (let i = 0; i < 10; i++) {
      log.append({
        actor: "model",
        action: "click",
        args: {},
        result: { ok: true },
        url: "https://app.test/",
        fingerprint: "f",
      });
    }
    expect(log.recent(3)).toEqual([8, 9, 10]);
    expect(log.recent(50)).toHaveLength(10);
    log.close();
  });
});
