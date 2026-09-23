import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_FILENAME, ConfigError, parseConfig, projectPaths } from "../config/load.js";
import { configTemplate, envTemplate, gitignoreTemplate } from "../config/template.js";

export interface InitOptions {
  name?: string;
  url?: string;
  dir?: string;
}

async function prompt(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

function normalizeUrl(raw: string): string {
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError(`"${raw}" is not a valid URL. Example: https://www.saucedemo.com`);
  }
  // Strip a lone trailing slash so base_url composes cleanly.
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const paths = projectPaths(opts.dir ?? process.cwd());

  if (fs.existsSync(paths.configFile)) {
    throw new ConfigError(
      `config already exists: ${paths.configFile}\nDelete it first if you really want to start over.`,
    );
  }

  const rawUrl = opts.url ?? (await prompt("Base URL of the app under test: "));
  if (!rawUrl) throw new ConfigError("A base URL is required (--url).");
  const baseUrl = normalizeUrl(rawUrl);

  const suggested = new URL(baseUrl).host.replace(/^www\./, "").split(".")[0] ?? "app";
  const name = opts.name ?? (await prompt(`Project name [${suggested}]: `, suggested));
  if (!name) throw new ConfigError("A project name is required (--name).");

  const configYaml = configTemplate(name, baseUrl);
  // Fail before writing anything if the generated config would not validate.
  parseConfig(configYaml, "generated config");

  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.authDir, { recursive: true });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  fs.writeFileSync(paths.configFile, configYaml);
  if (!fs.existsSync(paths.envFile)) fs.writeFileSync(paths.envFile, envTemplate(), { mode: 0o600 });
  const gitignore = path.join(paths.dir, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, gitignoreTemplate());

  const rel = (p: string) => path.relative(paths.dir, p) || ".";
  console.log(`Created Magpie project "${name}" in ${paths.dir}`);
  console.log(`  ${rel(paths.configFile)}   target, scope, budgets — safe to commit`);
  console.log(`  ${rel(paths.envFile)}                  API keys + app credentials — gitignored`);
  console.log(`  ${rel(gitignore)}            ignores .env, .auth/, reports/`);
  console.log(`  ${rel(paths.authDir)}/                 saved browser sessions — gitignored`);
  console.log(`  ${rel(paths.reportsDir)}/               one folder per run`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Add your LLM key(s) to ${rel(paths.envFile)} (Gemini is the default provider).`);
  console.log("  2. Run `magpie login` to capture an authenticated session.");
  console.log('  3. Run `magpie run --charter "..."` to test.');
}

export const _internals = { normalizeUrl, CONFIG_FILENAME };
