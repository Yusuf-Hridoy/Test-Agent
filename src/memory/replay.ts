import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { MagpieConfig, Provider, ProviderUsage } from "../types.js";
import { envSecrets, loadConfig, projectPaths } from "../config/load.js";
import { SecretStore } from "../model/redact.js";
import { UsageTracker } from "../model/usage.js";
import { closeBrowser, openBrowser, type BrowserSession } from "../browser/session.js";
import { checkClick, checkGoto } from "../browser/guard.js";
import { isEmpty } from "../browser/collect.js";
import { resolveTarget } from "../browser/locate.js";
import { takeSnapshot } from "../browser/snapshot.js";
import { StepLog } from "../evidence/steps.js";
import { ShotTaker } from "../evidence/shots.js";
import { isoNow, sleep, stamp, truncate } from "../util.js";
import { pageByKey, recordReplay, type MemoryDb } from "./db.js";
import { normalizePageKey } from "./pagekey.js";
import { SECRET_PLACEHOLDER, type FlowStepRow, type StoredFlow } from "./types.js";
import type { Healer } from "./heal.js";

/** How long a step's target may take to become unambiguous (§1.4). */
export const RESOLVE_TIMEOUT_MS = 5_000;
/** How long the page may take to reach the recorded page_key (§1.4). */
export const URL_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export const SECRET_STEP_REASON =
  "flow contains a secret value; secrets are never stored — re-record via a charter run";

export interface ReplayProject {
  dir: string;
  db: MemoryDb;
}

export interface ReplayOptions {
  headed?: boolean;
  authName?: string;
  narrate?: (line: string) => void;
  /**
   * Opt-in repair for a step whose target cannot be found (§1.6). Absent by
   * default: a replay that silently repairs itself is not a regression test.
   */
  healer?: Healer;
}

export interface HealedStep {
  seq: number;
  oldTarget: string;
  newTarget: string;
  note: string;
}

export interface ReplayResult {
  slug: string;
  passed: boolean;
  /** seq of the step that failed, when one did. */
  failedAt?: number;
  reason?: string;
  /** True when a Magpie guard stopped the replay — not evidence about the app. */
  refused?: boolean;
  /**
   * The application could not be reached at all. Hard Rule 6: that is an
   * environment problem, and a suite must stop rather than file N false
   * regressions against an app that is simply down.
   */
  environmentDown?: boolean;
  stepsRun: number;
  stepsTotal: number;
  /** Steps a model relocated for this run. Non-empty means HEALED, not passed. */
  healed: HealedStep[];
  /** The healer's comment when it judged the flow genuinely broken. */
  healNote?: string;
  reportDir: string;
  durationMs: number;
  /** Always all-zero: replay never calls a model. Asserted below. */
  usage: Record<Provider, ProviderUsage>;
}

/**
 * Replay a remembered flow against the live application.
 *
 * Deterministic by construction: a real browser, no model, no healing. A step
 * that cannot be resolved unambiguously is a failure, not a guess — a replay
 * that silently clicked a different button would report a green regression run
 * for a test nobody performed (Hard Rule 9).
 */
export async function replayFlow(
  flow: StoredFlow,
  project: ReplayProject,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const startedAt = Date.now();
  const paths = projectPaths(project.dir);
  const cfg: MagpieConfig = loadConfig(project.dir);
  const narrate = opts.narrate ?? (() => {});

  const reportDir = path.join(paths.reportsDir, `${stamp(new Date())}-replay-${flow.slug}`);
  fs.mkdirSync(reportDir, { recursive: true });

  const secrets = new SecretStore(envSecrets(project.dir));
  const usage = new UsageTracker(); // never touched — replay is free by design
  const stepLog = new StepLog(path.join(reportDir, "steps.jsonl"), secrets);
  const shots = new ShotTaker(reportDir);

  let session: BrowserSession | undefined;
  let failure: { seq: number; reason: string; refused?: boolean } | undefined;
  let stepsRun = 0;
  const healed: HealedStep[] = [];
  /** The patched rows, kept beside the report-facing summary. */
  const patches: FlowStepRow[] = [];
  let healNote: string | undefined;

  const log = (seq: number, action: string, ok: boolean, detail: string, url: string) =>
    stepLog.append({
      actor: "harness",
      action,
      args: { seq, flow: flow.slug },
      result: { ok, detail },
      url,
      fingerprint: "",
    });

  try {
    session = await openBrowser(cfg, {
      dir: project.dir,
      authName: opts.authName ?? "default",
      ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    });
    const page = session.page;

    // ---- start page ------------------------------------------------------
    const start = startUrlFor(project.db, flow, cfg);
    const startVerdict = checkGoto(start, cfg);
    if (!startVerdict.allowed) {
      failure = { seq: 0, reason: startVerdict.reason ?? "start page is out of scope", refused: true };
    } else {
      narrate(`  → ${start}`);
      try {
        await page.goto(start, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        log(0, "goto", true, `start page ${start}`, page.url());
      } catch (err) {
        failure = { seq: 0, reason: `could not open the start page ${start}: ${firstLine(err)}` };
        log(0, "goto", false, failure.reason, page.url());
      }
    }

    // ---- steps -----------------------------------------------------------
    for (const step of flow.steps) {
      if (failure) break;
      let outcome = await runStep(page, cfg, step);
      // What actually ran: the recorded step, or the healed version of it.
      let effective = step;

      // ---- healing (§1.6) ------------------------------------------------
      if (!outcome.ok && canHeal(opts, outcome, step)) {
        const { snap } = await takeSnapshot(page);
        const verdict = await opts.healer!({
          flowName: flow.name,
          flowDescription: flow.description,
          step,
          reason: outcome.detail,
          snapshot: snap,
        });
        if (verdict.verdict === "relocated") {
          const patched: FlowStepRow = {
            ...step,
            target_role: verdict.target.role,
            target_name: verdict.target.name,
            target_nth: verdict.target.nth,
          };
          // The retry goes through the same guards as any other step: a healer
          // that "finds" a Logout button must still be refused.
          const retry = await runStep(page, cfg, patched);
          log(step.seq, `${step.action}:healed`, retry.ok, `${verdict.note} → ${retry.detail}`, page.url());
          if (retry.ok) {
            healed.push({
              seq: step.seq,
              oldTarget: describeTarget(step),
              newTarget: describeTarget(patched),
              note: verdict.note,
            });
            patches.push(patched);
            narrate(`  [${step.seq}/${flow.steps.length}] healed: ${describeTarget(step)} → ${describeTarget(patched)}`);
            outcome = retry;
            effective = patched;
          } else {
            // No second opinion on the same step (§1.6).
            healNote = `${verdict.note}; the relocated target also failed: ${retry.detail}`;
          }
        } else {
          healNote = verdict.note;
        }
      }

      stepsRun++;
      log(step.seq, step.action, outcome.ok, outcome.detail, page.url());
      // Describe what ran, not what was recorded: after a heal, printing the old
      // target reads as though the target that just failed had worked.
      narrate(`  [${step.seq}/${flow.steps.length}] ${describe(effective)} → ${outcome.ok ? "OK" : "FAILED"}`);
      if (!outcome.ok) {
        failure = {
          seq: step.seq,
          reason: outcome.detail,
          ...(outcome.refused ? { refused: true } : {}),
        };
        break;
      }

      if (step.url_after) {
        const reached = await waitForPageKey(page, step.url_after, URL_TIMEOUT_MS);
        if (!reached) {
          const reason =
            `expected to be on ${step.url_after} after this step, but the browser is on ` +
            `${normalizePageKey(page.url())}`;
          log(step.seq, "url_check", false, reason, page.url());
          failure = { seq: step.seq, reason };
          break;
        }
      }
    }

    // ---- evidence --------------------------------------------------------
    if (failure) {
      const shot = await shots.capture(page, `fail-step-${failure.seq}`);
      const drained = session.collectors.drain();
      if (!isEmpty(drained)) {
        log(
          failure.seq,
          "evidence",
          false,
          `console: ${drained.console.slice(0, 5).join(" | ") || "none"} · ` +
            `network: ${drained.network.slice(0, 5).join(" | ") || "none"}`,
          page.url(),
        );
      }
      if (shot) log(failure.seq, "screenshot", true, shot, page.url());
    } else {
      await shots.capture(page, "replay-end");
    }
  } catch (err) {
    failure ??= { seq: stepsRun, reason: `replay crashed: ${firstLine(err)}` };
  } finally {
    await closeBrowser(session, path.join(reportDir, "trace.zip"));
    stepLog.close();
  }

  // Hard guarantee of this phase: replaying a remembered flow costs nothing.
  if (usage.totalRequests() !== 0) {
    throw new Error(`replay made ${usage.totalRequests()} model call(s); replay must never call a model`);
  }

  const result: ReplayResult = {
    slug: flow.slug,
    passed: !failure,
    ...(failure ? { failedAt: failure.seq, reason: failure.reason } : {}),
    ...(failure?.refused ? { refused: true } : {}),
    ...(failure && !failure.refused && looksLikeOutage(failure.reason) ? { environmentDown: true } : {}),
    stepsRun,
    stepsTotal: flow.steps.length,
    healed,
    ...(healNote ? { healNote } : {}),
    reportDir,
    durationMs: Date.now() - startedAt,
    usage: usage.snapshot(),
  };

  if (healed.length && result.passed) applyHeals(project.db, flow, healed, patches, reportDir);
  recordOutcome(project.db, flow, result);
  fs.writeFileSync(
    path.join(reportDir, "replay.json"),
    `${JSON.stringify(secrets.redactDeep(result), null, 2)}\n`,
  );
  return result;
}

/**
 * A guard refusal says nothing about the application, so it must not flip a
 * flow to `broken` — adding "cart" to forbidden_elements would otherwise read
 * as a regression in the app.
 */
function recordOutcome(db: MemoryDb, flow: StoredFlow, result: ReplayResult): void {
  const now = isoNow();
  if (result.refused) {
    recordReplay(db, flow.id, `refused@${result.failedAt}`, flow.status, now);
    return;
  }
  if (result.passed && result.healed.length) {
    // Healed is NOT verified: something ran, but nobody has yet shown the
    // application still does what this flow asserts (§1.6).
    recordReplay(db, flow.id, `healed@${result.healed.map((h) => h.seq).join(",")}`, "draft", now);
    return;
  }
  if (result.passed) {
    recordReplay(db, flow.id, "pass", "verified", now);
    return;
  }
  // An unreachable app says nothing about the flow either (Hard Rule 6).
  if (result.environmentDown) {
    recordReplay(db, flow.id, `environment@${result.failedAt}`, flow.status, now);
    return;
  }
  recordReplay(db, flow.id, `fail@${result.failedAt}`, "broken", now);
}

/**
 * A step is healable when a model could plausibly answer the question. A guard
 * refusal is a policy decision, and a `{secret}` value has nothing to type — in
 * neither case is the target the problem.
 */
function canHeal(opts: ReplayOptions, outcome: StepOutcome, step: FlowStepRow): boolean {
  if (!opts.healer || outcome.refused) return false;
  if (step.value === SECRET_PLACEHOLDER) return false;
  if (!step.target_name) return false;
  return true;
}

export function describeTarget(step: FlowStepRow): string {
  const nth = step.target_nth === null || step.target_nth === undefined ? "" : `#${step.target_nth}`;
  return `${step.target_role ?? "?"}:"${step.target_name ?? ""}"${nth}`;
}

/**
 * Persist a healed flow: record what changed, patch the steps, and demote it to
 * draft so the next clean replay has to earn `verified` back.
 */
function applyHeals(
  db: MemoryDb,
  flow: StoredFlow,
  healed: HealedStep[],
  patches: FlowStepRow[],
  sessionRef: string,
): void {
  const now = isoNow();
  const event = db.prepare(
    `INSERT INTO heal_events (flow_id, seq, old_target, new_target, model_note, session_ref, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const patch = db.prepare(
    "UPDATE flow_steps SET target_role = ?, target_name = ?, target_nth = ? WHERE flow_id = ? AND seq = ?",
  );
  db.transaction(() => {
    for (const h of healed) {
      event.run(flow.id, h.seq, h.oldTarget, h.newTarget, h.note, sessionRef, now);
      const patched = patches.find((p) => p.seq === h.seq);
      if (!patched) continue;
      patch.run(patched.target_role, patched.target_name, patched.target_nth, flow.id, h.seq);
    }
  })();
}

/** Where the flow starts: the page we actually saw, else the app's front door. */
export function startUrlFor(db: MemoryDb, flow: StoredFlow, cfg: MagpieConfig): string {
  const page = pageByKey(db, flow.start_page_key);
  return page?.sample_url ?? cfg.base_url;
}

interface StepOutcome {
  ok: boolean;
  detail: string;
  refused?: boolean;
}

async function runStep(page: Page, cfg: MagpieConfig, step: FlowStepRow): Promise<StepOutcome> {
  if (step.action === "goto") {
    const url = step.value ?? "";
    const verdict = checkGoto(url, cfg, page.url());
    if (!verdict.allowed) return { ok: false, detail: verdict.reason!, refused: true };
    try {
      await page.goto(new URL(url, page.url()).toString(), {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      return { ok: true, detail: `at ${page.url()}` };
    } catch (err) {
      return { ok: false, detail: `navigation to ${url} failed: ${firstLine(err)}` };
    }
  }

  if (step.action === "press") {
    try {
      await page.keyboard.press(step.value ?? "Enter", { delay: 20 });
      return { ok: true, detail: `pressed ${step.value}` };
    } catch (err) {
      return { ok: false, detail: `could not press "${step.value}": ${firstLine(err)}` };
    }
  }

  // Hard Rule 2 extended: the literal was never stored, so there is nothing to
  // type. Guessing would be worse than failing.
  if ((step.action === "fill" || step.action === "select") && step.value === SECRET_PLACEHOLDER) {
    return { ok: false, detail: SECRET_STEP_REASON };
  }

  if (step.target_name && !checkClick({ name: step.target_name }, cfg).allowed) {
    return {
      ok: false,
      detail: checkClick({ name: step.target_name }, cfg).reason!,
      refused: true,
    };
  }

  const found = await resolveTarget(
    page,
    { role: step.target_role, name: step.target_name ?? "", nth: step.target_nth },
    RESOLVE_TIMEOUT_MS,
  );
  if (!found.locator) {
    return { ok: false, detail: found.error ?? "target could not be resolved" };
  }

  try {
    switch (step.action) {
      case "click":
        await found.locator.click({ timeout: ACTION_TIMEOUT_MS });
        break;
      case "fill":
        await found.locator.fill(step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
        break;
      case "select":
        await found.locator.selectOption(step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
        break;
      default:
        return { ok: false, detail: `"${step.action}" is not a replayable action` };
    }
    await settle(page);
    return { ok: true, detail: `${step.action} "${step.target_name}"` };
  } catch (err) {
    return { ok: false, detail: `could not ${step.action} "${step.target_name}": ${firstLine(err)}` };
  }
}

async function waitForPageKey(page: Page, expected: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (normalizePageKey(page.url()) === expected) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Same settle as a live run: a submit that has not navigated yet must not win. */
async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    await page.waitForLoadState("networkidle", { timeout: 3_000 });
  } catch {
    // A page that never settles is still worth replaying against.
  }
}

export function describe(step: FlowStepRow): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.value}`;
    case "press":
      return `press ${step.value}`;
    case "fill":
      return `fill "${step.target_name}" = ${step.value === SECRET_PLACEHOLDER ? SECRET_PLACEHOLDER : `"${truncate(step.value ?? "", 30)}"`}`;
    case "select":
      return `select "${step.value}" in "${step.target_name}"`;
    default:
      return `${step.action} "${step.target_name}"${position(step)}`;
  }
}

/** Shown as 1-based in the CLI: "the 3rd match" reads better than "#2". */
function position(step: FlowStepRow): string {
  return step.target_nth === null || step.target_nth === undefined || step.target_nth === 0
    ? ""
    : ` (match ${step.target_nth + 1})`;
}

/**
 * Hard Rule 6, at replay scale: a connection error is the environment talking,
 * never the application failing a test.
 */
export function looksLikeOutage(reason: string): boolean {
  return /net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|chrome-error:\/\//i.test(reason);
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0] ?? "error";
}
