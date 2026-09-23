import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, type SessionResult, type Snapshot, type StepRecord } from "../types.js";
import { REDACTED, type SecretStore } from "../model/redact.js";
import type { DraftFlow, FlowAction } from "../evidence/flows.js";
import { isoNow, slug, truncate } from "../util.js";
import type { MemoryDb } from "./db.js";
import { normalizePageKey } from "./pagekey.js";
import { isReplayableAction, SECRET_PLACEHOLDER, type FlowStepRow } from "./types.js";

/** How many collision suffixes to try before giving up on a slug. */
const MAX_SLUG_ATTEMPTS = 50;

export interface IngestOptions {
  /** Live store from the session; disk-only ingests rely on already-redacted text. */
  secrets?: SecretStore;
  /** page_key → the last snapshot taken on that page, for titles and elements. */
  snapshots?: Map<string, Snapshot>;
}

export interface IngestResult {
  sessionId: number;
  /** True when this report directory was ingested before — nothing was written. */
  alreadyIngested: boolean;
  pages: number;
  transitions: number;
  findings: number;
  /** Slugs of flows created by this ingest (existing identical flows are reused). */
  flowsCreated: string[];
  flowsSkipped: string[];
}

/**
 * Fold one finished session into the project's memory.
 *
 * Idempotent by report directory: a run is ingested exactly once, so re-running
 * ingestion over the same reports folder cannot inflate visit counts or file the
 * same flow twice.
 */
export function ingestSession(
  db: MemoryDb,
  result: SessionResult,
  reportDir: string,
  opts: IngestOptions = {},
): IngestResult {
  const clean = (text: string): string => opts.secrets?.redact(text) ?? text;
  const now = isoNow();

  const existing = db
    .prepare("SELECT id FROM sessions WHERE report_dir = ?")
    .get(reportDir) as { id: number } | undefined;
  if (existing) {
    return {
      sessionId: existing.id,
      alreadyIngested: true,
      pages: 0,
      transitions: 0,
      findings: 0,
      flowsCreated: [],
      flowsSkipped: [],
    };
  }

  const steps = readSteps(reportDir);
  const drafts = readDrafts(reportDir);
  const llmRequests = PROVIDERS.reduce((n, p) => n + (result.usage?.[p]?.requests ?? 0), 0);

  return db.transaction((): IngestResult => {
    const sessionId = Number(
      db
        .prepare(
          "INSERT INTO sessions (started_at, ended_at, status, charter, report_dir, llm_requests) VALUES (?,?,?,?,?,?)",
        )
        .run(
          result.startedAt,
          result.endedAt,
          result.status,
          clean(result.charter ?? ""),
          reportDir,
          llmRequests,
        ).lastInsertRowid,
    );

    const visits = visitsFrom(steps);
    const pageIds = new Map<string, number>();
    for (const visit of visits) {
      pageIds.set(visit.key, upsertPage(db, visit, opts, clean));
    }

    let transitions = 0;
    for (let i = 1; i < visits.length; i++) {
      const from = pageIds.get(visits[i - 1]!.key);
      const to = pageIds.get(visits[i]!.key);
      if (from === undefined || to === undefined || from === to) continue;
      db.prepare(
        `INSERT INTO transitions (from_page, to_page, action, count) VALUES (?,?,?,1)
         ON CONFLICT(from_page, to_page, action) DO UPDATE SET count = count + 1`,
      ).run(from, to, clean(visits[i]!.label));
      transitions++;
    }

    const keyForStep = new Map<number, string>();
    for (const step of steps) {
      const key = normalizePageKey(step.url);
      if (key) keyForStep.set(step.n, key);
    }
    let findings = 0;
    for (const finding of result.findings ?? []) {
      // The step that fired the oracle is the last of the repro trail.
      const lastStep = [...finding.steps].sort((a, b) => a - b).at(-1);
      const pageKey = lastStep !== undefined ? (keyForStep.get(lastStep) ?? null) : null;
      db.prepare(
        "INSERT INTO findings (session_id, fid, title, severity, oracle, confidence, page_key, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        sessionId,
        finding.id,
        clean(finding.title),
        finding.severity,
        finding.oracle,
        finding.confidence,
        pageKey,
        now,
      );
      findings++;
    }

    const flowsCreated: string[] = [];
    const flowsSkipped: string[] = [];
    for (const draft of drafts) {
      const outcome = storeFlow(db, draft, {
        sessionId,
        charter: clean(result.charter ?? ""),
        now,
        clean,
      });
      if (outcome.created) flowsCreated.push(outcome.slug);
      else flowsSkipped.push(outcome.slug);
    }

    return {
      sessionId,
      alreadyIngested: false,
      pages: pageIds.size,
      transitions,
      findings,
      flowsCreated,
      flowsSkipped,
    };
  })();
}

// ---------------------------------------------------------------------------
// Pages and transitions
// ---------------------------------------------------------------------------

interface Visit {
  key: string;
  url: string;
  at: string;
  /** What moved the browser here, e.g. `click "Add to cart"`. */
  label: string;
}

/**
 * Collapse the step log into page visits. One row per *arrival*, not per step:
 * a page the agent poked at twenty times is not twenty times more interesting
 * than one it saw once, and visit_count is what the planner ranks pages by.
 */
export function visitsFrom(steps: StepRecord[]): Visit[] {
  const visits: Visit[] = [];
  for (const step of steps) {
    const key = normalizePageKey(step.url);
    if (!key) continue;
    if (visits.at(-1)?.key === key) continue;
    visits.push({ key, url: step.url, at: step.t, label: labelOf(step) });
  }
  return visits;
}

/**
 * A readable action label from a step record. The element's name is not in the
 * arguments (those carry snapshot ids, which die with the session), but the
 * result detail quotes it: `Clicked "Add to cart".`
 */
export function labelOf(step: StepRecord): string {
  if (step.actor === "harness") return step.action;
  if (step.action === "goto") return "goto";
  const quoted = /"([^"]{1,60})"/.exec(step.result.detail ?? "")?.[1];
  return quoted ? `${step.action} "${quoted}"` : step.action;
}

function upsertPage(
  db: MemoryDb,
  visit: Visit,
  opts: IngestOptions,
  clean: (t: string) => string,
): number {
  const snap = opts.snapshots?.get(visit.key);
  const title = snap?.title ? clean(snap.title) : null;
  const elements = snap?.elements?.length
    ? JSON.stringify(opts.secrets ? opts.secrets.redactDeep(snap.elements) : snap.elements)
    : null;

  db.prepare(
    `INSERT INTO pages (page_key, sample_url, title, first_seen, last_seen, visit_count, elements_json)
     VALUES (?,?,?,?,?,1,?)
     ON CONFLICT(page_key) DO UPDATE SET
       last_seen = excluded.last_seen,
       visit_count = visit_count + 1,
       sample_url = excluded.sample_url,
       title = COALESCE(excluded.title, pages.title),
       elements_json = COALESCE(excluded.elements_json, pages.elements_json)`,
  ).run(visit.key, clean(visit.url), title, visit.at, visit.at, elements);

  const row = db.prepare("SELECT id FROM pages WHERE page_key = ?").get(visit.key) as { id: number };
  return row.id;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

type NewStep = Omit<FlowStepRow, "flow_id">;

/** Draft actions → replayable steps. Non-replayable tools (`wait`) are dropped. */
export function stepsForFlow(actions: FlowAction[], clean: (t: string) => string): NewStep[] {
  return actions
    .filter((a) => isReplayableAction(a.action))
    .map((a, i) => ({
      seq: i + 1,
      action: a.action,
      target_role: a.target?.role ?? null,
      target_name: a.target ? clean(a.target.name) : null,
      value: valueFor(a, clean),
      url_after: a.url ? normalizePageKey(a.url) : null,
      target_nth: a.targetNth ?? null,
    }));
}

/**
 * Hard Rule 2 extended: a secret never reaches the database. What was redacted
 * on the way to disk is stored as a placeholder that replay refuses to guess at.
 */
function valueFor(action: FlowAction, clean: (t: string) => string): string | null {
  if (action.value === undefined) return null;
  const value = clean(action.value);
  return value.includes(REDACTED) ? SECRET_PLACEHOLDER : value;
}

/**
 * Two flows are "the same flow" when their replayable steps are identical.
 *
 * `target_nth` is deliberately NOT part of the identity: a flow re-recorded
 * after Phase 3 is the same flow, now with a position recorded. Including it
 * would fork every legacy flow into a "-2" twin on the next run.
 */
export function signatureOf(steps: NewStep[] | FlowStepRow[]): string {
  return JSON.stringify(
    steps.map((s) => [s.action, s.target_role, s.target_name, s.value, s.url_after]),
  );
}

/**
 * A fresher recording of a known flow can teach it where its targets are.
 * Only fills gaps — a position already recorded is never overwritten by ingest,
 * because the stored one may have been repaired by healing.
 */
function adoptPositions(db: MemoryDb, flowId: number, steps: NewStep[]): number {
  let taught = 0;
  const update = db.prepare(
    "UPDATE flow_steps SET target_nth = ? WHERE flow_id = ? AND seq = ? AND target_nth IS NULL",
  );
  for (const s of steps) {
    if (s.target_nth === null) continue;
    taught += update.run(s.target_nth, flowId, s.seq).changes;
  }
  return taught;
}

function storeFlow(
  db: MemoryDb,
  draft: DraftFlow,
  ctx: { sessionId: number; charter: string; now: string; clean: (t: string) => string },
): { slug: string; created: boolean } {
  const steps = stepsForFlow(draft.actions, ctx.clean);
  const description = ctx.clean(draft.description);
  const base = slug(description);
  if (!steps.length) return { slug: base, created: false };

  const signature = signatureOf(steps);
  const first = draft.actions.find((a) => isReplayableAction(a.action));
  const startPageKey = normalizePageKey(first?.fromUrl ?? first?.url ?? "");

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const existing = db.prepare("SELECT id FROM flows WHERE slug = ?").get(candidate) as
      | { id: number }
      | undefined;

    if (!existing) {
      const flowId = Number(
        db
          .prepare(
            `INSERT INTO flows (slug, name, description, status, origin_session, origin_objective,
                                start_page_key, created_at, updated_at)
             VALUES (?,?,?,'draft',?,?,?,?,?)`,
          )
          .run(
            candidate,
            truncate(description, 80),
            ctx.charter || null,
            ctx.sessionId,
            draft.objectiveId,
            startPageKey,
            ctx.now,
            ctx.now,
          ).lastInsertRowid,
      );
      const insert = db.prepare(
        `INSERT INTO flow_steps (flow_id, seq, action, target_role, target_name, value, url_after, target_nth)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const s of steps) {
        insert.run(
          flowId,
          s.seq,
          s.action,
          s.target_role,
          s.target_name,
          s.value,
          s.url_after,
          s.target_nth,
        );
      }
      return { slug: candidate, created: true };
    }

    // Same slug, same steps → the flow is already remembered. Re-recording it
    // under a -2 suffix would fill the list with duplicates of one flow.
    const existingSteps = db
      .prepare("SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY seq")
      .all(existing.id) as FlowStepRow[];
    if (signatureOf(existingSteps) === signature) {
      adoptPositions(db, existing.id, steps);
      return { slug: candidate, created: false };
    }
  }
  return { slug: base, created: false };
}

// ---------------------------------------------------------------------------
// Report-folder readers
// ---------------------------------------------------------------------------

/** A torn last line after a hard crash is not fatal — read what parses. */
export function readSteps(reportDir: string): StepRecord[] {
  const file = path.join(reportDir, "steps.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StepRecord];
      } catch {
        return [];
      }
    });
}

export function readDrafts(reportDir: string): DraftFlow[] {
  const file = path.join(reportDir, "flows.draft.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as DraftFlow[]) : [];
  } catch {
    return [];
  }
}
