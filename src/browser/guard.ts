import { minimatch } from "minimatch";
import type { ElementRef, MagpieConfig } from "../types.js";

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;
}

/** Globs are matched against "host/path" — no scheme, no query, no hash. */
export function scopeTarget(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
}

function matchesAny(target: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(target, g, { nocase: true }));
}

/**
 * Hard Rule 4: navigation must stay inside scope.include and out of scope.exclude.
 * `from` lets a relative URL be resolved against the current page.
 */
export function checkGoto(url: string, cfg: MagpieConfig, from?: string): GuardVerdict {
  let absolute: string;
  try {
    absolute = new URL(url, from ?? cfg.base_url).toString();
  } catch {
    return { allowed: false, reason: `"${url}" is not a usable URL` };
  }

  const protocol = new URL(absolute).protocol;
  if (!/^https?:$/.test(protocol)) {
    return { allowed: false, reason: `BLOCKED by scope guard: ${absolute} is not http(s)` };
  }

  const target = scopeTarget(absolute);
  if (cfg.scope.exclude.length && matchesAny(target, cfg.scope.exclude)) {
    return { allowed: false, reason: `BLOCKED by scope guard: ${absolute} is excluded from scope` };
  }
  if (!matchesAny(target, cfg.scope.include)) {
    return { allowed: false, reason: `BLOCKED by scope guard: ${absolute} outside allowed scope` };
  }
  return { allowed: true };
}

/**
 * Is this request URL part of the application under test? Used to decide whether
 * a failed request is evidence about the app or about somebody else's server.
 */
export function isUrlInScope(url: string, cfg: MagpieConfig): boolean {
  let target: string;
  try {
    target = scopeTarget(url);
  } catch {
    return false;
  }
  if (cfg.scope.exclude.length && matchesAny(target, cfg.scope.exclude)) return false;
  return matchesAny(target, cfg.scope.include);
}

/**
 * Hard Rule 4: refuse clicks on destructive/session-ending controls, matched
 * case-insensitively as a substring of the element's accessible name.
 */
export function checkClick(el: Pick<ElementRef, "name">, cfg: MagpieConfig): GuardVerdict {
  const name = (el.name ?? "").toLowerCase();
  if (!name) return { allowed: true };
  const hit = cfg.forbidden_elements.find((f) => f && name.includes(f.toLowerCase()));
  if (hit) {
    return { allowed: false, reason: `REFUSED: '${el.name}' matches forbidden element '${hit}'` };
  }
  return { allowed: true };
}
