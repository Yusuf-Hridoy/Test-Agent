import { hasMemory, highSeverityFindings, listFlows, topPages, type MemoryDb } from "./db.js";
import type { FlowRow } from "./types.js";
import { truncate } from "../util.js";

/** ~1200 tokens at the usual ~4 characters per token (brief §1.5). */
export const MEMORY_CONTEXT_MAX_CHARS = 4800;
const MAX_PAGES = 15;
const MAX_FLOWS = 15;
const MAX_FINDINGS = 5;

export const MEMORY_HEADING = "WHAT MAGPIE ALREADY KNOWS ABOUT THIS APPLICATION";

/**
 * A compact briefing on the application, assembled from previous sessions.
 *
 * Returns undefined when there is nothing to say, so a first run against a new
 * app sends exactly the prompt Phase 1 sent — memory must make later sessions
 * cheaper without changing what a first session does.
 */
export function buildMemoryContext(db: MemoryDb, charter: string): string | undefined {
  if (!hasMemory(db)) return undefined;

  const pages = topPages(db, MAX_PAGES);
  const flows = rankByCharter(listFlows(db, "verified"), charter).slice(0, MAX_FLOWS);
  const findings = highSeverityFindings(db, MAX_FINDINGS);
  if (!pages.length && !flows.length && !findings.length) return undefined;

  const sections: string[] = [
    MEMORY_HEADING,
    "(Recorded by previous sessions. Use it instead of re-discovering the app.)",
  ];

  if (pages.length) {
    sections.push("", "PAGES SEEN (most visited first):");
    for (const p of pages) {
      const title = p.title ? ` — ${truncate(p.title, 50)}` : "";
      sections.push(`  ${truncate(p.page_key, 70)}${title}`);
    }
  }

  if (flows.length) {
    sections.push(
      "",
      "FLOWS ALREADY VERIFIED (each replays deterministically at no cost):",
    );
    for (const f of flows) sections.push(`  ${f.slug} — ${truncate(f.name, 60)}`);
  }

  if (findings.length) {
    sections.push("", "KNOWN HIGH-SEVERITY FINDINGS:");
    for (const f of findings) {
      const where = f.page_key ? ` (${truncate(f.page_key, 40)})` : "";
      sections.push(`  ${truncate(f.title, 70)}${where}`);
    }
  }

  return capLines(sections, MEMORY_CONTEXT_MAX_CHARS);
}

/**
 * Flows the charter actually talks about come first, so the cap keeps the ones
 * that matter to this run rather than whichever sorted first alphabetically.
 */
export function rankByCharter(flows: FlowRow[], charter: string): FlowRow[] {
  const words = new Set(
    (charter ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
  if (!words.size) return flows;
  const score = (f: FlowRow): number => {
    const haystack = `${f.slug} ${f.name} ${f.description ?? ""}`.toLowerCase();
    let n = 0;
    for (const w of words) if (haystack.includes(w)) n++;
    return n;
  };
  return [...flows]
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}

/** Drop whole lines from the tail until the block fits its character budget. */
function capLines(lines: string[], limit: number): string {
  const kept = [...lines];
  while (kept.length > 2 && kept.join("\n").length > limit) kept.pop();
  const text = kept.join("\n");
  return text.length <= limit ? text : text.slice(0, limit);
}
