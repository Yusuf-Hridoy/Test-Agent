import fs from "node:fs";
import path from "node:path";
import {
  PROVIDERS,
  type MagpieConfig,
  type SessionResult,
  type Snapshot,
  type StepRecord,
} from "../types.js";
import { isUrlInScope } from "../browser/guard.js";
import { REDACTED, type SecretStore } from "../model/redact.js";
import type { DraftFlow, FlowAction } from "../evidence/flows.js";
import { isoNow, slug, truncate } from "../util.js";
import type { MemoryDb } from "./db.js";
import { normalizePageKey } from "./pagekey.js";
import { isReplayableAction, SECRET_PLACEHOLDER, type FlowStepRow } from "./types.js";
import { fingerprintOf } from "./fingerprint.js";

/** How many collision suffixes to try before giving up on a slug. */
const MAX_SLUG_ATTEMPTS = 50;

export interface IngestOptions {
  /** Live store from the session; disk-only ingests rely on already-redacted text. */
  secrets?: SecretStore;
  /** page_key → the last snapshot taken on that page, for titles and elements. */
  snapshots?: Map<string, Snapshot>;
  /**
   * Needed to judge whether a linked page belongs to the app under test.
   * Without it the frontier is left alone: guessing scope would put somebody
   * else's website on Magpie's crawl queue (Hard Rule 4).
   */
  cfg?: MagpieConfig;
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
  /** Per-finding verdict from the cross-session dedup (§1.5). */
  verdicts: FindingVerdict[];
  /** Findings this ingest raised on its own, e.g. the performance oracle. */
  raised: FindingVerdict[];
  /** What this session changed about coverage (Phase 4 §1.4). */
  coverage: SessionCoverage;
}

/** Before-and-after, so a report can say what a session actually added. */
export interface SessionCoverage {
  pagesBefore: number;
  pagesAfter: number;
  frontierBefore: number;
  frontierAfter: number;
  elementsSeen: number;
  elementsInteracted: number;
  flowsDrafted: number;
}

const EMPTY_COVERAGE: SessionCoverage = {
  pagesBefore: 0,
  pagesAfter: 0,
  frontierBefore: 0,
  frontierAfter: 0,
  elementsSeen: 0,
  elementsInteracted: 0,
  flowsDrafted: 0,
};

export interface FindingVerdict {
  fid: string;
  title: string;
  oracle: string;
  pageKey: string | null;
  fingerprint: string;
  status: "NEW" | "KNOWN";
  /** How many sessions have now reported this same defect. */
  seenCount: number;
  firstSeenAt?: string;
}

/** How many consecutive slow visits to one page before it is worth reporting. */
export const SLOW_PAGE_THRESHOLD = 3;

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
      verdicts: [],
      raised: [],
      coverage: EMPTY_COVERAGE,
    };
  }

  const steps = readSteps(reportDir);
  const drafts = readDrafts(reportDir);
  const llmRequests = PROVIDERS.reduce((n, p) => n + (result.usage?.[p]?.requests ?? 0), 0);

  const countOf = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const before = {
    pages: countOf("SELECT COUNT(*) AS n FROM pages"),
    frontier: countOf("SELECT COUNT(*) AS n FROM frontier WHERE visited_at IS NULL"),
  };

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
    const verdicts: FindingVerdict[] = [];
    for (const finding of result.findings ?? []) {
      // The step that fired the oracle is the last of the repro trail.
      const lastStep = [...finding.steps].sort((a, b) => a - b).at(-1);
      const pageKey = lastStep !== undefined ? (keyForStep.get(lastStep) ?? null) : null;
      verdicts.push(
        recordFinding(db, {
          sessionId,
          fid: finding.id,
          title: clean(finding.title),
          severity: finding.severity,
          oracle: finding.oracle,
          confidence: finding.confidence,
          pageKey,
          now,
        }),
      );
      findings++;
    }

    // Observations are memory too: the performance oracle is only possible
    // because "this page was slow" survives the session that noticed it.
    recordObservations(db, sessionId, result.observations ?? [], visits, now, clean);
    const raised = raisePerformanceFindings(db, sessionId, visits, now);

    recordCoverage(db, {
      visits,
      steps,
      snapshots: opts.snapshots,
      ...(opts.cfg ? { cfg: opts.cfg } : {}),
      now,
    });

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
      verdicts,
      raised,
      coverage: {
        pagesBefore: before.pages,
        pagesAfter: countOf("SELECT COUNT(*) AS n FROM pages"),
        frontierBefore: before.frontier,
        frontierAfter: countOf("SELECT COUNT(*) AS n FROM frontier WHERE visited_at IS NULL"),
        elementsSeen: countOf("SELECT COUNT(*) AS n FROM element_seen"),
        elementsInteracted: countOf("SELECT COUNT(*) AS n FROM element_seen WHERE interactions > 0"),
        flowsDrafted: flowsCreated.length,
      },
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

// ---------------------------------------------------------------------------
// Findings across sessions, and the observations the oracles read
// ---------------------------------------------------------------------------

export interface RecordFindingInput {
  sessionId: number;
  fid: string;
  title: string;
  severity: string;
  oracle: string;
  confidence: string;
  pageKey: string | null;
  now: string;
}

/**
 * File one sighting of a defect and say whether the project has seen it before.
 *
 * Every sighting gets a row — the count is the history. What changes is how a
 * report presents it: a nightly suite must lead with what broke since last
 * night, not with the same three bugs every morning (§1.5).
 */
export function recordFinding(db: MemoryDb, input: RecordFindingInput): FindingVerdict {
  const fingerprint = fingerprintOf(input.title, input.pageKey, input.oracle);
  const prior = db
    .prepare(
      `SELECT f.id, f.first_seen_session, s.started_at
       FROM findings f LEFT JOIN sessions s ON s.id = f.first_seen_session
       WHERE f.fingerprint = ? ORDER BY f.id LIMIT 1`,
    )
    .get(fingerprint) as { id: number; first_seen_session: number | null; started_at: string | null } | undefined;

  const firstSeenSession = prior?.first_seen_session ?? input.sessionId;
  db.prepare(
    `INSERT INTO findings (session_id, fid, title, severity, oracle, confidence, page_key,
                           created_at, fingerprint, first_seen_session)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.sessionId,
    input.fid,
    input.title,
    input.severity,
    input.oracle,
    input.confidence,
    input.pageKey,
    input.now,
    fingerprint,
    firstSeenSession,
  );

  const seenCount = (
    db.prepare("SELECT COUNT(*) AS n FROM findings WHERE fingerprint = ?").get(fingerprint) as {
      n: number;
    }
  ).n;

  return {
    fid: input.fid,
    title: input.title,
    oracle: input.oracle,
    pageKey: input.pageKey,
    fingerprint,
    status: prior ? "KNOWN" : "NEW",
    seenCount,
    ...(prior?.started_at ? { firstSeenAt: prior.started_at } : { firstSeenAt: input.now }),
  };
}

/**
 * Persist this session's observations, plus one `page_visit` marker per page.
 *
 * The markers are what make "three CONSECUTIVE sessions that visited it"
 * answerable: without them a page that was slow twice and then not visited for
 * a month would look like an unbroken streak.
 */
function recordObservations(
  db: MemoryDb,
  sessionId: number,
  observations: { type: string; detail: string; pageKey?: string }[],
  visits: Visit[],
  now: string,
  clean: (t: string) => string,
): void {
  const insert = db.prepare(
    "INSERT INTO observations (session_id, type, page_key, detail, created_at) VALUES (?,?,?,?,?)",
  );
  for (const key of new Set(visits.map((v) => v.key))) {
    insert.run(sessionId, "page_visit", key, null, now);
  }
  for (const o of observations) {
    insert.run(sessionId, o.type, o.pageKey ?? null, clean(o.detail ?? ""), now);
  }
}

/**
 * The performance oracle: a page that needed extra time on its last three
 * visits, across three different sessions, is worth one low-confidence finding.
 * One slow night is weather; three in a row is a pattern.
 */
function raisePerformanceFindings(
  db: MemoryDb,
  sessionId: number,
  visits: Visit[],
  now: string,
): FindingVerdict[] {
  const raised: FindingVerdict[] = [];
  for (const key of new Set(visits.map((v) => v.key))) {
    const recent = db
      .prepare(
        `SELECT session_id, MAX(CASE WHEN type = 'slow_page' THEN 1 ELSE 0 END) AS slow
         FROM observations
         WHERE page_key = ? AND type IN ('page_visit', 'slow_page')
         GROUP BY session_id ORDER BY session_id DESC LIMIT ?`,
      )
      .all(key, SLOW_PAGE_THRESHOLD) as { session_id: number; slow: number }[];
    if (recent.length < SLOW_PAGE_THRESHOLD) continue;
    if (!recent.every((r) => r.slow === 1)) continue;

    raised.push(
      recordFinding(db, {
        sessionId,
        fid: `P-${key.slice(-12)}`,
        title: `Slow page: ${key}`,
        severity: "low",
        oracle: "performance",
        confidence: "low",
        pageKey: key,
        now,
      }),
    );
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Regression suites
// ---------------------------------------------------------------------------

export interface SuiteIngestInput {
  reportDir: string;
  startedAt: string;
  endedAt: string;
  status: string;
  charter: string;
  llmRequests: number;
  findings: {
    fid: string;
    title: string;
    severity: string;
    oracle: string;
    confidence: string;
    pageKey: string | null;
  }[];
}

/**
 * A regression suite is a session too.
 *
 * It has to be: findings reference a session, and a nightly suite's findings
 * are exactly the ones that must be counted across runs. Idempotent by report
 * directory, like every other ingest.
 */
export function ingestSuite(
  db: MemoryDb,
  input: SuiteIngestInput,
): { sessionId: number; verdicts: FindingVerdict[]; alreadyIngested: boolean } {
  const existing = db
    .prepare("SELECT id FROM sessions WHERE report_dir = ?")
    .get(input.reportDir) as { id: number } | undefined;
  if (existing) return { sessionId: existing.id, verdicts: [], alreadyIngested: true };

  const now = isoNow();
  return db.transaction(() => {
    const sessionId = Number(
      db
        .prepare(
          "INSERT INTO sessions (started_at, ended_at, status, charter, report_dir, llm_requests) VALUES (?,?,?,?,?,?)",
        )
        .run(
          input.startedAt,
          input.endedAt,
          input.status,
          input.charter,
          input.reportDir,
          input.llmRequests,
        ).lastInsertRowid,
    );
    const verdicts = input.findings.map((f) =>
      recordFinding(db, {
        sessionId,
        fid: f.fid,
        title: f.title,
        severity: f.severity,
        oracle: f.oracle,
        confidence: f.confidence,
        pageKey: f.pageKey,
        now,
      }),
    );
    return { sessionId, verdicts, alreadyIngested: false };
  })();
}


// ---------------------------------------------------------------------------
// Frontier and element coverage (Phase 4 §1.2)
// ---------------------------------------------------------------------------

interface CoverageInput {
  visits: Visit[];
  steps: StepRecord[];
  snapshots?: Map<string, Snapshot>;
  cfg?: MagpieConfig;
  now: string;
}

/**
 * Record what this session saw and what it actually touched.
 *
 * Runs for every session, not just explore: a charter run discovers pages and
 * leaves elements untouched exactly like an exploratory one, and coverage that
 * only counted explore runs would understate what is already tested.
 */
export function recordCoverage(db: MemoryDb, input: CoverageInput): void {
  const seen = db.prepare(
    `INSERT INTO element_seen (page_key, role, name, first_seen, last_seen, interactions)
     VALUES (?,?,?,?,?,0)
     ON CONFLICT(page_key, role, name) DO UPDATE SET last_seen = excluded.last_seen`,
  );
  const touch = db.prepare(
    `INSERT INTO element_seen (page_key, role, name, first_seen, last_seen, interactions)
     VALUES (?,?,?,?,?,1)
     ON CONFLICT(page_key, role, name) DO UPDATE SET
       last_seen = excluded.last_seen,
       interactions = element_seen.interactions + 1`,
  );

  for (const [pageKey, snap] of input.snapshots ?? []) {
    for (const el of snap.elements) {
      // A nameless element cannot be a coverage target — nothing could ever
      // say "this one was exercised" about it.
      if (!el.name?.trim()) continue;
      seen.run(pageKey, el.role, el.name, input.now, input.now);
    }
  }

  for (const step of input.steps) {
    if (!step.target?.name?.trim()) continue;
    const pageKey = normalizePageKey(step.url);
    if (!pageKey) continue;
    touch.run(pageKey, step.target.role, step.target.name, input.now, input.now);
  }

  recordFrontier(db, input);
}

/**
 * Links to pages nobody has opened yet. Scope is applied here as strictly as it
 * is in the browser: a link to somebody else's site is not a page of the
 * application, and must never end up on the explorer's queue.
 */
function recordFrontier(db: MemoryDb, input: CoverageInput): void {
  const visitedKeys = new Set(input.visits.map((v) => v.key));
  const known = new Set(
    (db.prepare("SELECT page_key FROM pages").all() as { page_key: string }[]).map(
      (r) => r.page_key,
    ),
  );

  if (input.cfg && input.snapshots) {
    const add = db.prepare(
      `INSERT INTO frontier (page_key, sample_url, first_seen, seen_on_page)
       VALUES (?,?,?,?)
       ON CONFLICT(page_key) DO NOTHING`,
    );
    for (const [pageKey, snap] of input.snapshots) {
      for (const el of snap.elements) {
        if (!el.href) continue;
        if (!isUrlInScope(el.href, input.cfg)) continue;
        const key = normalizePageKey(el.href);
        if (!key || key === pageKey || known.has(key)) continue;
        add.run(key, el.href, input.now, pageKey);
      }
    }
  }

  // A page that made it into `pages` is no longer frontier, however it was
  // reached — by following the link, by a charter, or by a direct goto.
  const visit = db.prepare(
    "UPDATE frontier SET visited_at = ? WHERE page_key = ? AND visited_at IS NULL",
  );
  for (const key of visitedKeys) visit.run(input.now, key);
}
