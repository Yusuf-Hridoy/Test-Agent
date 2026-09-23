import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MagpieConfig, Provider, ProviderUsage } from "../types.js";
import { envSecrets, loadConfig, projectPaths } from "../config/load.js";
import { SecretStore } from "../model/redact.js";
import { UsageTracker } from "../model/usage.js";
import type { GenerateFn } from "../model/ask.js";
import { isoNow, stamp } from "../util.js";
import { MAGPIE_VERSION } from "../version.js";
import {
  firstFindingByFingerprint,
  flowBySlug,
  listFlows,
  sessionCoveringTime,
  type MemoryDb,
} from "./db.js";
import { fingerprintOf } from "./fingerprint.js";
import { ingestSuite } from "./ingest.js";
import { replayFlow, type ReplayResult } from "./replay.js";
import { createHealer, type HealerHandle } from "./heal.js";
import type { StoredFlow } from "./types.js";

/**
 * What happened to one flow in a suite.
 *
 * HEALED is deliberately NOT a pass: a flow that only ran because a model
 * relocated one of its steps has not demonstrated that the application still
 * works, only that something similar is still there (§1.6).
 */
export type FlowOutcome = "PASS" | "FAIL" | "REFUSED" | "HEALED" | "SKIPPED" | "UNTESTED";

export interface SuiteFlowResult {
  slug: string;
  name: string;
  /** The flow's status before this suite ran. */
  statusBefore: string;
  statusAfter: string;
  outcome: FlowOutcome;
  failedAt?: number;
  reason?: string;
  stepsRun: number;
  stepsTotal: number;
  durationMs: number;
  reportDir?: string;
  /** When this flow last passed a replay, for the regression oracle. */
  lastPassAt?: string;
  healedStep?: number;
  healNote?: string;
}

export interface SuiteResult {
  magpieVersion: string;
  project: string;
  baseUrl: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  selection: { requested: string; includeDraft: boolean; heal: boolean };
  totals: {
    total: number;
    passed: number;
    failed: number;
    refused: number;
    healed: number;
    skipped: number;
    untested: number;
  };
  flows: SuiteFlowResult[];
  /** Regression findings raised by this suite (P3-T3). */
  findings: SuiteFinding[];
  usage: Record<Provider, ProviderUsage>;
  healCalls: number;
  environmentDown: boolean;
  exitCode: number;
  reportDir: string;
}

export interface SuiteFinding {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  oracle: "regression";
  confidence: "high";
  flow: string;
  failedAt?: number;
  expected: string;
  actual: string;
  lastPassAt?: string;
  lastPassSession?: string;
  /** NEW on its first sighting, KNOWN once memory has seen it before (§1.5). */
  status: "NEW" | "KNOWN";
  seenCount: number;
  firstSeenAt?: string;
  reportDir?: string;
}

/** The contract CI consumes. Validated in tests so a field rename cannot slip out. */
export const suiteFlowSchema = z.object({
  slug: z.string(),
  name: z.string(),
  statusBefore: z.string(),
  statusAfter: z.string(),
  outcome: z.enum(["PASS", "FAIL", "REFUSED", "HEALED", "SKIPPED", "UNTESTED"]),
  failedAt: z.number().optional(),
  reason: z.string().optional(),
  stepsRun: z.number(),
  stepsTotal: z.number(),
  durationMs: z.number(),
  reportDir: z.string().optional(),
  lastPassAt: z.string().optional(),
  healedStep: z.number().optional(),
  healNote: z.string().optional(),
});

export const suiteSchema = z.object({
  magpieVersion: z.string(),
  project: z.string(),
  baseUrl: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number(),
  selection: z.object({
    requested: z.string(),
    includeDraft: z.boolean(),
    heal: z.boolean(),
  }),
  totals: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    refused: z.number(),
    healed: z.number(),
    skipped: z.number(),
    untested: z.number(),
  }),
  flows: z.array(suiteFlowSchema),
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      oracle: z.literal("regression"),
      confidence: z.literal("high"),
      flow: z.string(),
      failedAt: z.number().optional(),
      expected: z.string(),
      actual: z.string(),
      lastPassAt: z.string().optional(),
      lastPassSession: z.string().optional(),
      status: z.enum(["NEW", "KNOWN"]),
      seenCount: z.number(),
      firstSeenAt: z.string().optional(),
      reportDir: z.string().optional(),
    }),
  ),
  usage: z.record(
    z.string(),
    z.object({ requests: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
  ),
  healCalls: z.number(),
  environmentDown: z.boolean(),
  exitCode: z.number(),
  reportDir: z.string(),
});

export interface RegressOptions {
  dir: string;
  /** A flow slug, or "all". */
  requested: string;
  includeDraft?: boolean;
  heal?: boolean;
  headed?: boolean;
  authName?: string;
  /** Progress lines. In --json mode the CLI sends these to stderr. */
  narrate?: (line: string) => void;
  /** Test seam for the healer, mirroring runSession's. */
  generate?: GenerateFn;
}

export const ALL = "all";

/**
 * Which flows does this suite run, and which does it merely report?
 *
 * A `broken` flow is never silently dropped: a regression suite that quietly
 * shrinks as flows break is a suite that reports green while covering less and
 * less (Hard Rule 9's spirit).
 */
export function selectFlows(
  db: MemoryDb,
  requested: string,
  includeDraft = false,
): { run: StoredFlow[]; skipped: { flow: StoredFlow; why: string }[]; missing?: string } {
  if (requested !== ALL) {
    const flow = flowBySlug(db, requested);
    if (!flow) return { run: [], skipped: [], missing: requested };
    // Named explicitly: the user asked for this one, status notwithstanding.
    return { run: [flow], skipped: [] };
  }

  const run: StoredFlow[] = [];
  const skipped: { flow: StoredFlow; why: string }[] = [];
  for (const row of listFlows(db)) {
    const flow = flowBySlug(db, row.slug)!;
    if (!flow.steps.length) {
      skipped.push({ flow, why: "no steps recorded" });
    } else if (flow.status === "verified") {
      run.push(flow);
    } else if (flow.status === "draft") {
      if (includeDraft) run.push(flow);
      else skipped.push({ flow, why: "draft — pass --include-draft to run it" });
    } else {
      skipped.push({ flow, why: "broken — heal it or re-record it" });
    }
  }
  return { run, skipped };
}

/**
 * Replay a set of remembered flows as a suite.
 *
 * One browser context per flow: isolation beats speed here, because a suite
 * whose third flow only passes thanks to the second flow's leftover state is a
 * suite that lies the first time someone runs one flow alone.
 */
export async function runRegression(opts: RegressOptions): Promise<SuiteResult> {
  const startedAt = new Date();
  const paths = projectPaths(opts.dir);
  const cfg: MagpieConfig = loadConfig(opts.dir);
  const narrate = opts.narrate ?? (() => {});
  const reportDir = path.join(paths.reportsDir, `${stamp(startedAt)}-regress`);
  fs.mkdirSync(reportDir, { recursive: true });

  const { openMemoryDb, closeDb } = await import("./db.js");
  const db = openMemoryDb(opts.dir);
  const usage = new UsageTracker();
  // Healing is opt-in from either the flag or the config, and bounded for the
  // whole suite — not per flow, or a long suite could spend all day healing.
  const healingOn = opts.heal ?? cfg.regress.heal;
  const healer: HealerHandle | undefined = healingOn
    ? createHealer({
        cfg,
        usage,
        secrets: new SecretStore(envSecrets(opts.dir)),
        maxCalls: cfg.regress.max_heal_calls,
        log: narrate,
        ...(opts.generate ? { generate: opts.generate } : {}),
      })
    : undefined;
  const flows: SuiteFlowResult[] = [];
  const findings: SuiteFinding[] = [];
  let environmentDown = false;

  try {
    const selection = selectFlows(db, opts.requested, opts.includeDraft);
    if (selection.missing) {
      throw new RegressError(
        `No flow named "${selection.missing}" in this project's memory.\n` +
          `Run \`magpie flows list\` to see what is remembered.`,
      );
    }

    for (const { flow, why } of selection.skipped) {
      flows.push({
        slug: flow.slug,
        name: flow.name,
        statusBefore: flow.status,
        statusAfter: flow.status,
        outcome: "SKIPPED",
        reason: why,
        stepsRun: 0,
        stepsTotal: flow.steps.length,
        durationMs: 0,
        ...(flow.last_replay_result === "pass" && flow.last_replay_at
          ? { lastPassAt: flow.last_replay_at }
          : {}),
      });
      narrate(`  SKIP  ${flow.slug} — ${why}`);
    }

    narrate(
      `${selection.run.length} flow(s) to replay` +
        (selection.skipped.length ? `, ${selection.skipped.length} skipped` : ""),
    );

    for (const [index, flow] of selection.run.entries()) {
      if (environmentDown) {
        flows.push(untested(flow));
        narrate(`  ----  ${flow.slug} — not run (application unreachable)`);
        continue;
      }
      narrate(`\n▶ [${index + 1}/${selection.run.length}] ${flow.slug} (${flow.steps.length} steps)`);
      const before = { status: flow.status, lastPass: lastPassOf(flow) };

      const replay: ReplayResult = await replayFlow(flow, { dir: opts.dir, db }, {
        ...(opts.authName ? { authName: opts.authName } : {}),
        ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
        ...(healer ? { healer: healer.heal } : {}),
        narrate: (line) => narrate(line),
      });

      const after = flowBySlug(db, flow.slug);
      const outcome: FlowOutcome = replay.passed
        ? replay.healed.length
          ? "HEALED"
          : "PASS"
        : replay.refused
          ? "REFUSED"
          : replay.environmentDown
            ? "UNTESTED"
            : "FAIL";

      if (replay.environmentDown) {
        environmentDown = true;
        narrate(`  the application is unreachable — abandoning the rest of the suite`);
      }

      flows.push({
        slug: flow.slug,
        name: flow.name,
        statusBefore: before.status,
        statusAfter: after?.status ?? before.status,
        outcome,
        ...(replay.failedAt !== undefined ? { failedAt: replay.failedAt } : {}),
        ...(replay.reason ? { reason: replay.reason } : {}),
        stepsRun: replay.stepsRun,
        stepsTotal: replay.stepsTotal,
        durationMs: replay.durationMs,
        reportDir: replay.reportDir,
        ...(before.lastPass ? { lastPassAt: before.lastPass } : {}),
        ...(replay.healed.length ? { healedStep: replay.healed[0]!.seq } : {}),
        ...(replay.healed.length
          ? { healNote: replay.healed.map((h) => `${h.oldTarget} → ${h.newTarget} (${h.note})`).join("; ") }
          : replay.healNote
            ? { healNote: replay.healNote }
            : {}),
      });
      narrate(
        `  ${outcome}  ${flow.slug}` +
          (replay.passed ? "" : ` at step ${replay.failedAt}/${replay.stepsTotal}`),
      );
    }
    // ---- the regression oracle (§1.4) ----------------------------------
    // A flow that used to pass and now does not is the memory-based finding
    // this whole phase exists to make possible.
    for (const f of flows) {
      if (f.outcome !== "FAIL") continue;
      const title = `Flow "${f.slug}" no longer passes`;
      const pageKey = pageKeyFor(db, f.slug);
      // Raise it when the flow passed before this run, and keep raising it on
      // later runs of a flow already known to have regressed. Without the
      // second clause a nightly suite reports the breakage once and then goes
      // quiet about it, which is how a broken flow becomes invisible.
      const prior = firstFindingByFingerprint(db, fingerprintOf(title, pageKey, "regression"));
      if (!f.lastPassAt && !prior) continue;
      const lastPass = f.lastPassAt ? sessionCoveringTime(db, f.lastPassAt) : undefined;
      const since = prior?.session_started_at ?? prior?.created_at;
      findings.push({
        id: `R-${String(findings.length + 1).padStart(3, "0")}`,
        title,
        severity: "high",
        oracle: "regression",
        confidence: "high",
        flow: f.slug,
        ...(f.failedAt !== undefined ? { failedAt: f.failedAt } : {}),
        expected: f.lastPassAt
          ? `The flow "${f.name}" replays end to end, as it did on ${f.lastPassAt}.`
          : `The flow "${f.name}" replays end to end. It has been failing since ${since}.`,
        actual:
          `Step ${f.failedAt} of ${f.stepsTotal} failed: ${f.reason ?? "no reason recorded"}` +
          // The flow failing is the evidence; the model's note is context.
          (f.healNote ? `\n\nHealer's note: ${f.healNote}` : ""),
        ...(f.lastPassAt ? { lastPassAt: f.lastPassAt } : {}),
        ...(lastPass ? { lastPassSession: `session ${lastPass.id} (${lastPass.status})` } : {}),
        // Filled in by ingestion, which knows the project's whole history.
        status: "NEW",
        seenCount: 1,
        ...(f.reportDir ? { reportDir: f.reportDir } : {}),
      });
    }

    // Persist the suite so tomorrow's run knows what today already reported.
    const ingested = ingestSuite(db, {
      reportDir,
      startedAt: isoNow(startedAt),
      endedAt: isoNow(),
      status: "REGRESSION",
      charter: `regression: ${opts.requested}`,
      llmRequests: usage.totalRequests(),
      findings: findings.map((f) => ({
        fid: f.id,
        title: f.title,
        severity: f.severity,
        oracle: f.oracle,
        confidence: f.confidence,
        pageKey: pageKeyFor(db, f.flow),
      })),
    });
    for (const verdict of ingested.verdicts) {
      const finding = findings.find((f) => f.id === verdict.fid);
      if (!finding) continue;
      finding.status = verdict.status;
      finding.seenCount = verdict.seenCount;
      if (verdict.firstSeenAt) finding.firstSeenAt = verdict.firstSeenAt;
    }
  } finally {
    closeDb(db);
  }

  const totals = tally(flows);
  const endedAt = new Date();
  const healCalls = healer?.calls ?? 0;
  const result: SuiteResult = {
    magpieVersion: MAGPIE_VERSION,
    project: cfg.name,
    baseUrl: cfg.base_url,
    startedAt: isoNow(startedAt),
    endedAt: isoNow(endedAt),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    selection: {
      requested: opts.requested,
      includeDraft: Boolean(opts.includeDraft),
      heal: healingOn,
    },
    totals,
    flows,
    findings,
    usage: usage.snapshot(),
    healCalls,
    environmentDown,
    exitCode: exitCodeFor(totals, environmentDown),
    reportDir,
  };

  // The economic guarantee, asserted rather than assumed: without --heal a
  // whole suite must not cost a single model call.
  if (!healingOn && usage.totalRequests() !== 0) {
    throw new Error(
      `regression suite made ${usage.totalRequests()} model call(s) without --heal; it must make none`,
    );
  }

  fs.writeFileSync(path.join(reportDir, "suite.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export class RegressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressError";
  }
}

/** Where a flow's failure lives, for fingerprinting: its last step's page. */
function pageKeyFor(db: MemoryDb, slug: string): string | null {
  const flow = flowBySlug(db, slug);
  if (!flow) return null;
  return flow.steps.at(-1)?.url_after ?? flow.start_page_key ?? null;
}

function untested(flow: StoredFlow): SuiteFlowResult {
  return {
    slug: flow.slug,
    name: flow.name,
    statusBefore: flow.status,
    statusAfter: flow.status,
    outcome: "UNTESTED",
    reason: "the application was unreachable before this flow ran",
    stepsRun: 0,
    stepsTotal: flow.steps.length,
    durationMs: 0,
  };
}

function lastPassOf(flow: StoredFlow): string | undefined {
  return flow.last_replay_result === "pass" && flow.last_replay_at
    ? flow.last_replay_at
    : flow.status === "verified" && flow.last_replay_at
      ? flow.last_replay_at
      : undefined;
}

export function tally(flows: SuiteFlowResult[]): SuiteResult["totals"] {
  const count = (o: FlowOutcome) => flows.filter((f) => f.outcome === o).length;
  return {
    total: flows.length,
    passed: count("PASS"),
    failed: count("FAIL"),
    refused: count("REFUSED"),
    healed: count("HEALED"),
    skipped: count("SKIPPED"),
    untested: count("UNTESTED"),
  };
}

/**
 * 0 everything that ran passed · 1 something failed or was healed · 2 the
 * environment · 3 configuration. A healed flow exits 1 on purpose: it ran, but
 * nobody has yet shown the application still does what the flow asserts.
 */
export function exitCodeFor(totals: SuiteResult["totals"], environmentDown: boolean): number {
  if (environmentDown || totals.untested > 0) return 2;
  if (totals.failed > 0 || totals.healed > 0) return 1;
  if (totals.refused > 0) return 3;
  return 0;
}
