import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, counts, hasMemory, memoryDbPath, openMemoryDb, schemaVersion } from "../db.js";

const dirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("memory database", () => {
  it("creates memory/magpie.db and migrates to the current schema", () => {
    const dir = tmpProject();
    const db = openMemoryDb(dir);
    expect(fs.existsSync(memoryDbPath(dir))).toBe(true);
    expect(memoryDbPath(dir)).toBe(path.join(dir, "memory", "magpie.db"));
    expect(schemaVersion(db)).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    closeDb(db);
  });

  it("creates every table and index in the brief's DDL", () => {
    const db = openMemoryDb(tmpProject());
    const names = (db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]).map((r) => r.name);
    for (const expected of [
      "schema_version",
      "sessions",
      "pages",
      "transitions",
      "flows",
      "flow_steps",
      "findings",
      "idx_findings_page",
    ]) {
      expect(names, expected).toContain(expected);
    }
    closeDb(db);
  });

  it("is idempotent across reopen — migrations run once", () => {
    const dir = tmpProject();
    const first = openMemoryDb(dir);
    first
      .prepare("INSERT INTO sessions (started_at, status, report_dir) VALUES (?,?,?)")
      .run("2026-09-23T10:00:00+02:00", "COMPLETED", "reports/x");
    closeDb(first);

    const second = openMemoryDb(dir);
    expect(schemaVersion(second)).toBe(1);
    // A second migration pass would have thrown on CREATE TABLE, and the row
    // written before the reopen must survive.
    expect(counts(second).sessions).toBe(1);
    const versions = second.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
    expect(versions.n).toBe(1);
    closeDb(second);
  });

  it("cascades flow_steps when a flow is deleted (foreign_keys ON)", () => {
    const db = openMemoryDb(tmpProject());
    const now = "2026-09-23T10:00:00+02:00";
    const flow = db
      .prepare(
        "INSERT INTO flows (slug, name, start_page_key, created_at, updated_at) VALUES (?,?,?,?,?)",
      )
      .run("demo-flow", "Demo flow", "shop.test/", now, now);
    db.prepare("INSERT INTO flow_steps (flow_id, seq, action) VALUES (?,?,?)").run(
      flow.lastInsertRowid,
      1,
      "click",
    );
    db.prepare("DELETE FROM flows WHERE slug = ?").run("demo-flow");
    const left = db.prepare("SELECT COUNT(*) AS n FROM flow_steps").get() as { n: number };
    expect(left.n).toBe(0);
    closeDb(db);
  });

  it("reports an empty database as having no memory", () => {
    const db = openMemoryDb(tmpProject());
    expect(hasMemory(db)).toBe(false);
    expect(counts(db)).toEqual({ sessions: 0, pages: 0, transitions: 0, flows: 0, findings: 0 });
    closeDb(db);
  });
});
