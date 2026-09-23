import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { MagpieConfig } from "../types.js";
import { Collectors } from "./collect.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  collectors: Collectors;
  /** True when a saved storageState was loaded. */
  authLoaded: boolean;
}

export interface OpenOptions {
  /** Project directory — .auth/<authName>.json is read from here. */
  dir: string;
  authName?: string;
  headed?: boolean;
}

export function authStatePath(dir: string, authName = "default"): string {
  return path.join(path.resolve(dir), ".auth", `${authName}.json`);
}

/** Launch chromium with tracing on from the first action (evidence is the product). */
export async function openBrowser(
  cfg: MagpieConfig,
  opts: OpenOptions,
): Promise<BrowserSession> {
  const headed = opts.headed ?? cfg.run.headed;
  const statePath = authStatePath(opts.dir, opts.authName ?? "default");
  const authLoaded = fs.existsSync(statePath);

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    ...(authLoaded ? { storageState: statePath } : {}),
    viewport: { width: 1280, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  // esbuild (used by tsx) rewrites local functions to `__name(fn, "fn")` to keep
  // their names; that helper does not exist inside the page, so evaluated code
  // would throw ReferenceError under `npm run dev`. Compiled dist/ is unaffected.
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: unknown };
    if (typeof g.__name !== "function") g.__name = (fn: unknown) => fn;
  });
  const page = await context.newPage();
  const collectors = new Collectors(page);
  return { browser, context, page, collectors, authLoaded };
}

/** Always writes the trace, even when the session crashed. */
export async function closeBrowser(
  session: BrowserSession | undefined,
  traceOutPath?: string,
): Promise<void> {
  if (!session) return;
  try {
    // No path → the trace is discarded. `magpie login` uses that: a trace of a
    // human typing their password is not evidence anyone wants on disk.
    await session.context.tracing.stop(traceOutPath ? { path: traceOutPath } : {});
  } catch {
    // A dead context cannot produce a trace; the rest of the evidence still stands.
  } finally {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }
}

/** Save the current cookies/localStorage as an auth profile. */
export async function saveAuthState(
  context: BrowserContext,
  dir: string,
  authName = "default",
): Promise<string> {
  const out = authStatePath(dir, authName);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await context.storageState({ path: out });
  fs.chmodSync(out, 0o600);
  return out;
}
