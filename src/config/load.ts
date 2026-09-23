import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import dotenv from "dotenv";
import { ZodError } from "zod";
import type { MagpieConfig } from "../types.js";
import { configSchema, withDerivedDefaults } from "./schema.js";

export const CONFIG_FILENAME = "magpie.config.yaml";

/** Config/auth problems the CLI turns into exit code 3. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ProjectPaths {
  dir: string;
  configFile: string;
  envFile: string;
  authDir: string;
  reportsDir: string;
  memoryDir: string;
}

export function projectPaths(dir: string): ProjectPaths {
  const abs = path.resolve(dir);
  return {
    dir: abs,
    configFile: path.join(abs, CONFIG_FILENAME),
    envFile: path.join(abs, ".env"),
    authDir: path.join(abs, ".auth"),
    reportsDir: path.join(abs, "reports"),
    memoryDir: path.join(abs, "memory"),
  };
}

/** Parse + validate magpie.config.yaml. Throws ConfigError with a human message. */
export function parseConfig(yamlText: string, source = CONFIG_FILENAME): MagpieConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    throw new ConfigError(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError(`${source} is empty or not a mapping.`);
  }
  try {
    return withDerivedDefaults(configSchema.parse(raw) as MagpieConfig);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => {
        const where = i.path.length ? i.path.join(".") : "(root)";
        return `  - ${where}: ${i.message}`;
      });
      throw new ConfigError(`${source} is invalid:\n${lines.join("\n")}`);
    }
    throw err;
  }
}

/** Read + validate the config in a project directory, and load its .env. */
export function loadConfig(dir: string): MagpieConfig {
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.configFile)) {
    throw new ConfigError(
      `No ${CONFIG_FILENAME} in ${paths.dir}. Run \`magpie init\` there first.`,
    );
  }
  loadEnv(dir);
  return parseConfig(fs.readFileSync(paths.configFile, "utf8"), paths.configFile);
}

/** Load the project's .env into process.env (existing vars win). */
export function loadEnv(dir: string): void {
  const envFile = projectPaths(dir).envFile;
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });
}

/**
 * Every non-empty value in the project's .env — these are the seed secrets for
 * the redactor (Hard Rule 2). Values are read from the file, not process.env, so
 * unrelated machine env vars are not treated as secrets.
 */
export function envSecrets(dir: string): string[] {
  const envFile = projectPaths(dir).envFile;
  if (!fs.existsSync(envFile)) return [];
  const parsed = dotenv.parse(fs.readFileSync(envFile));
  return Object.values(parsed)
    .map((v) => v.trim())
    .filter((v) => v.length >= 4);
}
