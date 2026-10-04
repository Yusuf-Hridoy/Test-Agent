import fs from "node:fs";
import path from "node:path";
import { loadConfig, projectPaths } from "../config/load.js";
import { closeDb, openMemoryDb } from "../memory/db.js";
import { DASHBOARD_FILENAME, writeDashboard } from "../report/dashboard.js";

export interface DashboardOptions {
  out?: string;
  dir?: string;
}

/**
 * `magpie dashboard` — one offline page showing everything this project
 * remembers: coverage, flows, defects and every run that produced them.
 *
 * Reads only. It never touches the application under test and never calls a
 * model, so it is safe to run at any time, including in CI.
 */
export function dashboardCommand(opts: DashboardOptions = {}): void {
  const dir = opts.dir ?? process.cwd();
  const cfg = loadConfig(dir);
  const outFile = resolveOut(dir, opts.out);

  const db = openMemoryDb(dir);
  try {
    writeDashboard(
      { db, dir: projectPaths(dir).dir, projectName: cfg.name, baseUrl: cfg.base_url },
      outFile,
    );
  } finally {
    closeDb(db);
  }
  console.log(`dashboard: ${outFile}`);
}

/** `--out` may name a file or a directory; a directory gets the default name. */
function resolveOut(dir: string, out?: string): string {
  const target = path.resolve(dir, out ?? DASHBOARD_FILENAME);
  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  return isDir ? path.join(target, DASHBOARD_FILENAME) : target;
}
