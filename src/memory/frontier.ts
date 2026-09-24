import type { MagpieConfig } from "../types.js";
import { isUrlInScope } from "../browser/guard.js";
import { normalizePageKey } from "./pagekey.js";
import { openFrontier, pageCoverage, type MemoryDb } from "./db.js";

export interface QueueEntry {
  url: string;
  pageKey: string;
  /** Why the explorer is going here — shown in the narration and the report. */
  reason: "frontier" | "under-covered" | "base";
}

/**
 * Where should an exploratory session go, in what order? (PHASE-4-BRIEF §1.3)
 *
 * Deterministic and model-free on purpose: the decision about *where* to look
 * is a question about what memory already holds, and answering it with plain
 * code keeps every model call for the question code cannot answer — what is
 * worth testing on the page once we are there.
 */
export function buildSeedQueue(db: MemoryDb, cfg: MagpieConfig): QueueEntry[] {
  const queue: QueueEntry[] = [];
  const seen = new Set<string>();

  const push = (url: string, reason: QueueEntry["reason"]) => {
    if (!isUrlInScope(url, cfg)) return;
    const pageKey = normalizePageKey(url);
    if (!pageKey || seen.has(pageKey)) return;
    seen.add(pageKey);
    queue.push({ url, pageKey, reason });
  };

  // 1. The frontier, oldest first: pages the app itself told us about and
  //    nobody has opened. Capped, because a big app's frontier is endless and
  //    a session that only ever opens new pages never tests any of them.
  for (const row of openFrontier(db, cfg.explore.max_new_pages)) {
    push(row.sample_url, "frontier");
  }

  // 2. Known pages, least-exercised first. A page whose every element has been
  //    used has nothing left to offer, so it is left out rather than queued
  //    behind the ones that do.
  const underCovered = pageCoverage(db)
    .filter((p) => p.ratio < 1)
    .sort((a, b) => a.ratio - b.ratio || a.page_key.localeCompare(b.page_key));
  for (const page of underCovered) {
    const sample = db
      .prepare("SELECT sample_url FROM pages WHERE page_key = ?")
      .get(page.page_key) as { sample_url: string } | undefined;
    if (sample) push(sample.sample_url, "under-covered");
  }

  // 3. A project with no memory has exactly one place to start.
  if (!queue.length) push(cfg.base_url, "base");
  return queue;
}

/**
 * Elements on this page that nothing has ever interacted with — the gap the
 * generated objectives are meant to close.
 */
export function untouchedElementsOn(
  db: MemoryDb,
  pageKey: string,
  limit = 25,
): { role: string; name: string }[] {
  return db
    .prepare(
      `SELECT role, name FROM element_seen
       WHERE page_key = ? AND interactions = 0
       ORDER BY first_seen, role, name LIMIT ?`,
    )
    .all(pageKey, limit) as { role: string; name: string }[];
}

/**
 * Names of verified flows that already exercise this page. Explore is told to
 * avoid them: re-testing ground a deterministic replay already covers spends
 * model calls to learn nothing.
 */
export function verifiedFlowsTouching(db: MemoryDb, pageKey: string, limit = 10): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT f.name AS name
         FROM flows f JOIN flow_steps s ON s.flow_id = f.id
         WHERE f.status = 'verified' AND (s.url_after = ? OR f.start_page_key = ?)
         ORDER BY f.name LIMIT ?`,
      )
      .all(pageKey, pageKey, limit) as { name: string }[]
  ).map((r) => r.name);
}
