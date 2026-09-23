/**
 * Re-render index.html for an existing report folder from session.json +
 * steps.jsonl. Useful after a report-template change — no model calls, no rerun.
 *   npx tsx scripts/rebuild-report.ts <reportDir> [projectDir]
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import { writeHtmlReport } from "../src/report/html.js";
import { PROVIDERS, type SessionResult, type StepRecord } from "../src/types.js";

const reportDir = path.resolve(process.argv[2] ?? ".");
const projectDir = path.resolve(process.argv[3] ?? path.join(reportDir, "..", ".."));

const result = JSON.parse(fs.readFileSync(path.join(reportDir, "session.json"), "utf8")) as SessionResult;
result.reportDir = reportDir; // the folder may have been moved since the run
const steps = fs
  .readFileSync(path.join(reportDir, "steps.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as StepRecord);

const cfg = loadConfig(projectDir);
const llm = PROVIDERS.reduce((n, p) => n + result.usage[p].requests, 0);
const out = writeHtmlReport({
  result,
  cfg,
  steps,
  budgetSummary: `${result.stepCount}/${cfg.budget.max_steps} steps · ${llm}/${cfg.budget.max_llm_requests} LLM calls`,
  providerSummary:
    PROVIDERS.filter((p) => result.usage[p].requests > 0)
      .map((p) => `${p} ${result.usage[p].requests}`)
      .join(" / ") || "no model calls",
});
console.log(out);
