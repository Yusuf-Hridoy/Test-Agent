/**
 * URL → page_key (PHASE-2-BRIEF §1.3).
 *
 * The app map must stay finite on applications with per-entity URLs: without
 * parameterization, a shop with 10 000 products would grow 10 000 page rows
 * that say the same thing. Query strings and fragments are dropped for the same
 * reason — they are state, not identity.
 */

/** 8-4-4-4-12 hex, the canonical UUID spelling. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURELY_NUMERIC = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const BASE64ISH = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Is this path segment an entity id rather than a name?
 *
 * The base64-ish rule deliberately also demands a digit AND an uppercase
 * letter: without that, ordinary long slugs ("add-cheapest-item-to-cart",
 * "2026-09-18-release-notes") would collapse to `:id` and the map would lose
 * the pages a tester actually cares about. Real opaque ids — ULIDs, Stripe-style
 * keys, base64url tokens — carry both.
 */
export function isIdSegment(segment: string): boolean {
  if (PURELY_NUMERIC.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (LONG_HEX.test(segment)) return true;
  if (BASE64ISH.test(segment) && /\d/.test(segment) && /[A-Z]/.test(segment)) return true;
  return false;
}

/**
 * Normalize a URL to `host/path`, lowercased, ids parameterized.
 * Anything that is not an http(s) URL (about:blank, chrome-error://…) is
 * returned in a stable lowercased form so the caller never has to special-case
 * it — a browser error page is a page we saw, even if it is not the app's.
 */
export function normalizePageKey(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    const authority = u.host ? `//${u.host}` : "";
    return `${u.protocol}${authority}${u.pathname}`.toLowerCase();
  }

  // `host` keeps the port: two apps served on different ports of the same
  // machine are different applications, and merging them would be a lie.
  const host = u.host.toLowerCase();
  const segments = u.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => (isIdSegment(segment) ? ":id" : decodeSafely(segment).toLowerCase()));

  return segments.length ? `${host}/${segments.join("/")}` : `${host}/`;
}

/** A malformed %-escape must not throw away the whole page key. */
function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Human-facing short form used by the CLI tables, e.g. `/item/:id`. */
export function pathOfKey(pageKey: string): string {
  const slash = pageKey.indexOf("/");
  return slash < 0 ? pageKey : pageKey.slice(slash) || "/";
}
