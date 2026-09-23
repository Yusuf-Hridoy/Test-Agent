import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp } from "./fakeapp.js";
import { runSession } from "../session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { RECOVERY_WAITS_MS } from "../envmon.js";
import type { SessionResult } from "../../types.js";

const plan = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({
    id: `O-0${i + 1}`,
    description: `Objective ${i + 1}`,
    technique: "happy-path",
  })),
);

const connectionError = () =>
  Object.assign(new Error("fetch failed"), {
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND generativelanguage.googleapis.com" },
  });

/** S3 substitute: the app drops out briefly, then returns. */
describe("transient outage", () => {
  let app: { url: string; close: () => Promise<void> };
  let dir: string;
  const originalWaits = [...RECOVERY_WAITS_MS];

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-transient-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture\nbase_url: ${app.url}\nmodel:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
    RECOVERY_WAITS_MS.splice(0, RECOVERY_WAITS_MS.length, 50, 50, 50);
  }, 60_000);

  afterAll(async () => {
    RECOVERY_WAITS_MS.splice(0, RECOVERY_WAITS_MS.length, ...originalWaits);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pauses, retries, resumes and completes — with no defect blamed on the outage", async () => {
    const port = new URL(app.url).port;
    let calls = 0;
    let downed = false;
    const generate = async () => {
      calls++;
      if (calls === 1) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      // Third turn: take the site down, then let the agent try to navigate.
      if (calls === 3 && !downed) {
        downed = true;
        await app.close();
        // Bring it back while the harness is in its retry window.
        setTimeout(() => {
          void startFakeApp(Number(port)).then((again) => {
            app = again;
          });
        }, 60);
      }
      const tool =
        calls >= 8
          ? { toolName: "mark_objective", input: { status: "passed", note: "done" } }
          : { toolName: "goto", input: { url: "/inventory" } };
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, ...tool }],
        usage: {},
        finishReason: "tool-calls",
      };
    };

    const lines: string[] = [];
    const result: SessionResult = await runSession({
      dir,
      charter: "shop",
      generate: generate as never,
      narrate: (l) => lines.push(l),
    });

    const narration = lines.join("\n");
    expect(narration).toMatch(/environment looks down — retry 1\/3/);
    expect(narration).toMatch(/environment recovered/);
    // It resumed rather than giving up.
    expect(result.status).not.toBe("ENVIRONMENT_DOWN");
    expect(result.observations.some((o) => o.type === "outage_recovered")).toBe(true);
    // Hard Rule 6: the outage produced no application findings.
    expect(result.findings.filter((f) => f.oracle !== "llm_judgment")).toHaveLength(0);
  }, 180_000);
});

/** Hard Rule 6: a dead network is never reported as an application bug. */
describe("total network outage (S4 substitute)", () => {
  let app: { url: string; close: () => Promise<void> };
  let dir: string;
  const originalWaits = [...RECOVERY_WAITS_MS];

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-outage-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture\nbase_url: ${app.url}\nmodel:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
    process.env.GROQ_API_KEY = "k";
    process.env.MISTRAL_API_KEY = "k";
    // Keep the retry schedule short so the test does not wait 3.5 minutes.
    RECOVERY_WAITS_MS.splice(0, RECOVERY_WAITS_MS.length, 50, 50, 50);
  }, 60_000);

  afterAll(async () => {
    RECOVERY_WAITS_MS.splice(0, RECOVERY_WAITS_MS.length, ...originalWaits);
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finalizes ENVIRONMENT_DOWN when the network dies mid-session, not BUDGET_EXHAUSTED", async () => {
    let calls = 0;
    let appKilled = false;
    const generate = async () => {
      calls++;
      if (calls === 1) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      if (calls === 2) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "c", toolName: "goto", input: { url: "/inventory" } }],
          usage: {},
          finishReason: "tool-calls",
        };
      }
      // The whole network drops: the provider AND the application under test.
      if (!appKilled) {
        appKilled = true;
        await app.close();
      }
      throw connectionError();
    };

    const lines: string[] = [];
    const result: SessionResult = await runSession({
      dir,
      charter: "shop",
      generate: generate as never,
      narrate: (l) => lines.push(l),
    });

    expect(result.status).toBe("ENVIRONMENT_DOWN");
    expect(result.observations.some((o) => o.type === "environment_down")).toBe(true);
    // Hard Rule 6: nothing from the outage window may be filed as a defect.
    expect(result.findings).toHaveLength(0);
    // The retry cadence must be visible to the operator.
    expect(lines.join("\n")).toMatch(/environment looks down — retry 1\/3/);
    // Evidence still lands despite the outage.
    expect(fs.existsSync(path.join(result.reportDir, "trace.zip"))).toBe(true);
    expect(fs.existsSync(path.join(result.reportDir, "session.json"))).toBe(true);
    // Work done before the outage is preserved.
    expect(result.stepCount).toBeGreaterThan(0);
  }, 180_000);
});

/** A dead server must read as a network failure, never as a scope violation. */
describe("browser error page classification (S3)", () => {
  it("reports a failed navigation, not an out-of-scope jump", async () => {
    const { chromium } = await import("playwright");
    const { parseConfig } = await import("../../config/load.js");
    const { takeSnapshot } = await import("../../browser/snapshot.js");
    const { click } = await import("../../browser/actions.js");
    const { SecretStore } = await import("../../model/redact.js");
    const { classifyActionResult } = await import("../envmon.js");

    const app = await startFakeApp();
    const cfg = parseConfig(`name: t\nbase_url: ${app.url}\n`);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(`${app.url}/inventory`, { waitUntil: "domcontentloaded" });
      const { snap, locators } = await takeSnapshot(page);
      const link = snap.elements.find((e) => /Broken page/i.test(e.name))!;
      expect(link).toBeDefined();

      await app.close(); // the server dies mid-session

      const result = await click(
        { page, cfg, snap, locators, secrets: new SecretStore() },
        link.id,
      );

      expect(result.ok).toBe(false);
      expect(result.navError).toBeTruthy();
      expect(result.detail).toMatch(/failed to load|did not respond/i);
      // …and the environment monitor must call that an outage.
      expect(
        classifyActionResult(result, { originWasReachable: true }).verdict,
      ).toBe("suspect_outage");
    } finally {
      await browser.close();
      await app.close().catch(() => {});
    }
  }, 120_000);
});
