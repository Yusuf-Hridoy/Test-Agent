import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type {
  Finding,
  MagpieConfig,
  Objective,
  SessionResult,
  SessionStatus,
  Snapshot,
} from "../types.js";
import { envSecrets, loadConfig, projectPaths } from "../config/load.js";
import { SecretStore } from "../model/redact.js";
import { UsageTracker } from "../model/usage.js";
import { askModel, ModelExhaustedError, type GenerateFn } from "../model/ask.js";
import { closeBrowser, openBrowser, saveAuthState, type BrowserSession } from "../browser/session.js";
import { takeSnapshot } from "../browser/snapshot.js";
import * as actions from "../browser/actions.js";
import { isEmpty, type Drained } from "../browser/collect.js";
import { isUrlInScope } from "../browser/guard.js";
import { StepLog } from "../evidence/steps.js";
import { ShotTaker } from "../evidence/shots.js";
import { FindingBuilder, oracleFindingsFor } from "../evidence/findings.js";
import { FlowDrafter } from "../evidence/flows.js";
import { buildExecutorMessages, executorSystemPrompt } from "../agent/prompts.js";
import { planSession, PlanFailedError } from "../agent/plan.js";
import { isBrowserTool, magpieTools, toolInput } from "../agent/tools.js";
import { Budget, describeBudgetHit } from "./budgets.js";
import { fingerprint, LoopDetector } from "./loopdetect.js";
import { classifyActionResult, slowGrace, waitForRecovery } from "./envmon.js";
import { ensureAuthenticated } from "./auth.js";
import { ingestIntoMemory, readMemoryContext } from "../memory/record.js";
import { normalizePageKey } from "../memory/pagekey.js";
import { isoNow, sleep, stamp, truncate } from "../util.js";

export interface SessionOptions {
  dir: string;
  charter: string;
  authName?: string;
  headed?: boolean;
  narrate?: (line: string) => void;
  /** Test seam, mirroring askModel's — production callers never set this. */
  generate?: GenerateFn;
}

const STALL_NUDGE = "SYSTEM: Respond with exactly one tool call.";
/** Grace for async requests to report back before their evidence is drained. */
const SETTLE_BEFORE_DRAIN_MS = 400;
/** How many preceding steps a finding carries as its repro (brief: "repro steps"). */
const REPRO_STEPS = 6;

/**
 * The loop. Every stop condition, retry and guard in here is plain TypeScript;
 * the model only ever answers one question at a time (CLAUDE.md §3).
 */
export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const paths = projectPaths(opts.dir);
  const cfg: MagpieConfig = loadConfig(opts.dir);

  const startedAt = new Date();
  const reportDir = path.join(paths.reportsDir, stamp(startedAt));
  fs.mkdirSync(reportDir, { recursive: true });

  const secrets = new SecretStore(envSecrets(opts.dir));
  // Everything that leaves this function — terminal, JSON, report — goes through
  // the redactor, because notes and findings are written by the model.
  const narrate = (line: string) => (opts.narrate ?? (() => {}))(secrets.redact(line));
  const observe = (type: string, detail: string) =>
    observations.push({ type, detail: secrets.redact(detail) });
  const observations: { type: string; detail: string }[] = [];
  const usage = new UsageTracker();
  const budget = new Budget(cfg, usage, startedAt.getTime());
  const stepLog = new StepLog(path.join(reportDir, "steps.jsonl"), secrets);
  const shots = new ShotTaker(reportDir);
  const findings = new FindingBuilder(secrets);
  const flows = new FlowDrafter(path.join(reportDir, "flows.draft.json"), secrets);
  const loop = new LoopDetector();
  /** page_key → the last snapshot taken there; ingestion reads titles/elements from it. */
  const pageSnapshots = new Map<string, Snapshot>();
  /** Every snapshot goes through here so memory sees the pages the agent saw. */
  const snapshot = async (p: Page) => {
    const taken = await takeSnapshot(p);
    const key = normalizePageKey(taken.snap.url);
    if (key) pageSnapshots.set(key, taken.snap);
    return taken;
  };

  let objectives: Objective[] = [];
  let status: SessionStatus = "COMPLETED";
  let session: BrowserSession | undefined;
  let originWasReachable = false;

  const harnessStep = (action: string, detail: string, ok = true, url = "", fp = "") =>
    stepLog.append({
      actor: "harness",
      action,
      args: {},
      result: { ok, detail },
      url,
      fingerprint: fp,
    });

  const checkpoint = () => {
    const file = path.join(reportDir, "checkpoint.json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        secrets.redactDeep({
          updatedAt: isoNow(),
          status,
          charter: opts.charter,
          budget: budget.summary(),
          steps: stepLog.count,
          findings: findings.count,
          objectives,
        }),
        null,
        2,
      ),
    );
  };

  try {
    session = await openBrowser(cfg, {
      dir: opts.dir,
      authName: opts.authName ?? "default",
      ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    });
    const page: Page = session.page;

    // ---- AUTH_CHECK ------------------------------------------------------
    narrate(`checking session against ${cfg.base_url}`);
    const auth = await ensureAuthenticated({ page, cfg, secrets, log: narrate });
    budget.countStep();
    harnessStep("auth_check", auth.detail, auth.ok, page.url());
    if (!auth.ok) {
      status = "AUTH_REQUIRED";
      observe("auth", auth.detail);
      checkpoint();
      return finish();
    }
    originWasReachable = true;
    if (auth.reauthenticated) {
      const saved = await saveAuthState(session.context, opts.dir, opts.authName ?? "default");
      narrate(`saved session to ${path.relative(paths.dir, saved)}`);
    }
    narrate(auth.detail);

    // ---- PLANNING --------------------------------------------------------
    let current = await snapshot(page);
    // What previous sessions learned about this app, if anything (Phase 2).
    const memory = readMemoryContext(opts.dir, opts.charter);
    if (memory) narrate("planning with what previous sessions learned about this app");
    try {
      objectives = await planSession({
        charter: opts.charter,
        snapshot: current.snap,
        cfg,
        usage,
        secrets,
        log: narrate,
        ...(memory ? { memory } : {}),
        ...(opts.generate ? { generate: opts.generate } : {}),
      });
    } catch (err) {
      if (err instanceof ModelExhaustedError && err.networkFailure) {
        // The machine has no network: the app is unreachable too. That is an
        // environment problem, not a planning failure.
        status = "ENVIRONMENT_DOWN";
        observe("environment_down", `no network while planning: ${err.message}`);
        harnessStep("plan", "no network reaching any model provider", false, page.url());
        checkpoint();
        return finish();
      }
      if (err instanceof PlanFailedError || err instanceof ModelExhaustedError) {
        // No provider answered → the session never started; that is a failed
        // plan, not a crash, and the observation carries every attempt.
        status = "PLAN_FAILED";
        observe("plan_failed", err.message);
        harnessStep("plan", truncate(err.message, 300), false, page.url());
        checkpoint();
        return finish();
      }
      throw err;
    }
    budget.countStep();
    harnessStep("plan", `${objectives.length} objectives planned`, true, page.url());
    for (const o of objectives) narrate(`  ${o.id} [${o.technique}] ${o.description}`);
    checkpoint();

    // ---- EXECUTING -------------------------------------------------------
    objectives: for (const objective of objectives) {
      const hitBefore = budget.hit();
      if (hitBefore) {
        status = "BUDGET_EXHAUSTED";
        narrate(`${describeBudgetHit(hitBefore)} — finalizing`);
        break;
      }

      objective.status = "in-progress";
      narrate(`\n▶ ${objective.id} ${objective.description}`);
      loop.reset();
      flows.discard();

      const objectiveSteps: number[] = [];
      const history: string[] = [];
      let oracleNotes: string[] = [];
      let pendingScreenshot: string | undefined;
      let systemNote: string | undefined;
      let plainTextReplies = 0;
      let modelNetworkFailures = 0;
      let lastShot: string | undefined;
      let findingsHere = 0;

      /**
       * Evidence that arrived after the last action (late XHRs, deferred console
       * errors) still belongs to this objective — harvest it before moving on.
       */
      const harvestPendingOracles = async (url: string, fp: string): Promise<void> => {
        if (!session) return;
        await sleep(SETTLE_BEFORE_DRAIN_MS);
        const drained = session.collectors.drain();
        if (isEmpty(drained)) return;
        if (
          classifyActionResult({ ok: true, detail: "" }, {
            originWasReachable,
            serverErrorUrls: session.collectors.serverErrorUrls(),
          }).verdict === "suspect_outage"
        ) {
          // Hard Rule 6: mass 5xx is an outage, not a defect in the application.
          observe("environment", `late errors ignored during a suspected outage: ${drained.network.slice(0, 3).join("; ")}`);
          return;
        }
        const scoped = splitByScope(drained, cfg);
        if (scoped.external.length) {
          observe("third_party_request_failed", `ignored ${scoped.external.length} failed request(s) outside the app under test: ${scoped.external.slice(0, 2).join("; ")}`);
        }
        if (isEmpty(scoped.own)) return;
        const after = await shots.capture(page, `${objective.id}-oracle`);
        for (const candidate of oracleFindingsFor(scoped.own)) {
          const beforeCount = findings.count;
          const finding = findings.add({
            ...candidate,
            objectiveId: objective.id,
            steps: objectiveSteps.slice(-REPRO_STEPS),
            screenshots: [lastShot, after],
            evidence: scoped.own,
          });
          findingsHere++;
          const hn = budget.countStep();
          harnessStep(`oracle:${finding.oracle}`, `${finding.id}: ${finding.title}`, false, url, fp);
          objectiveSteps.push(hn);
          if (findings.count > beforeCount) {
            narrate(`  ! ${finding.id} ${finding.oracle} (${finding.severity}): ${truncate(finding.title, 80)}`);
          }
        }
        if (after) lastShot = after;
      };

      // ---- one objective ------------------------------------------------
      for (;;) {
        const hit = budget.hit();
        if (hit) {
          status = "BUDGET_EXHAUSTED";
          objective.note = `stopped: ${describeBudgetHit(hit)}`;
          narrate(`${describeBudgetHit(hit)} — finalizing`);
          break objectives;
        }

        if (loop.shouldForceBlock(objective.id)) {
          objective.status = "blocked";
          objective.note = "harness blocked this objective: the agent stopped making progress";
          budget.countStep();
          harnessStep("force_block", objective.note, false, current.snap.url);
          narrate(`  ✖ ${objective.id} blocked by the harness (no progress)`);
          break;
        }

        let res;
        try {
          res = await askModel(
            {
              system: executorSystemPrompt({
                objective: objective.description,
                stepsLeft: budget.stepsLeft(),
                llmLeft: budget.llmLeft(),
              }),
              messages: buildExecutorMessages({
                objective,
                snapshot: current.snap,
                history,
                oracleNotes,
                ...(pendingScreenshot ? { pendingScreenshot } : {}),
                ...(systemNote ? { systemNote } : {}),
              }),
              tools: magpieTools,
            },
            cfg,
            usage,
            secrets,
            opts.generate,
          );
        } catch (err) {
          if (err instanceof ModelExhaustedError) {
            if (err.networkFailure) {
              // No network at all — the same outage the browser would hit.
              // Give it the normal recovery window before giving up.
              narrate("  environment check: no network reaching any model provider");
              budget.countStep();
              harnessStep("environment_paused", "no network reaching any model provider", false, current.snap.url);
              const recovered = await waitForRecovery(page, cfg.base_url, (l) => narrate(`  ${l}`));
              // The app answering while the provider still does not means the
              // provider is unreachable from here. Retrying that forever would
              // spend the whole step budget on a problem no retry can fix.
              if (recovered && ++modelNetworkFailures >= 2) {
                status = "ENVIRONMENT_DOWN";
                observe(
                  "environment_down",
                  `the application is reachable but no model provider is: ${err.message}`,
                );
                objective.note = "model providers unreachable";
                narrate("  application is up but no model provider is reachable — finalizing as ENVIRONMENT_DOWN");
                break objectives;
              }
              if (recovered) {
                observe("outage_recovered", "network returned after model calls failed");
                oracleNotes.push(
                  "The machine lost network connectivity and it has returned. Re-verify the page state before continuing.",
                );
                continue;
              }
              status = "ENVIRONMENT_DOWN";
              observe("environment_down", `no network reaching any model provider: ${err.message}`);
              objective.note = "environment was down";
              narrate("  network did not return — finalizing as ENVIRONMENT_DOWN");
              break objectives;
            }
            status = "BUDGET_EXHAUSTED";
            observe("model_unavailable", err.message);
            objective.note = "no model provider was available";
            narrate("every model provider failed — finalizing with what we have");
            break objectives;
          }
          throw err;
        }

        oracleNotes = [];
        pendingScreenshot = undefined;
        systemNote = undefined;
        if (res.degraded) observe("model_degraded", res.degraded);

        const call = res.toolCalls[0];
        if (!call) {
          plainTextReplies++;
          history.push(`(no tool call) ${truncate(res.text.replace(/\s+/g, " "), 120)}`);
          systemNote = STALL_NUDGE;
          if (plainTextReplies >= 2) {
            loop.noteStuck(objective.id);
            narrate("  model answered without a tool call twice — counting as stuck");
          }
          continue;
        }
        plainTextReplies = 0;

        // ---- dispatch ----------------------------------------------------
        if (call.toolName === "mark_objective") {
          const input = toolInput.mark_objective.parse(call.input);
          await harvestPendingOracles(current.snap.url, fingerprint(current.snap));
          objective.status = input.status === "passed" && findingsHere > 0 ? "finding" : input.status;
          objective.note = secrets.redact(input.note);
          budget.countStep();
          harnessStep("mark_objective", `${objective.id} ${objective.status}: ${input.note}`, input.status === "passed", current.snap.url);
          if (input.status === "passed") flows.commit(objective.id, objective.description);
          else flows.discard();
          const icon = objective.status === "passed" ? "✔" : objective.status === "finding" ? "!" : "✖";
          narrate(`  ${icon} ${objective.id} ${objective.status} — ${truncate(input.note, 100)}`);
          checkpoint();
          break;
        }

        if (call.toolName === "report_finding") {
          const input = toolInput.report_finding.parse(call.input);
          const shot = await shots.capture(page, `${objective.id}-${input.title}`);
          // Hard Rule 5: a finding always ships a repro trail. When the model
          // reports before acting, its objective has no steps yet — fall back to
          // the session's most recent steps so the reader can still retrace it.
          const reproSteps = objectiveSteps.length
            ? objectiveSteps.slice(-REPRO_STEPS)
            : stepLog.recent(REPRO_STEPS);
          const finding = findings.add({
            title: input.title,
            severity: input.severity,
            oracle: "llm_judgment",
            expected: input.expected,
            actual: input.actual,
            objectiveId: objective.id,
            steps: reproSteps,
            screenshots: [lastShot, shot],
          });
          findingsHere++;
          objective.status = "finding";
          const n = budget.countStep();
          harnessStep("report_finding", `${finding.id}: ${finding.title}`, false, current.snap.url);
          objectiveSteps.push(n);
          history.push(`report_finding("${truncate(input.title, 60)}") → Recorded ${finding.id}`);
          narrate(`  [${budget.stepsUsed}/${cfg.budget.max_steps}] finding ${finding.id} (${input.severity}): ${truncate(input.title, 80)}`);
          lastShot = shot ?? lastShot;
          checkpoint();
          continue;
        }

        if (call.toolName === "look") {
          pendingScreenshot = await shots.captureBase64(page);
          const shot = await shots.capture(page, `${objective.id}-look`);
          if (shot) lastShot = shot;
          const n = budget.countStep();
          const step = stepLog.append({
            actor: "model",
            action: "look",
            args: {},
            result: { ok: Boolean(pendingScreenshot), detail: pendingScreenshot ? "Screenshot attached to your next message" : "screenshot failed" },
            url: current.snap.url,
            fingerprint: fingerprint(current.snap),
          });
          objectiveSteps.push(step.n);
          history.push("look() → screenshot attached");
          narrate(`  [${n}/${cfg.budget.max_steps}] look → screenshot`);
          // `look` changes nothing on the page, so repeated looks are the same
          // standing-still the fingerprint detector exists to catch. Without
          // this a model can spend its whole budget photographing one screen.
          if (loop.onFingerprint(fingerprint(current.snap), objective.id) === "stuck") {
            oracleNotes.push(
              "You have taken several screenshots without changing the page. Act on what you can already see, or mark this objective blocked with a note.",
            );
            narrate("  loop detector: repeated screenshots without progress");
          }
          checkpoint();
          continue;
        }

        if (!isBrowserTool(call.toolName)) {
          history.push(`${call.toolName}(…) → unknown tool`);
          systemNote = `SYSTEM: "${call.toolName}" is not a tool. Use one of: ${Object.keys(magpieTools).join(", ")}.`;
          continue;
        }

        // ---- browser action ----------------------------------------------
        const before = lastShot;
        // The element ids in this call belong to the snapshot the model saw; the
        // post-action snapshot renumbers them, so resolve names against this one.
        const acting = current;
        const label = describeCall(call.toolName, call.input, acting.snap);
        const run = (timeoutMs?: number) =>
          performBrowserAction(call.toolName, call.input, {
            page,
            cfg,
            snap: current.snap,
            locators: current.locators,
            secrets,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });

        const outcome = await slowGrace(run, cfg.run.slow_network_grace_ms, label);
        const result = outcome.result;
        if (outcome.observation) {
          observe(outcome.observation.type, outcome.observation.detail);
          narrate(`  slow page: ${outcome.observation.detail}`);
        }

        current = await snapshot(page);
        const fp = fingerprint(current.snap);
        const n = budget.countStep();
        const step = stepLog.append({
          actor: "model",
          action: call.toolName,
          args: call.input,
          result: { ok: result.ok, detail: result.detail },
          url: current.snap.url,
          fingerprint: fp,
        });
        objectiveSteps.push(step.n);
        history.push(`${label} → ${truncate(result.detail, 140)}`);
        narrate(
          `  [${n}/${cfg.budget.max_steps}] ${label} → ${result.ok ? "OK" : "FAILED"} (${shortUrl(current.snap.url)})`,
        );
        if (!result.ok) narrate(`        ${truncate(secrets.redact(result.detail), 160)}`);
        if (result.ok) {
          flows.record({
            action: call.toolName,
            ...targetOf(call.toolName, call.input, acting.snap),
            ...(result.targetNth !== undefined ? { targetNth: result.targetNth } : {}),
            // Where the flow starts matters to replay, and only the pre-action
            // snapshot knows it — `current` has already moved on.
            fromUrl: acting.snap.url,
            url: current.snap.url,
          });
        }

        // ---- environment monitor ----------------------------------------
        // Requests a click kicked off resolve after the click returns; give them
        // a beat so their evidence is attributed to the action that caused them.
        await sleep(SETTLE_BEFORE_DRAIN_MS);
        const drained = session.collectors.drain();
        const env = classifyActionResult(result, {
          originWasReachable,
          serverErrorUrls: session.collectors.serverErrorUrls(),
          isNavigation: call.toolName === "goto",
        });
        if (env.verdict === "suspect_outage") {
          narrate(`  environment check: ${env.reason}`);
          budget.countStep();
          harnessStep("environment_paused", env.reason ?? "suspected outage", false, current.snap.url, fp);
          const recovered = await waitForRecovery(page, cfg.base_url, (l) => narrate(`  ${l}`));
          session.collectors.clearServerErrors();
          session.collectors.drain();
          if (!recovered) {
            status = "ENVIRONMENT_DOWN";
            observe(
              "environment_down",
              `${env.reason}. Failed requests: ${session.collectors.allNetworkErrors.slice(-10).join("; ") || "none recorded"}`,
            );
            objective.status = "blocked";
            objective.note = "environment was down";
            narrate("  environment did not recover — finalizing as ENVIRONMENT_DOWN");
            break objectives;
          }
          // Hard Rule 6: nothing observed during an outage is an application bug.
          observe("outage_recovered", env.reason ?? "environment recovered");
          current = await snapshot(page);
          history.push("(environment outage — the site was unreachable and then recovered)");
          oracleNotes.push("The environment was briefly unreachable and has recovered. Re-verify the page state before continuing.");
          checkpoint();
          continue;
        }

        // ---- harness oracles ---------------------------------------------
        const scoped = splitByScope(drained, cfg);
        if (scoped.external.length) {
          observe("third_party_request_failed", `ignored ${scoped.external.length} failed request(s) outside the app under test: ${scoped.external.slice(0, 2).join("; ")}`);
        }
        if (!isEmpty(scoped.own)) {
          const after = await shots.capture(page, `${objective.id}-oracle`);
          for (const candidate of oracleFindingsFor(scoped.own)) {
            const before_count = findings.count;
            const finding = findings.add({
              ...candidate,
              objectiveId: objective.id,
              steps: objectiveSteps.slice(-REPRO_STEPS),
              screenshots: [before, after],
              evidence: scoped.own,
            });
            const isNew = findings.count > before_count;
            findingsHere++;
            objective.status = "finding";
            const hn = budget.countStep();
            harnessStep(`oracle:${finding.oracle}`, `${finding.id}: ${finding.title}`, false, current.snap.url, fp);
            objectiveSteps.push(hn);
            // A defect already reported does not need re-announcing every time
            // it recurs; the finding card records how often it was seen.
            if (isNew) {
              oracleNotes.push(`${finding.oracle} fired — ${finding.title}. ${truncate(finding.actual, 200)}`);
              narrate(`  ! ${finding.id} ${finding.oracle} (${finding.severity}): ${truncate(finding.title, 80)}`);
            }
          }
          if (after) lastShot = after;
        } else if (result.ok) {
          lastShot = (await shots.capture(page, `${objective.id}-${call.toolName}`)) ?? lastShot;
        }

        if (loop.onFingerprint(fp, objective.id) === "stuck") {
          oracleNotes.push(
            "You appear to be stuck: the page has not changed across several actions. Change strategy, or mark this objective blocked with a note.",
          );
          narrate("  loop detector: page unchanged across several actions");
        }
        checkpoint();
      }

      checkpoint();
    }
  } catch (err) {
    status = "CRASHED";
    const message = (err as Error).stack ?? String(err);
    observe("crash", truncate(message, 2000));
    harnessStep("crash", truncate((err as Error).message ?? String(err), 300), false);
    narrate(`session crashed: ${(err as Error).message ?? err}`);
  } finally {
    await closeBrowser(session, path.join(reportDir, "trace.zip"));
    flows.finish();
    stepLog.close();
  }

  return finish();

  function finish(): SessionResult {
    // An objective the loop left mid-flight never "passed"; say so honestly.
    for (const o of objectives) {
      if (o.status === "in-progress") {
        o.status = findings.all().some((f) => f.objectiveId === o.id) ? "finding" : "blocked";
        o.note ??= "objective did not reach an explicit outcome";
      }
    }
    if (status === "COMPLETED") {
      const hit = budget.hit();
      if (hit) status = "BUDGET_EXHAUSTED";
    }
    const raw: SessionResult = {
      status,
      startedAt: isoNow(startedAt),
      endedAt: isoNow(),
      charter: opts.charter,
      objectives,
      findings: findings.all(),
      observations,
      usage: usage.snapshot(),
      stepCount: stepLog.count,
      reportDir,
    };
    // Memory is written before the result is frozen so a failed ingest can still
    // append its observation — `observations` is the same array `raw` holds.
    ingestIntoMemory({
      dir: opts.dir,
      result: raw,
      reportDir,
      secrets,
      snapshots: pageSnapshots,
      narrate,
      observe,
    });
    // Redact ONCE, then write and return the same object. Returning the raw one
    // leaked credentials into the terminal summary and the HTML report even
    // though session.json was clean — objective descriptions are written by the
    // planner, which happily quotes whatever it read off the page.
    const result: SessionResult = secrets.redactDeep(raw);
    fs.writeFileSync(
      path.join(reportDir, "session.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    checkpoint();
    return result;
  }
}

/**
 * Requests to somebody else's server are not evidence about the app under test.
 * saucedemo's analytics vendor 401s on every page load; reporting that as a
 * defect in the shop makes every report noise. Split them out so they can be
 * recorded as an observation instead.
 */
function splitByScope(drained: Drained, cfg: MagpieConfig): { own: Drained; external: string[] } {
  const urlOf = (entry: string) => /https?:\/\/\S+/.exec(entry)?.[0];
  const external: string[] = [];
  const own = drained.network.filter((entry) => {
    const url = urlOf(entry);
    if (!url) return true; // no URL to judge: keep it
    if (isUrlInScope(url, cfg)) return true;
    external.push(entry);
    return false;
  });
  return { own: { ...drained, network: own }, external };
}

/** Human label for narration and history lines, e.g. `click "Add to cart"`. */
function describeCall(name: string, input: unknown, snap?: Snapshot): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const el = typeof i.id === "string" ? snap?.elements.find((e) => e.id === i.id) : undefined;
  const who = el?.name ? `"${truncate(el.name, 40)}"` : String(i.id ?? "");
  switch (name) {
    case "goto":
      return `goto ${i.url}`;
    case "click":
      return `click ${who}`;
    case "fill":
      return `fill ${who} "${truncate(String(i.text ?? ""), 40)}"`;
    case "select":
      return `select "${i.value}" in ${who}`;
    case "press":
      return `press ${i.key}`;
    case "wait":
      return `wait ${i.ms}ms`;
    default:
      return name;
  }
}

async function performBrowserAction(
  name: string,
  input: unknown,
  ctx: actions.ActionContext,
): Promise<actions.ActionResult> {
  switch (name) {
    case "goto":
      return actions.goto(ctx, toolInput.goto.parse(input).url);
    case "click":
      return actions.click(ctx, toolInput.click.parse(input).id);
    case "fill": {
      const i = toolInput.fill.parse(input);
      return actions.fill(ctx, i.id, i.text);
    }
    case "select": {
      const i = toolInput.select.parse(input);
      return actions.select(ctx, i.id, i.value);
    }
    case "press":
      return actions.press(ctx, toolInput.press.parse(input).key);
    case "wait":
      return actions.wait(ctx, toolInput.wait.parse(input).ms);
    default:
      return { ok: false, detail: `unknown tool ${name}`, newUrl: ctx.page.url(), refused: true };
  }
}

/** Phase-2 flows record role+name targets, never snapshot ids. */
function targetOf(
  name: string,
  input: unknown,
  snap: Snapshot,
): { target?: { role: string; name: string }; value?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const el = typeof i.id === "string" ? snap.elements.find((e) => e.id === i.id) : undefined;
  const out: { target?: { role: string; name: string }; value?: string } = {};
  if (el) out.target = { role: el.role, name: el.name };
  if (name === "fill" && typeof i.text === "string") out.value = i.text;
  if (name === "select" && typeof i.value === "string") out.value = i.value;
  if (name === "goto" && typeof i.url === "string") out.value = i.url;
  if (name === "press" && typeof i.key === "string") out.value = i.key;
  return out;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export type { Finding, Locator };
