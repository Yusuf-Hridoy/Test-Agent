/**
 * `npm run demo` — a complete Magpie run against the public Sauce Labs demo shop.
 *
 * Needs one free-tier LLM key in your environment (GOOGLE_GENERATIVE_AI_API_KEY,
 * GROQ_API_KEY or MISTRAL_API_KEY). The saucedemo credentials below are the
 * site's own published demo credentials — this script is the only place in the
 * repository where credentials may be hardcoded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCommand } from "../src/cli/init.js";
import { runCommand } from "../src/cli/run.js";
import { API_KEY_ENV, API_KEY_ENV_ALIASES, apiKeyFor } from "../src/model/providers.js";
import { PROVIDERS } from "../src/types.js";

const DEMO_USER = "standard_user";
const DEMO_PASS = "secret_sauce";
const CHARTER =
  "Log in, add the cheapest item to the cart, verify cart badge shows 1, remove it, verify badge clears.";

const available = PROVIDERS.filter((p) => apiKeyFor(p));
if (available.length === 0) {
  console.error(
    `No LLM key found. Set one of:\n  ${PROVIDERS.flatMap((p) => API_KEY_ENV_ALIASES[p]).join("\n  ")}\n` +
      `Gemini's free tier is the default; get a key at https://aistudio.google.com/apikey`,
  );
  process.exit(3);
}

const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "magpie-demo-"));
console.log(`demo project: ${dir}\n`);

await initCommand({ name: "saucedemo", url: "https://www.saucedemo.com", dir });

// Switch the generated project to form-login with the public demo credentials.
const configFile = path.join(dir, "magpie.config.yaml");
fs.writeFileSync(
  configFile,
  fs
    .readFileSync(configFile, "utf8")
    // No login_url: on saucedemo the landing page *is* the login page.
    .replace("strategy: manual", "strategy: form-login"),
);

const envFile = path.join(dir, ".env");
const keys = available.map((p) => `${API_KEY_ENV[p]}=${apiKeyFor(p)}`).join("\n");
fs.writeFileSync(envFile, `${keys}\nAPP_USER=${DEMO_USER}\nAPP_PASS=${DEMO_PASS}\n`, { mode: 0o600 });
console.log(`using ${available.join(", ")}\n`);

await runCommand({ charter: CHARTER, dir, headed: true });
