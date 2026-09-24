import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { projectPaths } from "../config/load.js";
import type {
  ElementSeenRow,
  FindingRow,
  FlowRow,
  FrontierRow,
  FlowStatus,
  FlowStepRow,
  PageRow,
  SessionRow,
  StoredFlow,
} from "./types.js";

export type MemoryDb = Database.Database;

export const DB_FILENAME = "magpie.db";
export const SCHEMA_VERSION = 3;

/**
 * Migrations are numbered SQL strings applied in order at open. Never edit one
 * that has shipped — add the next number instead; existing project databases
 * only ever run the migrations they have not seen.
 */
export const MIGRATIONS: string[] = [
  // 001 — PHASE-2-BRIEF §1.2
  `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL, ended_at TEXT,
    status TEXT NOT NULL, charter TEXT,
    report_dir TEXT NOT NULL,
    llm_requests INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    page_key TEXT NOT NULL UNIQUE,
    sample_url TEXT NOT NULL,
    title TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 1,
    elements_json TEXT
  );
  CREATE TABLE transitions (
    from_page INTEGER NOT NULL REFERENCES pages(id),
    to_page   INTEGER NOT NULL REFERENCES pages(id),
    action    TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (from_page, to_page, action)
  );
  CREATE TABLE flows (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    origin_session INTEGER REFERENCES sessions(id),
    origin_objective TEXT,
    start_page_key TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    last_replay_at TEXT, last_replay_result TEXT
  );
  CREATE TABLE flow_steps (
    flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_role TEXT, target_name TEXT,
    value TEXT,
    url_after TEXT,
    PRIMARY KEY (flow_id, seq)
  );
  CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    fid TEXT NOT NULL,
    title TEXT NOT NULL, severity TEXT NOT NULL,
    oracle TEXT NOT NULL, confidence TEXT NOT NULL,
    page_key TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_findings_page ON findings(page_key);
  `,
  // 002 — PHASE-3-BRIEF §1.1. The brief's trailing `UPDATE schema_version` is
  // omitted on purpose: migrate() owns the version, and two writers of the same
  // number is one too many.
  `
  ALTER TABLE flow_steps ADD COLUMN target_nth INTEGER;
  ALTER TABLE findings  ADD COLUMN fingerprint TEXT;
  ALTER TABLE findings  ADD COLUMN first_seen_session INTEGER;
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL, page_key TEXT, detail TEXT, created_at TEXT NOT NULL);
  CREATE INDEX idx_obs_page ON observations(page_key, type);
  CREATE TABLE heal_events (
    id INTEGER PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, old_target TEXT NOT NULL, new_target TEXT NOT NULL,
    model_note TEXT, session_ref TEXT, created_at TEXT NOT NULL);
  CREATE INDEX idx_findings_fingerprint ON findings(fingerprint);
  `,
  // 003 — PHASE-4-BRIEF §1.2. What the app map is missing: pages Magpie has
  // been told about but never opened, and which elements it has actually used.
  `
  CREATE TABLE frontier (
    page_key TEXT PRIMARY KEY, sample_url TEXT NOT NULL,
    first_seen TEXT NOT NULL, seen_on_page TEXT,
    visited_at TEXT
  );
  CREATE TABLE element_seen (
    page_key TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    interactions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_key, role, name)
  );
  CREATE INDEX idx_frontier_open ON frontier(visited_at);
  `,
];

export function memoryDbPath(dir: string): string {
  return path.join(projectPaths(dir).memoryDir, DB_FILENAME);
}

/**
 * Open (creating if needed) the project's memory database and bring its schema
 * up to date. Synchronous throughout — better-sqlite3 has no async surface, and
 * the harness only touches memory at session boundaries.
 */
export function openMemoryDb(dir: string): MemoryDb {
  const file = memoryDbPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Open an in-memory database with the current schema — for tests. */
export function openEphemeralDb(): MemoryDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: MemoryDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get() as { v: number } | undefined;
  let current = row?.v ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();

  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET v = ?").run(i + 1);
    })();
    current = i + 1;
  }
}

export function schemaVersion(db: MemoryDb): number {
  const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get() as { v: number } | undefined;
  return row?.v ?? 0;
}

export function closeDb(db: MemoryDb | undefined): void {
  try {
    db?.close();
  } catch {
    // already closed
  }
}

// ---------------------------------------------------------------------------
// Shared typed queries. These live here rather than in a separate store module
// because ingest, replay, the CLI and the planner context all need the same
// handful of reads, and a second file would only forward to this one.
// ---------------------------------------------------------------------------

export interface MemoryCounts {
  sessions: number;
  pages: number;
  transitions: number;
  flows: number;
  findings: number;
}

export function counts(db: MemoryDb): MemoryCounts {
  const one = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    sessions: one("sessions"),
    pages: one("pages"),
    transitions: one("transitions"),
    flows: one("flows"),
    findings: one("findings"),
  };
}

/** True when the database holds anything worth telling the planner about. */
export function hasMemory(db: MemoryDb): boolean {
  const c = counts(db);
  return c.pages > 0 || c.flows > 0;
}

export function topPages(db: MemoryDb, limit: number): PageRow[] {
  return db
    .prepare("SELECT * FROM pages ORDER BY visit_count DESC, last_seen DESC LIMIT ?")
    .all(limit) as PageRow[];
}

export function recentSessions(db: MemoryDb, limit: number): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT ?")
    .all(limit) as SessionRow[];
}

export function listFlows(db: MemoryDb, status?: FlowStatus): FlowRow[] {
  return status
    ? (db.prepare("SELECT * FROM flows WHERE status = ? ORDER BY slug").all(status) as FlowRow[])
    : (db.prepare("SELECT * FROM flows ORDER BY slug").all() as FlowRow[]);
}

export function flowBySlug(db: MemoryDb, slug: string): StoredFlow | undefined {
  const flow = db.prepare("SELECT * FROM flows WHERE slug = ?").get(slug) as FlowRow | undefined;
  if (!flow) return undefined;
  return { ...flow, steps: flowSteps(db, flow.id) };
}

export function flowSteps(db: MemoryDb, flowId: number): FlowStepRow[] {
  return db
    .prepare("SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY seq")
    .all(flowId) as FlowStepRow[];
}

export function pageByKey(db: MemoryDb, key: string): PageRow | undefined {
  return db.prepare("SELECT * FROM pages WHERE page_key = ?").get(key) as PageRow | undefined;
}

/** High-severity findings, newest first — the planner's "known sore spots". */
export function highSeverityFindings(db: MemoryDb, limit: number): FindingRow[] {
  return db
    .prepare("SELECT * FROM findings WHERE severity = 'high' ORDER BY id DESC LIMIT ?")
    .all(limit) as FindingRow[];
}

export function renameFlow(db: MemoryDb, slug: string, name: string, now: string): boolean {
  const info = db
    .prepare("UPDATE flows SET name = ?, updated_at = ? WHERE slug = ?")
    .run(name, now, slug);
  return info.changes > 0;
}

export function setFlowStatus(
  db: MemoryDb,
  slug: string,
  status: FlowStatus,
  now: string,
): boolean {
  const info = db
    .prepare("UPDATE flows SET status = ?, updated_at = ? WHERE slug = ?")
    .run(status, now, slug);
  return info.changes > 0;
}

export function deleteFlow(db: MemoryDb, slug: string): boolean {
  // flow_steps cascade via the FK, which is why foreign_keys is pragma'd ON.
  const info = db.prepare("DELETE FROM flows WHERE slug = ?").run(slug);
  return info.changes > 0;
}

/** Record a replay outcome against the flow row (§1.4). */
export function recordReplay(
  db: MemoryDb,
  flowId: number,
  result: string,
  status: FlowStatus,
  now: string,
): void {
  db.prepare(
    "UPDATE flows SET last_replay_at = ?, last_replay_result = ?, status = ?, updated_at = ? WHERE id = ?",
  ).run(now, result, status, now, flowId);
}

/**
 * The session whose run covers this instant, if any.
 *
 * Lets a regression finding cite "last passed during suite #7" without storing
 * a session id on every replay: a replay that happened inside a suite's window
 * belongs to that suite, and a standalone `flows replay` belongs to none.
 */
export function sessionCoveringTime(db: MemoryDb, iso: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(iso, iso) as SessionRow | undefined;
}

/** The first sighting of a defect, by fingerprint — undefined if never seen. */
export function firstFindingByFingerprint(
  db: MemoryDb,
  fingerprint: string,
): (FindingRow & { session_started_at: string | null }) | undefined {
  return db
    .prepare(
      `SELECT f.*, s.started_at AS session_started_at
       FROM findings f LEFT JOIN sessions s ON s.id = f.session_id
       WHERE f.fingerprint = ? ORDER BY f.id LIMIT 1`,
    )
    .get(fingerprint) as (FindingRow & { session_started_at: string | null }) | undefined;
}

// ---------------------------------------------------------------------------
// Frontier and element coverage (Phase 4)
// ---------------------------------------------------------------------------

/** Pages linked from somewhere Magpie has been, but never opened. */
export function openFrontier(db: MemoryDb, limit?: number): FrontierRow[] {
  const sql =
    "SELECT * FROM frontier WHERE visited_at IS NULL ORDER BY first_seen, page_key" +
    (limit === undefined ? "" : " LIMIT ?");
  return (limit === undefined ? db.prepare(sql).all() : db.prepare(sql).all(limit)) as FrontierRow[];
}

export function elementsSeenOn(db: MemoryDb, pageKey: string): ElementSeenRow[] {
  return db
    .prepare("SELECT * FROM element_seen WHERE page_key = ? ORDER BY role, name")
    .all(pageKey) as ElementSeenRow[];
}

export interface PageCoverage {
  page_key: string;
  title: string | null;
  seen: number;
  interacted: number;
  /** interacted ÷ seen, or 1 for a page with nothing to interact with. */
  ratio: number;
  flows: number;
}

/**
 * Per-page element coverage. Pages with nothing interactive score 1: a page
 * that offers nothing cannot be under-explored, and ranking it worst would
 * send the explorer back to it forever.
 */
export function pageCoverage(db: MemoryDb): PageCoverage[] {
  const rows = db
    .prepare(
      `SELECT p.page_key AS page_key, p.title AS title,
              COUNT(e.name) AS seen,
              COALESCE(SUM(CASE WHEN e.interactions > 0 THEN 1 ELSE 0 END), 0) AS interacted
       FROM pages p LEFT JOIN element_seen e ON e.page_key = p.page_key
       GROUP BY p.page_key, p.title`,
    )
    .all() as { page_key: string; title: string | null; seen: number; interacted: number }[];

  const flowCounts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT s.url_after AS page_key, COUNT(DISTINCT f.id) AS n
       FROM flows f JOIN flow_steps s ON s.flow_id = f.id
       WHERE f.status = 'verified' AND s.url_after IS NOT NULL
       GROUP BY s.url_after`,
    )
    .all() as { page_key: string; n: number }[]) {
    flowCounts.set(row.page_key, row.n);
  }

  return rows.map((r) => ({
    ...r,
    ratio: r.seen === 0 ? 1 : r.interacted / r.seen,
    flows: flowCounts.get(r.page_key) ?? 0,
  }));
}
