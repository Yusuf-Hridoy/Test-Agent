import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { projectPaths } from "../config/load.js";
import type {
  FindingRow,
  FlowRow,
  FlowStatus,
  FlowStepRow,
  PageRow,
  SessionRow,
  StoredFlow,
} from "./types.js";

export type MemoryDb = Database.Database;

export const DB_FILENAME = "magpie.db";
export const SCHEMA_VERSION = 1;

/**
 * Migrations are numbered SQL strings applied in order at open. Never edit one
 * that has shipped — add the next number instead; existing project databases
 * only ever run the migrations they have not seen.
 */
const MIGRATIONS: string[] = [
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
