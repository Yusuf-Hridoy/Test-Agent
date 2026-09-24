/**
 * Magpie core types — PHASE-1-BRIEF §1.3.
 * Every other module imports shapes from here; nothing redefines them locally.
 */

export type Provider = "gemini" | "groq" | "mistral";

export interface MagpieConfig {
  name: string;
  base_url: string;
  auth: {
    strategy: "manual" | "form-login";
    login_url?: string;
    user_env: string;
    pass_env: string;
  };
  scope: { include: string[]; exclude: string[] };
  forbidden_elements: string[];
  budget: { max_steps: number; max_llm_requests: number; max_minutes: number };
  model: {
    primary: Provider;
    fallback: Provider[];
    min_delay_ms: number;
    ids?: Partial<Record<Provider, string>>;
  };
  run: { headed: boolean; slow_network_grace_ms: number };
  /** Regression mode (Phase 3). Healing is off unless asked for. */
  regress: { heal: boolean; max_heal_calls: number };
}

export interface ElementRef {
  id: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  disabled?: boolean;
}

/** pageText is truncated to 2000 chars by the snapshotter. */
export interface Snapshot {
  url: string;
  title: string;
  elements: ElementRef[];
  pageText: string;
}

export type StepActor = "model" | "harness";

export interface StepRecord {
  n: number;
  t: string; // ISO-8601 with timezone
  actor: StepActor;
  action: string;
  args: unknown; // redacted before it is written
  result: { ok: boolean; detail?: string };
  url: string;
  fingerprint: string;
}

export type Oracle =
  | "console_error"
  | "http_5xx"
  | "http_4xx_unexpected"
  | "crash"
  | "llm_judgment"
  /** A flow that used to pass no longer does (Phase 3). */
  | "regression"
  /** The same page has needed extra time to respond across several sessions. */
  | "performance";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string; // F-001…
  title: string;
  severity: Severity;
  oracle: Oracle;
  confidence: "high" | "low"; // hard oracle → high, llm_judgment → low
  expected: string;
  actual: string;
  objectiveId?: string;
  steps: number[]; // step ns for repro
  screenshots: string[]; // paths relative to the report dir
  console?: string[];
  network?: string[];
  /**
   * What project memory knows about this defect (Phase 3). Absent when the
   * session was not ingested — a report never claims history it does not have.
   */
  memory?: {
    status: "NEW" | "KNOWN";
    /** How many sessions have reported this same defect, including this one. */
    seenCount: number;
    firstSeenAt?: string;
  };
}

export type Technique =
  | "happy-path"
  | "boundary"
  | "required-field"
  | "invalid-input"
  | "cancel-midway"
  | "duplicate"
  | "state-transition";

export interface Objective {
  id: string; // O-01…
  description: string;
  technique: Technique;
  status: "planned" | "in-progress" | "passed" | "finding" | "blocked";
  note?: string;
}

export type SessionStatus =
  | "COMPLETED"
  | "BUDGET_EXHAUSTED"
  | "ENVIRONMENT_DOWN"
  | "PLAN_FAILED"
  | "CRASHED"
  | "AUTH_REQUIRED";

export interface ProviderUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionResult {
  status: string;
  startedAt: string;
  endedAt: string;
  charter: string;
  objectives: Objective[];
  findings: Finding[];
  /** `pageKey` is set when the observation is about one page (Phase 3 oracles). */
  observations: { type: string; detail: string; pageKey?: string }[];
  usage: Record<Provider, ProviderUsage>;
  stepCount: number;
  reportDir: string;
}

export const PROVIDERS: Provider[] = ["gemini", "groq", "mistral"];
