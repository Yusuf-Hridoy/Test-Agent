import type { Locator, Page } from "playwright";
import type { ElementRef, MagpieConfig, Snapshot } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import { sleep } from "../util.js";
import { checkClick, checkGoto } from "./guard.js";

export const ACTION_TIMEOUT_MS = 10_000;
export const NAV_TIMEOUT_MS = 30_000;
export const MAX_WAIT_MS = 10_000;

export interface ActionContext {
  page: Page;
  cfg: MagpieConfig;
  snap: Snapshot;
  locators: Map<string, Locator>;
  secrets: SecretStore;
  /** Overrides the default action timeout (used by the slow-network retry). */
  timeoutMs?: number;
}

export interface ActionResult {
  ok: boolean;
  /** The exact string handed back to the model. */
  detail: string;
  newUrl: string;
  /** Refused by a guard rather than failed — never an application bug. */
  refused?: boolean;
  /** The action timed out; the harness may retry it with extra grace. */
  timedOut?: boolean;
  /** A navigation/connection error worth showing to the environment monitor. */
  navError?: string;
}

function isTimeout(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /Timeout .*exceeded|timed out/i.test(msg);
}

function navErrorOf(err: unknown): string | undefined {
  const msg = (err as Error)?.message ?? "";
  const m = /net::ERR_[A-Z_]+|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.exec(msg);
  return m?.[0];
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0] ?? "error";
}

async function resolve(
  ctx: ActionContext,
  id: string,
): Promise<{ el: ElementRef; locator: Locator } | { error: string }> {
  const el = ctx.snap.elements.find((e) => e.id === id);
  const locator = ctx.locators.get(id);
  if (!el || !locator) return { error: `Element ${id} not found — take a new snapshot` };

  // A framework re-render between the snapshot and this action destroys the
  // tagged node, and the tag goes with it. Fall back to the accessible name we
  // recorded, which survives a re-render of the same element.
  try {
    if ((await locator.count()) === 0 && el.name) {
      const byName = ctx.page.getByRole(el.role as Parameters<typeof ctx.page.getByRole>[0], {
        name: el.name,
        exact: true,
      });
      if ((await byName.count()) > 0) return { el, locator: byName.first() };
      const byText = ctx.page.locator(`text="${el.name.replace(/"/g, '\\"')}"`);
      if ((await byText.count()) > 0) return { el, locator: byText.first() };
      return { error: `Element ${id} ("${el.name}") is no longer on the page — take a new snapshot` };
    }
  } catch {
    // Counting can throw mid-navigation; fall through to the tagged locator.
  }
  return { el, locator };
}

/**
 * Give a click/submit a moment to settle if it started a navigation.
 * `waitForLoadState` returns immediately when the CURRENT document is already
 * loaded, so a form submit that has not navigated yet would slip through and the
 * caller would snapshot the old page. Waiting briefly for the network to go idle
 * closes that race; both waits are capped and failures are non-fatal.
 */
async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    await page.waitForLoadState("networkidle", { timeout: 3_000 });
  } catch {
    // A page that never settles is still worth observing — the snapshot follows.
  }
}

/**
 * Chromium parks a failed navigation on an internal error page. That is a
 * network failure, not the app sending us somewhere out of scope — without this
 * check a server outage reads as a scope violation and the objective is blocked
 * instead of the harness pausing and retrying (Hard Rule 6).
 */
function errorPageNavError(page: Page): string | undefined {
  const url = page.url();
  if (url.startsWith("chrome-error://") || url.startsWith("about:neterror")) {
    return "net::ERR_FAILED (browser error page)";
  }
  return undefined;
}

/** After an in-page navigation, make sure we did not leave the allowed scope. */
async function enforceScopeAfterNav(ctx: ActionContext, suffix: string): Promise<string> {
  const verdict = checkGoto(ctx.page.url(), ctx.cfg);
  if (verdict.allowed) return suffix;
  const left = ctx.page.url();
  try {
    await ctx.page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  } catch {
    await ctx.page.goto(ctx.cfg.base_url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
  }
  return ` That took the browser to ${left}, which is outside the allowed scope, so Magpie navigated back. URL now ${ctx.page.url()}`;
}

export async function goto(ctx: ActionContext, url: string): Promise<ActionResult> {
  const verdict = checkGoto(url, ctx.cfg, ctx.page.url());
  if (!verdict.allowed) {
    return { ok: false, detail: verdict.reason!, newUrl: ctx.page.url(), refused: true };
  }
  const absolute = new URL(url, ctx.page.url()).toString();
  try {
    await ctx.page.goto(absolute, {
      timeout: ctx.timeoutMs ?? NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    return { ok: true, detail: `OK, now at ${ctx.page.url()}`, newUrl: ctx.page.url() };
  } catch (err) {
    const navError = navErrorOf(err);
    return {
      ok: false,
      detail: `Navigation to ${absolute} failed: ${firstLine(err)}`,
      newUrl: ctx.page.url(),
      ...(isTimeout(err) ? { timedOut: true } : {}),
      ...(navError ? { navError } : {}),
    };
  }
}

export async function click(ctx: ActionContext, id: string): Promise<ActionResult> {
  const found = await resolve(ctx, id);
  if ("error" in found) {
    return { ok: false, detail: found.error, newUrl: ctx.page.url(), refused: true };
  }
  const verdict = checkClick(found.el, ctx.cfg);
  if (!verdict.allowed) {
    return { ok: false, detail: verdict.reason!, newUrl: ctx.page.url(), refused: true };
  }
  try {
    await found.locator.click({ timeout: ctx.timeoutMs ?? ACTION_TIMEOUT_MS });
    await settle(ctx.page);
    const navError = errorPageNavError(ctx.page);
    if (navError) {
      return {
        ok: false,
        detail: `Clicked "${found.el.name}" but the page failed to load — the server did not respond.`,
        newUrl: ctx.page.url(),
        navError,
      };
    }
    const suffix = await enforceScopeAfterNav(ctx, ` URL now ${ctx.page.url()}`);
    return {
      ok: true,
      detail: `Clicked "${found.el.name}".${suffix}`,
      newUrl: ctx.page.url(),
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not click "${found.el.name}" (${id}): ${firstLine(err)}`,
      newUrl: ctx.page.url(),
      ...(isTimeout(err) ? { timedOut: true } : {}),
      ...(navErrorOf(err) ? { navError: navErrorOf(err)! } : {}),
    };
  }
}

export async function fill(ctx: ActionContext, id: string, text: string): Promise<ActionResult> {
  const found = await resolve(ctx, id);
  if ("error" in found) {
    return { ok: false, detail: found.error, newUrl: ctx.page.url(), refused: true };
  }
  // Hard Rule 2: whatever goes into a password field becomes a redaction secret
  // BEFORE it is typed, so it can never reach a prompt or a log.
  if (found.el.tag.includes("password")) ctx.secrets.add(text);
  try {
    await found.locator.fill(text, { timeout: ctx.timeoutMs ?? ACTION_TIMEOUT_MS });
    return { ok: true, detail: `Filled "${found.el.name}"`, newUrl: ctx.page.url() };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fill "${found.el.name}" (${id}): ${firstLine(err)}`,
      newUrl: ctx.page.url(),
      ...(isTimeout(err) ? { timedOut: true } : {}),
    };
  }
}

export async function select(ctx: ActionContext, id: string, value: string): Promise<ActionResult> {
  const found = await resolve(ctx, id);
  if ("error" in found) {
    return { ok: false, detail: found.error, newUrl: ctx.page.url(), refused: true };
  }
  try {
    await found.locator.selectOption(value, { timeout: ctx.timeoutMs ?? ACTION_TIMEOUT_MS });
    await settle(ctx.page);
    return {
      ok: true,
      detail: `Selected "${value}" in "${found.el.name}"`,
      newUrl: ctx.page.url(),
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not select "${value}" in "${found.el.name}": ${firstLine(err)}`,
      newUrl: ctx.page.url(),
      ...(isTimeout(err) ? { timedOut: true } : {}),
    };
  }
}

export async function press(ctx: ActionContext, key: string): Promise<ActionResult> {
  try {
    await ctx.page.keyboard.press(key, { delay: 20 });
    await settle(ctx.page);
    const navError = errorPageNavError(ctx.page);
    if (navError) {
      return {
        ok: false,
        detail: `Pressed ${key} but the page failed to load — the server did not respond.`,
        newUrl: ctx.page.url(),
        navError,
      };
    }
    const suffix = await enforceScopeAfterNav(ctx, "");
    return { ok: true, detail: `Pressed ${key}.${suffix}`, newUrl: ctx.page.url() };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not press "${key}": ${firstLine(err)}. Use key names like Enter, Tab, Escape, ArrowDown.`,
      newUrl: ctx.page.url(),
    };
  }
}

export async function wait(ctx: ActionContext, ms: number): Promise<ActionResult> {
  const clamped = Math.max(0, Math.min(Math.round(ms), MAX_WAIT_MS));
  await sleep(clamped);
  return { ok: true, detail: `Waited ${clamped}ms`, newUrl: ctx.page.url() };
}
