/**
 * Pre-flight key check. Prints only whether each key is set and how long it is —
 * never any part of a key value (CLAUDE.md Hard Rule 1).
 *   npx tsx scripts/check-keys.ts [projectDir]
 */
import path from "node:path";
import { loadEnv } from "../src/config/load.js";
import { apiKeyFor } from "../src/model/providers.js";
import { PROVIDERS } from "../src/types.js";

const dir = path.resolve(process.argv[2] ?? process.cwd());
loadEnv(dir);

const LABEL: Record<string, string> = { gemini: "GEMINI", groq: "GROQ", mistral: "MISTRAL" };
let missingRequired = false;

for (const provider of PROVIDERS) {
  const value = apiKeyFor(provider);
  const label = LABEL[provider];
  if (value) {
    console.log(`${label}: set (len=${value.length})`);
  } else {
    console.log(`${label}: NOT SET`);
    if (provider === "gemini" || provider === "groq") missingRequired = true;
  }
}

console.log(`project: ${dir}`);
if (missingRequired) {
  console.error("\nGEMINI and GROQ keys are both required for acceptance.");
  process.exit(3);
}
