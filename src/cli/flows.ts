import path from "node:path";
import { ConfigError } from "../config/load.js";
import { closeDb, flowBySlug, openMemoryDb } from "../memory/db.js";
import { replayFlow } from "../memory/replay.js";

export interface FlowsReplayOptions {
  slug: string;
  as?: string;
  headed?: boolean;
  dir?: string;
}

/**
 * Exit codes extend the Phase 1 set (0 ran / 2 environment / 3 config):
 * a replay that FAILS is a failed test, which CI must be able to see, so it
 * exits 1. A guard refusal is a configuration problem and exits 3.
 */
export async function flowsReplayCommand(opts: FlowsReplayOptions): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const flow = flowBySlug(db, opts.slug);
    if (!flow) {
      throw new ConfigError(
        `No flow named "${opts.slug}" in this project's memory.\nRun \`magpie flows list\` to see what is remembered.`,
      );
    }
    if (!flow.steps.length) {
      throw new ConfigError(`Flow "${opts.slug}" has no steps to replay.`);
    }

    console.log(`replaying ${flow.slug} — ${flow.name}`);
    console.log(`${flow.steps.length} step(s), no model calls\n`);

    const result = await replayFlow(flow, { dir, db }, {
      ...(opts.as ? { authName: opts.as } : {}),
      ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
      narrate: (line) => console.log(line),
    });

    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log("");
    if (result.passed) {
      console.log(`PASS  ${result.slug} — ${result.stepsRun} step(s) in ${seconds}s`);
    } else {
      console.log(`FAIL  ${result.slug} at step ${result.failedAt}/${result.stepsTotal}`);
      console.log(`      ${result.reason}`);
    }
    console.log(`LLM requests: 0`);
    console.log(`evidence: ${path.join(result.reportDir, "steps.jsonl")}`);
    console.log(`flow status is now: ${flowBySlug(db, flow.slug)?.status}`);

    process.exitCode = result.passed ? 0 : result.refused ? 3 : 1;
  } finally {
    closeDb(db);
  }
}
