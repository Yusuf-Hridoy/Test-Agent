import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReport, writeHtmlReport } from "../html.js";
import { renderTerminalReport } from "../terminal.js";
import { parseConfig } from "../../config/load.js";
import type { SessionResult, StepRecord } from "../../types.js";

const cfg = parseConfig(`name: demo\nbase_url: https://www.saucedemo.com\n`);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function fixture(): { result: SessionResult; steps: StepRecord[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-report-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shots", "001_before.png"), PNG);
  fs.writeFileSync(path.join(dir, "trace.zip"), "not really a trace");

  const steps: StepRecord[] = [
    {
      n: 1,
      t: "2026-09-16T14:32:05.000+02:00",
      actor: "model",
      action: "click",
      args: { id: "e4" },
      result: { ok: true, detail: 'Clicked "Add to cart". URL now /inventory.html' },
      url: "https://www.saucedemo.com/inventory.html",
      fingerprint: "aaa",
    },
    {
      n: 2,
      t: "2026-09-16T14:32:09.000+02:00",
      actor: "harness",
      action: "oracle:http_5xx",
      args: {},
      result: { ok: false, detail: "F-001" },
      url: "https://www.saucedemo.com/inventory.html",
      fingerprint: "aaa",
    },
  ];

  const result: SessionResult = {
    status: "COMPLETED",
    startedAt: "2026-09-16T14:32:00.000+02:00",
    endedAt: "2026-09-16T14:38:30.000+02:00",
    charter: "Log in, add the cheapest item to the cart <script>alert(1)</script>",
    objectives: [
      { id: "O-01", description: "Log in", technique: "happy-path", status: "passed" },
      { id: "O-02", description: "Badge shows 1", technique: "state-transition", status: "finding", note: "badge stayed empty" },
    ],
    findings: [
      {
        id: "F-001",
        title: "Cart badge does not update",
        severity: "high",
        oracle: "http_5xx",
        confidence: "high",
        expected: "badge shows 1",
        actual: "badge stays empty",
        objectiveId: "O-02",
        steps: [1],
        screenshots: ["shots/001_before.png", "shots/missing.png"],
        console: ["console.error: boom"],
        network: ["GET /api/cart → 500"],
      },
    ],
    observations: [{ type: "slow_page", detail: "goto /inventory needed an extra 15000ms" }],
    usage: {
      gemini: { requests: 25, inputTokens: 100, outputTokens: 20 },
      groq: { requests: 4, inputTokens: 10, outputTokens: 2 },
      mistral: { requests: 0, inputTokens: 0, outputTokens: 0 },
    },
    stepCount: 2,
    reportDir: dir,
  };
  return { result, steps };
}

describe("HTML report", () => {
  it("is self-contained: no external assets, screenshots inlined", () => {
    const { result, steps } = fixture();
    const html = renderReport({
      result,
      cfg,
      steps,
      budgetSummary: "34/80 steps · 29/60 LLM calls · 6.5/20 min",
      providerSummary: "gemini 25 / groq 4",
    });
    expect(html).not.toMatch(/<(script|link)\b/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\//i);
    expect(html).toContain("data:image/png;base64,");
    // A screenshot file that never made it to disk is skipped, not broken.
    expect(html).not.toContain('src="shots/missing.png"');
  });

  it("shows every required section", () => {
    const { result, steps } = fixture();
    const html = renderReport({ result, cfg, steps, budgetSummary: "b", providerSummary: "gemini 25 / groq 4" });
    for (const needle of [
      "demo",
      'class="badge COMPLETED"',
      "gemini 25 / groq 4",
      "O-01",
      "state-transition",
      "F-001",
      "oracle: http_5xx",
      "confidence: high",
      "Repro steps",
      "console.error: boom",
      "GET /api/cart → 500",
      "slow_page",
      "Step timeline",
      "trace.zip",
    ]) {
      expect(html, needle).toContain(needle);
    }
  });

  it("shows captured screenshots even when the run found nothing (S1)", () => {
    const { result, steps } = fixture();
    const clean: SessionResult = { ...result, findings: [] };
    const html = renderReport({ result: clean, cfg, steps, budgetSummary: "b", providerSummary: "p" });
    expect(html).toContain("<h2>Screenshots</h2>");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("001_before.png");
    // Open by default when there are no finding cards to look at.
    expect(html).toMatch(/<details open><summary>1 captured/);
  });

  it("escapes untrusted text from the app and the model", () => {
    const { result, steps } = fixture();
    const html = renderReport({ result, cfg, steps, budgetSummary: "b", providerSummary: "p" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("writes index.html into the report dir", () => {
    const { result, steps } = fixture();
    const out = writeHtmlReport({ result, cfg, steps, budgetSummary: "b", providerSummary: "p" });
    expect(out).toBe(path.join(result.reportDir, "index.html"));
    expect(fs.readFileSync(out, "utf8")).toContain("<!doctype html>");
  });
});

describe("terminal report", () => {
  it("ends with the absolute report path", () => {
    const { result } = fixture();
    const text = renderTerminalReport({
      result,
      budgetSummary: "34/80 steps",
      providerSummary: "gemini 25",
      htmlPath: "/tmp/x/index.html",
    });
    expect(text.split("\n").at(-1)).toContain("/tmp/x/index.html");
    expect(text).toContain("COMPLETED");
    expect(text).toContain("F-001");
    expect(text).toContain("✔ O-01");
  });
});
