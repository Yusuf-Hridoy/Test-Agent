import { createHash } from "node:crypto";

/**
 * The identity of a DEFECT across sessions (PHASE-3-BRIEF §1.5).
 *
 * Not the identity of a sighting: the same broken endpoint seen on Monday and
 * on Friday is one defect seen twice. Digits and ids are stripped from the
 * title because a message like "Server error: /api/cart/4711" names a different
 * cart every night while describing the same bug.
 */
export function normalizeTitle(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "") // hex ids
    .replace(/\d+/g, "") // any remaining numbers
    .replace(/[^a-z/:._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintOf(title: string, pageKey: string | null, oracle: string): string {
  return createHash("sha1")
    .update(`${normalizeTitle(title)}|${pageKey ?? ""}|${oracle}`)
    .digest("hex");
}
