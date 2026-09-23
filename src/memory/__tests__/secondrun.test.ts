import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "../../harness/__tests__/fakeapp.js";
import { runSession } from "../../harness/session.js";
import { _resetRateLimiter } from "../../model/ask.js";
import { closeDb, counts, listFlows, openMemoryDb } from "../db.js";
import { MEMORY_HEADING } from "../context.js";

/**
 * Two runs in one project: the second must plan against what the first learned.
 * This is the phase's promise end to end — the unit form of acceptance A3.
 */
const plan = JSON.stringify([
  { id: "O-01", description: "Enter the shop from the landing page", technique: "happy-path" },
  { id: "O-02", description: "Second objective", technique: "boundary" },
  { id: "O-03", description: "Third objective", technique: "duplicate" },
  { id: "O-04", description: "Fourth objective", technique: "invalid-input" },
  { id: "O-05", description: "Fifth objective", technique: "required-field" },
]);

describe("a second run in the same project", () => {
  let app: FakeApp;
  let dir: string;
  const plannerPrompts: string[] = [];

  beforeAll(async () => {
    _resetRateLimiter();
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-second-"));
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "magpie.config.yaml"),
      `name: fixture-shop\nbase_url: ${app.url}\n` +
        `budget:\n  max_steps: 40\n  max_llm_requests: 30\n  max_minutes: 5\n` +
        `model:\n  min_delay_ms: 0\n`,
    );
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

    const runOnce = async () => {
      let calls = 0;
      const generate = async (req: unknown) => {
        const { messages } = req as { messages: { content: unknown }[] };
        const last = messages.at(-1)!.content;
        const text = typeof last === "string" ? last : JSON.stringify(last);
        if (calls++ === 0) {
          plannerPrompts.push(text);
          return { text: plan, toolCalls: [], usage: {}, finishReason: "stop" };
        }
        // One click to make a flow, then block everything else.
        if (calls === 2) {
          const id =
            text.split("\n").find((l) => /^ {2}e\d+ /.test(l) && /Enter the shop/.test(l))?.trim().split(" ")[0] ??
            "e1";
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
              toolCallId: `c${calls}`,
              toolName: "mark_objective",
              input: { status: calls === 3 ? "passed" : "blocked", note: "scripted" },
            },
          ],
          usage: {},
          finishReason: "tool-calls",
        };
      };
      await runSession({ dir, charter: "Enter the shop", generate: generate as never });
    };

    await runOnce();
    await runOnce();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plans the first run with no memory at all", () => {
    expect(plannerPrompts[0]).not.toContain(MEMORY_HEADING);
  });

  it("plans the second run against the remembered app map and flows", () => {
    expect(plannerPrompts[1]).toContain(MEMORY_HEADING);
    expect(plannerPrompts[1]).toContain("PAGES SEEN");
    expect(plannerPrompts[1]).toContain("127.0.0.1");
  });

  it("keeps one row per remembered thing across both runs", () => {
    const db = openMemoryDb(dir);
    try {
      const c = counts(db);
      expect(c.sessions).toBe(2);
      // The same flow recorded twice is one flow, not two.
      expect(listFlows(db).filter((f) => f.slug === "enter-the-shop-from-the-landing-page")).toHaveLength(1);
      // Both runs walked the same two pages.
      expect(c.pages).toBe(2);
    } finally {
      closeDb(db);
    }
  });
});
