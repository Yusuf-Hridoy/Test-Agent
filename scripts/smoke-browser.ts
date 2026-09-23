/**
 * Browser-layer smoke test (no LLM key needed).
 *   npx tsx scripts/smoke-browser.ts [url]
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { parseConfig } from "../src/config/load.js";
import { openBrowser, closeBrowser } from "../src/browser/session.js";
import { renderSnapshot, takeSnapshot } from "../src/browser/snapshot.js";
import { goto } from "../src/browser/actions.js";
import { SecretStore } from "../src/model/redact.js";

const url = process.argv[2] ?? "https://www.saucedemo.com";
const cfg = parseConfig(`name: smoke\nbase_url: ${url}\n`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-smoke-"));

const session = await openBrowser(cfg, { dir, headed: false });
try {
  const { snap, locators } = await takeSnapshot(session.page);
  const nav = await goto(
    { page: session.page, cfg, snap, locators, secrets: new SecretStore() },
    cfg.base_url,
  );
  console.log(`goto → ${nav.detail}`);
  const after = await takeSnapshot(session.page);
  console.log(renderSnapshot(after.snap).slice(0, 1200));
  console.log(`\nelements: ${after.snap.elements.length}`);
  const drained = session.collectors.drain();
  console.log(`console errors: ${drained.console.length}, network errors: ${drained.network.length}`);
} finally {
  await closeBrowser(session, path.join(dir, "trace.zip"));
  console.log(`trace: ${path.join(dir, "trace.zip")} (${fs.existsSync(path.join(dir, "trace.zip")) ? "written" : "MISSING"})`);
}
