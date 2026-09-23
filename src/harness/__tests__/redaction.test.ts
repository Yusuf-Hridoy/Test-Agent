import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp } from "./fakeapp.js";
import { runSession } from "../session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { writeHtmlReport } from "../../report/html.js";
import { loadConfig } from "../../config/load.js";
import type { SessionResult } from "../../types.js";

const PASSWORD = "hunter2-super-secret";
const API_KEY = "sk-test-do-not-leak-me";

const plan = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({
    id: `O-0${i + 1}`,
    description: `Objective ${i + 1}`,
    technique: "happy-path",
  })),
);

/** Hard Rule 2: nothing secret reaches a provider, a log or the report. */
describe("redaction across a whole session", () => {
  let app: { url: string; close: () => Promise<void> };
  let dir: string;
  let result: SessionResult;
  const sentToProvider: string[] = [];
  const narrated: string[] = [];

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-redact-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture\nbase_url: ${app.url}\nmodel:\n  min_delay_ms: 0\n`,
    );
    fs.writeFileSync(path.join(dir, ".env"), `GOOGLE_GENERATIVE_AI_API_KEY=${API_KEY}\n`);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = API_KEY;

    const script = [
      () => ({ toolName: "goto", input: { url: "/login" } }),
      (t: string) => ({ toolName: "fill", input: { id: idFor(t, /Username/), text: "standard_user" } }),
      (t: string) => ({ toolName: "fill", input: { id: idFor(t, /Password/), text: PASSWORD } }),
      (t: string) => ({ toolName: "click", input: { id: idFor(t, /Log in/) } }),
      () => ({
        toolName: "report_finding",
        input: {
          title: `Login accepted the password ${PASSWORD}`,
          severity: "low",
          expected: "credentials are not echoed",
          actual: `the page showed ${PASSWORD}`,
        },
      }),
      () => ({ toolName: "mark_objective", input: { status: "passed", note: `used ${PASSWORD}` } }),
    ];

    let calls = 0;
    const generate = async (req: unknown) => {
      const { system, messages } = req as { system: string; messages: { content: unknown }[] };
      sentToProvider.push(system, JSON.stringify(messages));
      const last = messages.at(-1)!.content;
      const text = typeof last === "string" ? last : JSON.stringify(last);
      if (calls++ === 0) return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
      const reply = script[calls - 2] ?? (() => ({ toolName: "mark_objective", input: { status: "blocked", note: "done" } }));
      const out = reply(text);
      return {
        text: "",
        toolCalls: [{ toolCallId: `c${calls}`, toolName: out.toolName, input: out.input }],
        usage: {},
        finishReason: "tool-calls",
      };
    };

    result = await runSession({
      dir,
      charter: "Log in and look around",
      generate: generate as never,
      narrate: (l) => narrated.push(l),
    });
    writeHtmlReport({
      result,
      cfg: loadConfig(dir),
      steps: [],
      budgetSummary: "x",
      providerSummary: "y",
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never sends the typed password or the API key to the provider", () => {
    const sent = sentToProvider.join("\n");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(PASSWORD);
    expect(sent).not.toContain(API_KEY);
  });

  it("never writes them into any report artifact", () => {
    const files = walk(result.reportDir).filter((f) => !f.endsWith(".png") && !f.endsWith(".zip"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toContain(PASSWORD);
      expect(text, file).not.toContain(API_KEY);
    }
  });

  it("returns a redacted SessionResult, not just a redacted file (S5)", () => {
    // The terminal summary and the HTML report render the RETURNED object.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(API_KEY);
  });

  it("never narrates them to the terminal", () => {
    expect(narrated.join("\n")).not.toContain(PASSWORD);
  });

  it("still records that the field was filled", () => {
    const steps = fs.readFileSync(path.join(result.reportDir, "steps.jsonl"), "utf8");
    expect(steps).toContain('"action":"fill"');
    expect(steps).toContain("«redacted»");
  });
});

function idFor(promptText: string, name: RegExp): string {
  const line = promptText.split("\n").find((l) => /e\d+ /.test(l) && name.test(l));
  return line?.trim().split(" ")[0] ?? "e999";
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}
