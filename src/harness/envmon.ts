import type { Page } from "playwright";
import type { ActionResult } from "../browser/actions.js";
import { sleep } from "../util.js";

/** Retry schedule while waiting for a site to come back (brief §P1-T5). */
export const RECOVERY_WAITS_MS = [30_000, 60_000, 120_000];
const CONSECUTIVE_5XX_FOR_OUTAGE = 3;

export type EnvVerdict = "ok" | "suspect_outage";

export interface EnvClassification {
  verdict: EnvVerdict;
  reason?: string;
}

const CONNECTION_ERROR =
  /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|EMPTY_RESPONSE|SSL_PROTOCOL_ERROR|FAILED|SOCKET_NOT_CONNECTED)/;

/**
 * Hard Rule 6: environment ≠ product. Connection failures, DNS errors and mass
 * 5xx are outages, never application bugs.
 */
export function classifyActionResult(
  result: Pick<ActionResult, "ok" | "detail" | "timedOut" | "navError">,
  opts: {
    originWasReachable: boolean;
    serverErrorUrls?: string[];
    /** True only for a navigation. A click that times out means the element was
     * not clickable — that is the app's problem, or the model's, never the
     * network's, and must not trigger the 30/60/120s outage cycle. */
    isNavigation?: boolean;
  } = { originWasReachable: true },
): EnvClassification {
  if (result.navError) {
    if (CONNECTION_ERROR.test(result.navError) || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(result.navError)) {
      return { verdict: "suspect_outage", reason: `connection error: ${result.navError}` };
    }
  }
  if (result.timedOut && opts.isNavigation && opts.originWasReachable) {
    return { verdict: "suspect_outage", reason: "navigation timed out on a previously reachable origin" };
  }
  const distinct = new Set(opts.serverErrorUrls ?? []);
  if (distinct.size >= CONSECUTIVE_5XX_FOR_OUTAGE) {
    return {
      verdict: "suspect_outage",
      reason: `${distinct.size} distinct URLs returned 5xx`,
    };
  }
  return { verdict: "ok" };
}

export interface RecoveryLog {
  (line: string): void;
}

/**
 * Poll the base URL on the 30/60/120 s schedule. `true` → the session resumes;
 * `false` → the session finalizes ENVIRONMENT_DOWN.
 */
export async function waitForRecovery(
  page: Page,
  baseUrl: string,
  log: RecoveryLog = () => {},
  waits: number[] = RECOVERY_WAITS_MS,
): Promise<boolean> {
  for (const [i, wait] of waits.entries()) {
    log(`environment looks down — retry ${i + 1}/${waits.length} in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    try {
      const res = await page.goto(baseUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
      const status = res?.status() ?? 0;
      if (status > 0 && status < 500) {
        log(`environment recovered (${status}) — resuming`);
        return true;
      }
      log(`still failing: HTTP ${status}`);
    } catch (err) {
      log(`still failing: ${((err as Error).message ?? "").split("\n")[0]}`);
    }
  }
  return false;
}

export interface SlowGraceOutcome<T> {
  result: T;
  /** Set when the first attempt timed out and the retry with extra grace worked. */
  observation?: { type: "slow_page"; detail: string };
}

/**
 * One retry with extra grace before a timeout is treated as a failure. A page
 * that only needed more time is an observation, not a finding.
 */
export async function slowGrace<T extends { ok: boolean; timedOut?: boolean; detail: string }>(
  attempt: (timeoutMs?: number) => Promise<T>,
  graceMs: number,
  label: string,
): Promise<SlowGraceOutcome<T>> {
  const first = await attempt();
  if (first.ok || !first.timedOut || graceMs <= 0) return { result: first };

  const second = await attempt(graceMs);
  if (second.ok) {
    return {
      result: second,
      observation: {
        type: "slow_page",
        detail: `${label} needed an extra ${graceMs}ms to complete (first attempt timed out)`,
      },
    };
  }
  return { result: second };
}
