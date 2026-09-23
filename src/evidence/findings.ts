import type { Drained } from "../browser/collect.js";
import type { SecretStore } from "../model/redact.js";
import type { Finding, Oracle, Severity } from "../types.js";

export interface FindingInput {
  title: string;
  severity: Severity;
  oracle: Oracle;
  expected: string;
  actual: string;
  objectiveId?: string;
  steps: number[];
  screenshots: (string | undefined)[];
  evidence?: Drained;
}

/**
 * Hard Rule 8: every finding carries the oracle that fired and a confidence.
 * Hard oracles are high-confidence. `llm_judgment` is always low. `performance`
 * is low too: "this page was slow three times" is a smell, not a proof — the
 * machine, the network and the day all get a vote.
 */
export function confidenceFor(oracle: Oracle): "high" | "low" {
  return oracle === "llm_judgment" || oracle === "performance" ? "low" : "high";
}

export class FindingBuilder {
  private readonly findings: Finding[] = [];
  private readonly byKey = new Map<string, Finding>();
  private readonly occurrences = new Map<string, number>();

  /**
   * The store is not optional in practice: finding text comes from the model and
   * from the page (URLs can carry tokens), so every field is redacted on the way
   * in — this is the last boundary before the report (Hard Rule 2).
   */
  constructor(private readonly secrets?: SecretStore) {}

  private clean(text: string): string {
    return (this.secrets ? this.secrets.redact(text) : text).trim();
  }

  /** oracle + title identify a defect; the same one seen twice is one finding. */
  private key(input: FindingInput): string {
    return `${input.oracle}|${this.clean(input.title).toLowerCase()}`;
  }

  add(input: FindingInput): Finding {
    const existing = this.byKey.get(this.key(input));
    if (existing) {
      // Same defect again: merge the evidence instead of filing a second ticket.
      const seen = (this.occurrences.get(existing.id) ?? 1) + 1;
      this.occurrences.set(existing.id, seen);
      existing.steps = [...new Set([...existing.steps, ...input.steps])].sort((a, b) => a - b);
      for (const shot of input.screenshots) {
        if (shot && existing.screenshots.length < 4 && !existing.screenshots.includes(shot)) {
          existing.screenshots.push(shot);
        }
      }
      existing.actual = `${existing.actual.replace(/ \(seen \d+ times.*\)$/, "")} (seen ${seen} times during this session)`;
      return existing;
    }

    const finding: Finding = {
      id: `F-${String(this.findings.length + 1).padStart(3, "0")}`,
      title: this.clean(input.title),
      severity: input.severity,
      oracle: input.oracle,
      confidence: confidenceFor(input.oracle),
      expected: this.clean(input.expected),
      actual: this.clean(input.actual),
      ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
      steps: [...input.steps].sort((a, b) => a - b),
      screenshots: input.screenshots.filter((s): s is string => Boolean(s)),
      ...(input.evidence?.console.length ? { console: input.evidence.console.map((c) => this.clean(c)) } : {}),
      ...(input.evidence?.network.length ? { network: input.evidence.network.map((n) => this.clean(n)) } : {}),
    };
    this.findings.push(finding);
    this.byKey.set(this.key(input), finding);
    return finding;
  }

  all(): Finding[] {
    return this.findings;
  }

  get count(): number {
    return this.findings.length;
  }
}

/** Turn drained collector output into hard-oracle findings (one per signal). */
export function oracleFindingsFor(drained: Drained): {
  oracle: Oracle;
  title: string;
  severity: Severity;
  expected: string;
  actual: string;
}[] {
  const out: ReturnType<typeof oracleFindingsFor> = [];

  if (drained.crashed) {
    out.push({
      oracle: "crash",
      title: "Page crashed",
      severity: "high",
      expected: "The page stays responsive while the user interacts with it.",
      actual: "The browser reported the page as crashed.",
    });
  }

  const serverErrors = drained.network.filter((n) => / → 5\d\d$/.test(n));
  if (serverErrors.length) {
    out.push({
      oracle: "http_5xx",
      title: `Server error: ${firstUrl(serverErrors[0]!)}`,
      severity: "high",
      expected: "Requests triggered by this action succeed.",
      actual: `${serverErrors.length} request(s) returned a 5xx: ${serverErrors.join("; ")}`,
    });
  }

  const clientErrors = drained.network.filter((n) => / → 4\d\d$/.test(n));
  if (clientErrors.length) {
    out.push({
      oracle: "http_4xx_unexpected",
      title: `Unexpected ${statusOf(clientErrors[0]!)}: ${firstUrl(clientErrors[0]!)}`,
      severity: "medium",
      expected: "A user-triggered request resolves to a page or payload that exists.",
      actual: `${clientErrors.length} request(s) returned a 4xx: ${clientErrors.join("; ")}`,
    });
  }

  // Chromium logs "Failed to load resource" for every failed request. That line
  // is never independent evidence — it either duplicates a network finding or
  // duplicates a request we deliberately ignored (e.g. third-party telemetry).
  const consoleErrors = drained.console.filter((c) => !/Failed to load resource/i.test(c));

  if (consoleErrors.length) {
    out.push({
      oracle: "console_error",
      title: `Console error: ${summarise(consoleErrors[0]!)}`,
      severity: "medium",
      expected: "The page runs without logging errors to the console.",
      actual: consoleErrors.join("\n"),
    });
  }

  return out;
}

function firstUrl(entry: string): string {
  const m = /https?:\/\/\S+/.exec(entry);
  if (!m) return entry;
  try {
    const u = new URL(m[0]);
    return `${u.pathname}${u.search}` || u.host;
  } catch {
    return m[0];
  }
}

function statusOf(entry: string): string {
  return /→ (\d{3})$/.exec(entry)?.[1] ?? "4xx";
}

function summarise(entry: string): string {
  return entry.replace(/^console\.error:\s*/, "").slice(0, 80);
}
