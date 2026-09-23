/**
 * Live model smoke test (needs a real API key).
 *   npx tsx scripts/smoke-model.ts [projectDir]
 * Reads the project's .env, asks the model to reply PONG, prints usage.
 */
import path from "node:path";
import { loadConfig, envSecrets } from "../src/config/load.js";
import { askModel } from "../src/model/ask.js";
import { SecretStore } from "../src/model/redact.js";
import { UsageTracker } from "../src/model/usage.js";
import { modelIdFor } from "../src/model/providers.js";

const dir = path.resolve(process.argv[2] ?? process.cwd());
const cfg = loadConfig(dir);
const usage = new UsageTracker();
const secrets = new SecretStore(envSecrets(dir));

console.log(`asking ${cfg.model.primary} (${modelIdFor(cfg.model.primary, cfg.model.ids)})…`);
const res = await askModel(
  {
    system: "You are a connectivity check. Reply with exactly one word.",
    messages: [{ role: "user", content: "reply PONG" }],
    tools: {},
  },
  cfg,
  usage,
  secrets,
);
console.log(`${res.provider} (${res.modelId}) → ${res.text.trim()}`);
console.log(JSON.stringify(usage.snapshot(), null, 2));
