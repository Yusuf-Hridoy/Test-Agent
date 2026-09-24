import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeApp, type FakeApp } from "./fakeapp.js";
import { openBrowser, closeBrowser, type BrowserSession } from "../../browser/session.js";
import { ensureAuthenticated } from "../auth.js";
import { probeTargetFor } from "../../config/schema.js";
import { parseConfig, ConfigError } from "../../config/load.js";
import { SecretStore } from "../../model/redact.js";

/**
 * The debt from Phases 2 and 3: on an app whose landing page always shows the
 * login form, base_url cannot tell a live session from a dead one. The fixture
 * app is exactly that shape — /login has a password box, /inventory does not.
 */
describe("auth.probe_url (P4-T1)", () => {
  let app: FakeApp;
  let dir: string;

  beforeAll(async () => {
    app = await startFakeApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-auth-"));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfgFor = (probe?: string) =>
    parseConfig(
      `name: fixture\nbase_url: ${app.url}/login\n` +
        `auth:\n  strategy: manual\n${probe ? `  probe_url: "${probe}"\n` : ""}`,
    );

  async function check(probe?: string) {
    let session: BrowserSession | undefined;
    try {
      session = await openBrowser(cfgFor(probe), { dir, headed: false });
      return await ensureAuthenticated({
        page: session.page,
        cfg: cfgFor(probe),
        secrets: new SecretStore(),
      });
    } finally {
      await closeBrowser(session);
    }
  }

  it("resolves the probe target, defaulting to base_url", () => {
    expect(probeTargetFor(cfgFor())).toBe(`${app.url}/login`);
    // A path is resolved against base_url, which is the spelling the config
    // template recommends.
    expect(probeTargetFor(cfgFor("/inventory"))).toBe(`${app.url}/inventory`);
    expect(probeTargetFor(cfgFor(`${app.url}/inventory`))).toBe(`${app.url}/inventory`);
  });

  it("without probe_url, reports no session — the login page proves nothing", async () => {
    const outcome = await check();
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no valid session/);
  }, 60_000);

  it("with probe_url, the check runs against the page that requires a session", async () => {
    const outcome = await check("/inventory");
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe("already authenticated");
  }, 60_000);

  it("reports the probe page, not base_url, when the probe cannot be reached", async () => {
    const cfg = parseConfig(
      `name: fixture\nbase_url: ${app.url}\nauth:\n  strategy: manual\n  probe_url: "/inventory"\n` +
        `scope:\n  include: ["127.0.0.1:*/nowhere/**"]\n`,
    );
    let session: BrowserSession | undefined;
    try {
      session = await openBrowser(cfg, { dir, headed: false });
      const outcome = await ensureAuthenticated({
        page: session.page,
        cfg,
        secrets: new SecretStore(),
      });
      // The scope guard refuses the probe: the message names the page actually
      // attempted, or the reader goes looking in the wrong place.
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("/inventory");
      expect(outcome.detail).toMatch(/scope guard/i);
    } finally {
      await closeBrowser(session);
    }
  }, 60_000);

  it("rejects a probe_url that cannot be a URL at all", () => {
    expect(() =>
      parseConfig(`name: x\nbase_url: https://shop.test\nauth:\n  probe_url: "http://"\n`),
    ).toThrow(ConfigError);
  });
});
