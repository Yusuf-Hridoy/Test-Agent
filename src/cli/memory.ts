import fs from "node:fs";
import path from "node:path";
import {
  closeDb,
  counts,
  listFlows,
  memoryDbPath,
  openMemoryDb,
  recentSessions,
  schemaVersion,
  topPages,
} from "../memory/db.js";
import { renderTable } from "../report/terminal.js";
import { truncate } from "../util.js";

export interface MemoryOptions {
  dir?: string;
}

const TOP_PAGES = 15;
const RECENT_SESSIONS = 5;

/** `magpie memory show` — what this project remembers about the application. */
export function memoryShowCommand(opts: MemoryOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const c = counts(db);
    console.log(`memory: ${memoryDbPath(dir)}`);
    console.log(
      `sessions ${c.sessions} · pages ${c.pages} · transitions ${c.transitions} · ` +
        `flows ${c.flows} · findings ${c.findings}\n`,
    );

    if (c.pages === 0 && c.flows === 0) {
      console.log("Nothing remembered yet. Run `magpie run --charter \"…\"` first.");
      return;
    }

    console.log("top pages");
    console.log(
      renderTable(
        ["VISITS", "PAGE", "TITLE"],
        topPages(db, TOP_PAGES).map((p) => [
          String(p.visit_count),
          truncate(p.page_key, 48),
          truncate(p.title ?? "", 34),
        ]),
      ),
    );

    const flows = listFlows(db);
    console.log("\nflows");
    console.log(
      renderTable(
        ["STATUS", "SLUG", "STEPS", "NAME"],
        flows.map((f) => [
          f.status,
          truncate(f.slug, 40),
          String(stepCount(db, f.id)),
          truncate(f.name, 40),
        ]),
      ),
    );

    console.log("\nrecent sessions");
    console.log(
      renderTable(
        ["WHEN", "STATUS", "LLM", "CHARTER"],
        recentSessions(db, RECENT_SESSIONS).map((s) => [
          s.started_at.slice(0, 16).replace("T", " "),
          s.status,
          String(s.llm_requests),
          truncate(s.charter ?? "", 46),
        ]),
      ),
    );
  } finally {
    closeDb(db);
  }
}

/** `magpie memory stats` — size and totals, for "is this thing growing?" */
export function memoryStatsCommand(opts: MemoryOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const db = openMemoryDb(dir);
  try {
    const c = counts(db);
    const file = memoryDbPath(dir);
    const bytes = filesSize(path.dirname(file));
    const sessions = recentSessions(db, 1);
    const rows: [string, string][] = [
      ["database", file],
      ["size on disk", `${(bytes / 1024).toFixed(1)} KiB`],
      ["schema version", String(schemaVersion(db))],
      ["sessions", String(c.sessions)],
      ["pages", String(c.pages)],
      ["transitions", String(c.transitions)],
      [
        "flows",
        `${c.flows} (${listFlows(db, "verified").length} verified, ` +
          `${listFlows(db, "draft").length} draft, ${listFlows(db, "broken").length} broken)`,
      ],
      ["findings", String(c.findings)],
      ["last session", sessions[0]?.started_at ?? "never"],
    ];
    for (const [label, value] of rows) console.log(`${label.padEnd(15)}${value}`);
  } finally {
    closeDb(db);
  }
}

function stepCount(db: ReturnType<typeof openMemoryDb>, flowId: number): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM flow_steps WHERE flow_id = ?").get(flowId) as { n: number }
  ).n;
}

/** The DB plus its WAL sidecars — the honest number for "how big is memory?". */
function filesSize(memoryDir: string): number {
  if (!fs.existsSync(memoryDir)) return 0;
  return fs
    .readdirSync(memoryDir)
    .map((f) => {
      try {
        return fs.statSync(path.join(memoryDir, f)).size;
      } catch {
        return 0;
      }
    })
    .reduce((a, b) => a + b, 0);
}
