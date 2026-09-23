import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ConfigError } from "../config/load.js";
import {
  closeDb,
  deleteFlow,
  flowBySlug,
  listFlows,
  openMemoryDb,
  renameFlow,
} from "../memory/db.js";
import { describe as describeStep, replayFlow } from "../memory/replay.js";
import { renderTable } from "../report/terminal.js";
import { isoNow, truncate } from "../util.js";

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
    const flow = requireFlow(db, opts.slug);
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

export interface FlowsOptions {
  dir?: string;
}

/** `magpie flows list` — what this project can replay. */
export function flowsListCommand(opts: FlowsOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const flows = listFlows(db);
    if (!flows.length) {
      console.log("No flows remembered yet. Run `magpie run --charter \"…\"` first.");
      return;
    }
    console.log(
      renderTable(
        ["STATUS", "SLUG", "STEPS", "LAST REPLAY", "NAME"],
        flows.map((f) => [
          f.status,
          truncate(f.slug, 44),
          String(
            (db.prepare("SELECT COUNT(*) AS n FROM flow_steps WHERE flow_id = ?").get(f.id) as {
              n: number;
            }).n,
          ),
          f.last_replay_at ? `${f.last_replay_result} (${f.last_replay_at.slice(0, 10)})` : "never",
          truncate(f.name, 40),
        ]),
        "",
      ),
    );
  } finally {
    closeDb(db);
  }
}

/** `magpie flows show <slug>` — the steps, in the order replay will run them. */
export function flowsShowCommand(slug: string, opts: FlowsOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const flow = requireFlow(db, slug);
    console.log(`${flow.name}`);
    console.log(`slug         ${flow.slug}`);
    console.log(`status       ${flow.status}`);
    console.log(`starts on    ${flow.start_page_key}`);
    console.log(`recorded     ${flow.created_at.slice(0, 16).replace("T", " ")} (${flow.origin_objective ?? "?"})`);
    console.log(
      `last replay  ${flow.last_replay_at ? `${flow.last_replay_result} at ${flow.last_replay_at.slice(0, 16).replace("T", " ")}` : "never"}`,
    );
    if (flow.description) console.log(`from charter "${truncate(flow.description, 60)}"`);
    console.log("");
    console.log(
      renderTable(
        ["SEQ", "STEP", "ENDS ON"],
        flow.steps.map((s) => [String(s.seq), describeStep(s), s.url_after ?? ""]),
        "",
      ),
    );
  } finally {
    closeDb(db);
  }
}

/** `magpie flows rename <slug> <new name>` — the slug is the identity, the name is for humans. */
export function flowsRenameCommand(slug: string, name: string, opts: FlowsOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    requireFlow(db, slug);
    const newName = name.trim();
    if (!newName) throw new ConfigError("A new name is required.");
    renameFlow(db, slug, newName, isoNow());
    console.log(`${slug} is now named "${newName}"`);
  } finally {
    closeDb(db);
  }
}

/**
 * `magpie flows verify <slug>` — promote a flow by proving it still runs.
 *
 * Deliberately a replay and nothing else: `verified` must always mean "a replay
 * passed against the live app", or the status is just an opinion.
 */
export async function flowsVerifyCommand(opts: FlowsReplayOptions): Promise<void> {
  await flowsReplayCommand(opts);
}

/** `magpie flows delete <slug>` — steps cascade; the run reports stay on disk. */
export async function flowsDeleteCommand(
  slug: string,
  opts: FlowsOptions & { yes?: boolean } = {},
): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const flow = requireFlow(db, slug);
    if (!opts.yes) {
      const rl = readline.createInterface({ input, output });
      try {
        const answer = (
          await rl.question(`Delete flow "${flow.name}" (${flow.steps.length} steps)? [y/N] `)
        ).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log("Left alone.");
          return;
        }
      } finally {
        rl.close();
      }
    }
    deleteFlow(db, slug);
    console.log(`Deleted ${slug}.`);
  } finally {
    closeDb(db);
  }
}

function requireFlow(db: ReturnType<typeof openMemoryDb>, slug: string) {
  const flow = flowBySlug(db, slug);
  if (!flow) {
    throw new ConfigError(
      `No flow named "${slug}" in this project's memory.\nRun \`magpie flows list\` to see what is remembered.`,
    );
  }
  return flow;
}
