export const REDACTED = "«redacted»";

/**
 * Keys whose value on the same line is masked wholesale. The key must be
 * followed by an assignment (`:` or `=`, optionally quoted) — matching a bare
 * space too, as first drafted, truncated ordinary prose like "no valid session —
 * run `magpie login`" and made reports unreadable without protecting anything
 * extra: literal secret values are always masked by the secrets pass above.
 */
const SENSITIVE_KEY = /(cookie|token|authorization|password|secret|session)["']?\s*[:=]/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hard Rule 2: nothing secret reaches a provider.
 * (a) every known secret string is masked wherever it appears;
 * (b) on any line where a sensitive key appears, the value after it is masked.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;

  for (const secret of secrets) {
    const s = secret?.trim();
    if (!s || s.length < 4) continue; // too short to mask without wrecking the text
    out = out.replace(new RegExp(escapeRegExp(s), "g"), REDACTED);
  }

  out = out
    .split("\n")
    .map((line) => {
      const m = SENSITIVE_KEY.exec(line);
      if (!m) return line;
      // Mask from just after the key's delimiter to the end of the line.
      const valueStart = m.index + m[0].length;
      const head = line.slice(0, valueStart);
      const tail = line.slice(valueStart);
      if (!tail.trim()) return line;
      const leading = tail.match(/^\s*/)?.[0] ?? "";
      return head + leading + REDACTED;
    })
    .join("\n");

  return out;
}

/**
 * Redact the string leaves of a value, leaving structure intact.
 *
 * Never run `redact()` over serialized JSON: the sensitive-key rule masks to the
 * end of the line, which eats the closing quote and comma of any string holding
 * `token=…` and produces a file nothing can parse. Redact the values, then
 * serialize.
 */
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return redact(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, secrets)]),
    ) as T;
  }
  return value;
}

/** Runtime-growing secret set: .env values plus every password typed into a form. */
export class SecretStore {
  private readonly secrets = new Set<string>();

  constructor(initial: string[] = []) {
    for (const s of initial) this.add(s);
  }

  add(secret: string | undefined | null): void {
    const s = secret?.trim();
    if (s && s.length >= 4) this.secrets.add(s);
  }

  all(): string[] {
    // Longest first so a secret containing another is masked whole.
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    return redact(text, this.all());
  }

  /** Structure-preserving redaction for anything about to be serialized. */
  redactDeep<T>(value: T): T {
    return redactDeep(value, this.all());
  }
}
