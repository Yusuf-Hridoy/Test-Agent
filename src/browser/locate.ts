import type { Locator, Page } from "playwright";
import { MAGPIE_ATTR } from "./snapshot.js";

/**
 * One shared definition of "how do you find this element again".
 *
 * Recording and replay MUST agree: the index recorded at action time is only
 * meaningful if replay enumerates the same candidates in the same order. Two
 * copies of this logic would drift, and the drift would be silent — a replay
 * clicking the wrong product with a green result.
 */
export interface TargetRef {
  role: string | null;
  name: string;
  /** 0-based index among the matches, when the name alone is ambiguous. */
  nth?: number | null;
}

export type Candidate = { where: string; locator: Locator };

/**
 * Ordered from most to least specific. Exact name first so a "Cart" target does
 * not resolve ambiguously against "Add to cart" while a perfect match sits on
 * the page.
 */
export function targetCandidates(page: Page, role: string | null, name: string): Candidate[] {
  const out: Candidate[] = [];
  if (role) {
    const r = role as Parameters<Page["getByRole"]>[0];
    out.push({ where: `role=${role} name="${name}" (exact)`, locator: page.getByRole(r, { name, exact: true }) });
    out.push({ where: `role=${role} name~"${name}"`, locator: page.getByRole(r, { name, exact: false }) });
  }
  out.push({ where: `text="${name}"`, locator: page.getByText(name, { exact: false }) });
  return out;
}

/** count() throws on an unknown ARIA role or mid-navigation; treat as no match. */
async function safeCount(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return -1;
  }
}

/**
 * Which of the matching elements is the one being acted on right now?
 *
 * Identified by the snapshot tag the snapshotter put on it. Returns undefined
 * when the element cannot be located among the candidates (for instance after a
 * re-render dropped the tag) — an absent index is honest; a wrong one is not.
 */
export async function indexOfTaggedElement(
  page: Page,
  role: string | null,
  name: string,
  magpieId: string,
): Promise<number | undefined> {
  if (!name) return undefined;
  for (const { locator } of targetCandidates(page, role, name)) {
    const count = await safeCount(locator);
    if (count <= 0) continue;
    if (count === 1) return 0;
    let all: Locator[];
    try {
      all = await locator.all();
    } catch {
      continue;
    }
    for (let i = 0; i < all.length; i++) {
      try {
        if ((await all[i]!.getAttribute(MAGPIE_ATTR)) === magpieId) return i;
      } catch {
        // element detached between all() and the read; keep looking
      }
    }
    // The first candidate list that matches is the one replay will use, so a
    // miss here means the tag is gone, not that a later list would do better.
    return undefined;
  }
  return undefined;
}

export interface ResolveOutcome {
  locator?: Locator;
  error?: string;
  /** True when the target was ambiguous and no recorded index could settle it. */
  ambiguous?: boolean;
}

/**
 * Resolve a recorded target to exactly one element.
 *
 * With a recorded index, ambiguity is answerable: "the 3rd Add to cart button"
 * is a fact about the recording, not a guess. Without one (a flow recorded
 * before Phase 3), ambiguity stays a failure.
 */
export async function resolveTarget(
  page: Page,
  target: TargetRef,
  timeoutMs: number,
  pollMs = 250,
): Promise<ResolveOutcome> {
  const { role, name } = target;
  if (!name) return { error: "step has no target to resolve" };
  const nth = target.nth ?? null;

  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let lastWhere = "";

  for (;;) {
    for (const { where, locator } of targetCandidates(page, role, name)) {
      const count = await safeCount(locator);
      if (count < 0) continue;
      if (count === 1) return { locator: locator.first() };
      if (count > 1) {
        if (nth !== null && nth >= 0 && nth < count) return { locator: locator.nth(nth) };
        lastCount = count;
        lastWhere = where;
      }
    }

    if (Date.now() >= deadline) {
      const seconds = timeoutMs / 1000;
      if (lastCount === 0) {
        return { error: `no element matched ${role ? `${role} ` : ""}"${name}" after ${seconds}s` };
      }
      return {
        ambiguous: true,
        error:
          nth === null
            ? `${lastCount} elements matched ${lastWhere} after ${seconds}s and this flow carries no ` +
              `recorded position — re-record it to gain nth targeting`
            : `${lastCount} elements matched ${lastWhere} after ${seconds}s, but the recorded position ` +
              `${nth} is no longer among them`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
