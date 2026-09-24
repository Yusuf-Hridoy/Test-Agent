import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "../config/load.js";
import { API_KEY_ENV, apiKeyFor } from "../model/providers.js";
import { PROVIDERS, type SessionResult, type StepRecord } from "../types.js";
import { runSession } from "../harness/session.js";
import { writeHtmlReport } from "../report/html.js";
import { renderTerminalReport } from "../report/terminal.js";

export interface RunOptions {
  charter?: string;
  /** A flow slug or "all" — switches `run` into regression mode (Phase 3). */
  regress?: string;
  includeDraft?: boolean;
  heal?: boolean;
  failOnSkipped?: boolean;
  json?: boolean;
  as?: string;
  headed?: boolean;
  dir?: string;
}

/** Brief §1.1: 0 = a report exists, 2 = blocked/environment, 3 = auth/config. */
export function exitCodeFor(status: string): number {
  switch (status) {
    case "COMPLETED":
    case "BUDGET_EXHAUSTED":
      return 0;
    case "AUTH_REQUIRED":
      return 3;
    default:
      return 2;
  }
}

function readSteps(reportDir: string): StepRecord[] {
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
        return []; // a torn last line after a hard crash is not fatal
      }
    });
}

function budgetSummary(result: SessionResult, max: { steps: number; llm: number; minutes: number }): string {
  const llm = PROVIDERS.reduce((n, p) => n + result.usage[p].requests, 0);
  const ms = new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime();
  return (
    `${result.stepCount}/${max.steps} steps · ${llm}/${max.llm} LLM calls · ` +
    `${(ms / 60_000).toFixed(1)}/${max.minutes} min`
  );
}

function providerSummary(result: SessionResult): string {
  const used = PROVIDERS.filter((p) => result.usage[p].requests > 0);
  return used.length ? used.map((p) => `${p} ${result.usage[p].requests}`).join(" / ") : "no model calls";
}

export async function runCommand(opts: RunOptions): Promise<void> {
  if (opts.regress) {
    if (opts.charter) {
      throw new ConfigError("Use either --charter (explore) or --regress (replay), not both.");
    }
    const { regressCommand } = await import("./regress.js");
    return regressCommand(opts);
  }

  const dir = opts.dir ?? process.cwd();
  const charter = opts.charter?.trim();
  if (!charter) throw new ConfigError("--charter is required and must not be empty.");

  const cfg = loadConfig(dir); // validates before the browser is launched

  // Fail fast and clearly rather than launching a browser we cannot drive.
  const chain = [cfg.model.primary, ...cfg.model.fallback];
  if (!chain.some((p) => apiKeyFor(p))) {
    throw new ConfigError(
      `No API key for any configured provider (${chain.join(", ")}).\n` +
        `Add one to ${path.join(dir, ".env")}:\n` +
        chain.map((p) => `  ${API_KEY_ENV[p]}=…`).join("\n"),
    );
  }
  console.log(`magpie: ${cfg.name} — ${cfg.base_url}`);
  console.log(`charter: ${charter}\n`);

  const result = await runSession({
    dir,
    charter,
    authName: opts.as ?? "default",
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    narrate: (line) => console.log(line),
  });

  const summary = budgetSummary(result, {
    steps: cfg.budget.max_steps,
    llm: cfg.budget.max_llm_requests,
    minutes: cfg.budget.max_minutes,
  });
  const providers = providerSummary(result);
  const htmlPath = writeHtmlReport({
    result,
    cfg,
    steps: readSteps(result.reportDir),
    budgetSummary: summary,
    providerSummary: providers,
  });

  console.log(
    renderTerminalReport({ result, budgetSummary: summary, providerSummary: providers, htmlPath }),
  );

  if (result.status === "AUTH_REQUIRED") {
    console.error("\nNo usable session. Run `magpie login` first.");
    console.error(
      "Already logged in there? Point base_url at a page that requires a session —\n" +
        "a landing page that always shows the login form cannot prove one exists.",
    );
  }
  process.exitCode = exitCodeFor(result.status);
}
