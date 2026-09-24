import { z } from "zod";
import { isoNow } from "../util.js";
import { counts, openFrontier, pageCoverage, type MemoryDb } from "./db.js";

/**
 * The one sentence that keeps this number honest. Coverage against a map you
 * drew yourself is not coverage of the application; it is coverage of what you
 * have found so far, and saying so is the difference between a useful metric
 * and a misleading one.
 */
export const COVERAGE_CAVEAT =
  "Coverage is measured against pages Magpie has discovered; unknown areas are not included.";

/** How many of the worst-covered pages a report lists (§1.4). */
export const WORST_PAGES = 10;
const FRONTIER_SAMPLE = 10;

export const coverageSchema = z.object({
  generatedAt: z.string(),
  note: z.string(),
  pages: z.object({
    /** visited + still on the frontier. */
    known: z.number(),
    visited: z.number(),
    frontier: z.number(),
  }),
  elements: z.object({
    seen: z.number(),
    interacted: z.number(),
    /** interacted ÷ seen, or 1 when nothing has been seen yet. */
    ratio: z.number(),
  }),
  flows: z.object({
    total: z.number(),
    verified: z.number(),
    draft: z.number(),
    broken: z.number(),
  }),
  worstPages: z.array(
    z.object({
      pageKey: z.string(),
      title: z.string().nullable(),
      seen: z.number(),
      interacted: z.number(),
      ratio: z.number(),
      verifiedFlows: z.number(),
    }),
  ),
  frontier: z.array(
    z.object({
      pageKey: z.string(),
      seenOnPage: z.string().nullable(),
      firstSeen: z.string(),
    }),
  ),
});

export type CoverageReport = z.infer<typeof coverageSchema>;

export function coverageReport(db: MemoryDb): CoverageReport {
  const c = counts(db);
  const frontierOpen = openFrontier(db);
  const perPage = pageCoverage(db);

  const seen = perPage.reduce((n, p) => n + p.seen, 0);
  const interacted = perPage.reduce((n, p) => n + p.interacted, 0);

  const byStatus = (status: string) =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM flows WHERE status = ?").get(status) as { n: number }
    ).n;

  return {
    generatedAt: isoNow(),
    note: COVERAGE_CAVEAT,
    pages: {
      known: c.pages + frontierOpen.length,
      visited: c.pages,
      frontier: frontierOpen.length,
    },
    elements: {
      seen,
      interacted,
      ratio: seen === 0 ? 1 : interacted / seen,
    },
    flows: {
      total: c.flows,
      verified: byStatus("verified"),
      draft: byStatus("draft"),
      broken: byStatus("broken"),
    },
    // Worst first: the list exists to say where to look next, so a page with
    // everything already exercised has no business at the top of it.
    worstPages: perPage
      .slice()
      .sort((a, b) => a.ratio - b.ratio || b.seen - a.seen || a.page_key.localeCompare(b.page_key))
      .slice(0, WORST_PAGES)
      .map((p) => ({
        pageKey: p.page_key,
        title: p.title,
        seen: p.seen,
        interacted: p.interacted,
        ratio: p.ratio,
        verifiedFlows: p.flows,
      })),
    frontier: frontierOpen.slice(0, FRONTIER_SAMPLE).map((f) => ({
      pageKey: f.page_key,
      seenOnPage: f.seen_on_page,
      firstSeen: f.first_seen,
    })),
  };
}

export function asPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
