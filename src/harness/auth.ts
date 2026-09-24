import type { Page } from "playwright";
import type { MagpieConfig, Snapshot } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import { takeSnapshot } from "../browser/snapshot.js";
import { click, fill, goto, press, type ActionContext } from "../browser/actions.js";
import { probeTargetFor } from "../config/schema.js";

export interface AuthOutcome {
  ok: boolean;
  /** Human line for the narration / report. */
  detail: string;
  /** Set when a form login succeeded and the session state should be re-saved. */
  reauthenticated?: boolean;
}

/** Landing-page heuristic: a login URL or a password box means "logged out". */
export function looksLoggedOut(snap: Snapshot): boolean {
  if (/\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(snap.url)) return true;
  return snap.elements.some((e) => e.tag.includes("password"));
}

/**
 * The app's own failure message, if it shows one. Requires a phrase rather than
 * the bare word "error": saucedemo lists `error_user` among its valid usernames,
 * and reporting that as the reason for a failed login is worse than saying
 * nothing.
 */
const LOGIN_FAILURE =
  /(do(es)? not match|did not match|invalid|incorrect|not recogni[sz]ed|is required|are required|try again|locked out|failed)/i;

export function findErrorMessage(pageText: string): string | undefined {
  return pageText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.split(/\s+/).length >= 3 && LOGIN_FAILURE.test(l));
}

function findLoginFields(snap: Snapshot) {
  const password = snap.elements.find((e) => e.tag.includes("password"));
  const user = snap.elements.find(
    (e) =>
      e.tag.includes("input") &&
      !e.tag.includes("password") &&
      /user|email|login|account/i.test(`${e.name} ${e.tag}`),
  );
  const submit = snap.elements.find(
    (e) =>
      (e.role === "button" || e.tag.includes("submit")) &&
      /log ?in|sign ?in|submit|continue/i.test(e.name),
  );
  return { user, password, submit };
}

/**
 * Auth check (PHASE-1-BRIEF §P1-T6, probe target added in Phase 4): land on the
 * probe page, decide whether we are logged in, and for `form-login` do the
 * login ourselves. `manual` hands back to the CLI, which exits 3 telling the
 * user to run `magpie login`.
 */
export async function ensureAuthenticated(args: {
  page: Page;
  cfg: MagpieConfig;
  secrets: SecretStore;
  log?: (line: string) => void;
}): Promise<AuthOutcome> {
  const { page, cfg, secrets } = args;
  const log = args.log ?? (() => {});

  const context = async (): Promise<ActionContext> => {
    const { snap, locators } = await takeSnapshot(page);
    return { page, cfg, snap, locators, secrets };
  };

  let ctx = await context();
  const probe = probeTargetFor(cfg);
  const landing = await goto(ctx, probe);
  if (!landing.ok) {
    return { ok: false, detail: `could not reach ${probe}: ${landing.detail}` };
  }

  ctx = await context();
  if (!looksLoggedOut(ctx.snap)) {
    return { ok: true, detail: "already authenticated" };
  }

  if (cfg.auth.strategy === "manual") {
    return {
      ok: false,
      detail: "no valid session — run `magpie login` to capture one",
    };
  }

  // form-login from here on. If the probe page is not where the form lives,
  // `auth.login_url` takes the browser there below.

  const username = process.env[cfg.auth.user_env];
  const password = process.env[cfg.auth.pass_env];
  if (!username || !password) {
    return {
      ok: false,
      detail: `auth.strategy is form-login but ${cfg.auth.user_env}/${cfg.auth.pass_env} are not set in .env`,
    };
  }
  secrets.add(password);

  if (cfg.auth.login_url) {
    const nav = await goto(ctx, cfg.auth.login_url);
    if (!nav.ok) return { ok: false, detail: `could not open the login page: ${nav.detail}` };
    ctx = await context();
  }

  const fields = findLoginFields(ctx.snap);
  if (!fields.user || !fields.password) {
    return { ok: false, detail: "could not find a username/password pair on the login page" };
  }

  log("logging in with the configured credentials");
  const filledUser = await fill(ctx, fields.user.id, username);
  if (!filledUser.ok) return { ok: false, detail: `login failed: ${filledUser.detail}` };
  const filledPass = await fill(ctx, fields.password.id, password);
  if (!filledPass.ok) return { ok: false, detail: `login failed: ${filledPass.detail}` };

  const submitted = fields.submit
    ? await click(ctx, fields.submit.id)
    : await press(ctx, "Enter");
  if (!submitted.ok) return { ok: false, detail: `login failed: ${submitted.detail}` };

  // Wait for the login form to actually go away before judging the outcome.
  // Without this the verdict races the form's own navigation.
  await page
    .waitForFunction(() => !document.querySelector("input[type=password]"), { timeout: 10_000 })
    .catch(() => {
      // Still showing a password field after 10s: the heuristic below reports it.
    });

  ctx = await context();
  if (looksLoggedOut(ctx.snap)) {
    const message = findErrorMessage(ctx.snap.pageText);
    return {
      ok: false,
      detail: `login did not take effect${message ? ` — page says: ${message.trim()}` : ""}`,
    };
  }

  return { ok: true, detail: "logged in via form-login", reauthenticated: true };
}
