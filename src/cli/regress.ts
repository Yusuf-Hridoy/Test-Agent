import path from "node:path";
import { ConfigError, loadConfig } from "../config/load.js";
import { API_KEY_ENV, apiKeyFor } from "../model/providers.js";
import { PROVIDERS } from "../types.js";
import { runRegression, RegressError, type SuiteResult } from "../memory/regress.js";
import { writeSuiteReport } from "../report/suite.js";
import { renderSuiteTerminal } from "../report/terminal.js";
import type { RunOptions } from "./run.js";

/**
 * `magpie run --regress <slug|all>`.
 *
 * Non-interactive by construction: nothing here prompts, so it is safe in CI
 * and in a cron job. Without --heal it needs no API key at all — the whole
 * point of a compiled flow is that re-running it costs nothing.
 */
export async function regressCommand(opts: RunOptions): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  const requested = (opts.regress ?? "").trim();
  if (!requested) throw new ConfigError("--regress needs a flow slug, or `all`.");

  const cfg = loadConfig(dir); // validates before a browser is launched

  if (opts.heal) {
    const chain = [cfg.model.primary, ...cfg.model.fallback];
    if (!chain.some((p) => apiKeyFor(p))) {
      throw new ConfigError(
        `--heal needs a model, but no API key is set for any configured provider (${chain.join(", ")}).\n` +
          `Add one to ${path.join(dir, ".env")}:\n` +
          chain.map((p) => `  ${API_KEY_ENV[p]}=…`).join("\n") +
          `\nOr drop --heal: replaying flows costs nothing.`,
      );
    }
  }

  // In --json mode stdout carries the suite document and nothing else, so every
  // human-facing line goes to stderr. A CI step must be able to pipe stdout.
  const log = opts.json
    ? (line: string) => console.error(line)
    : (line: string) => console.log(line);

  log(`magpie regression: ${cfg.name} — ${cfg.base_url}`);
  log(`flows: ${requested}${opts.heal ? " (healing enabled)" : ""}\n`);

  let result: SuiteResult;
  try {
    result = await runRegression({
      dir,
      requested,
      ...(opts.includeDraft !== undefined ? { includeDraft: opts.includeDraft } : {}),
      ...(opts.heal !== undefined ? { heal: opts.heal } : {}),
      ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
      ...(opts.as ? { authName: opts.as } : {}),
      narrate: log,
    });
  } catch (err) {
    if (err instanceof RegressError) throw new ConfigError(err.message);
    throw err;
  }

  const htmlPath = writeSuiteReport(result);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    console.error(`\nreport    ${htmlPath}`);
  } else {
    console.log(renderSuiteTerminal(result, htmlPath));
  }

  const llm = PROVIDERS.reduce((n, p) => n + result.usage[p].requests, 0);
  if (!opts.heal && llm > 0) {
    // Belt and braces: runRegression already asserts this.
    console.error(`WARNING: ${llm} model call(s) were made without --heal.`);
  }
  process.exitCode = result.exitCode;
}
