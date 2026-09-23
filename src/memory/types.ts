/**
 * Row shapes for the project memory database (PHASE-2-BRIEF §1.2).
 *
 * These deliberately live here rather than in src/types.ts: they are storage
 * rows, not the agent's domain model, and widening the core types file would
 * make every module that imports a Snapshot also carry SQL concerns.
 */

export type FlowStatus = "draft" | "verified" | "broken";

/** goto | click | fill | select | press — the replayable subset of the tools. */
export type FlowActionName = "goto" | "click" | "fill" | "select" | "press";

export const REPLAYABLE_ACTIONS: FlowActionName[] = [
  "goto",
  "click",
  "fill",
  "select",
  "press",
];

export function isReplayableAction(name: string): name is FlowActionName {
  return (REPLAYABLE_ACTIONS as string[]).includes(name);
}

/**
 * What a `fill`/`select` value becomes when the recorded value was a secret.
 * Hard Rule 2 extended: the literal never reaches the DB, and replay refuses to
 * guess at one (§1.4).
 */
export const SECRET_PLACEHOLDER = "{secret}";

export interface SessionRow {
  id: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  charter: string | null;
  report_dir: string;
  llm_requests: number;
}

export interface PageRow {
  id: number;
  page_key: string;
  sample_url: string;
  title: string | null;
  first_seen: string;
  last_seen: string;
  visit_count: number;
  elements_json: string | null;
}

export interface TransitionRow {
  from_page: number;
  to_page: number;
  action: string;
  count: number;
}

export interface FlowRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  origin_session: number | null;
  origin_objective: string | null;
  start_page_key: string;
  created_at: string;
  updated_at: string;
  last_replay_at: string | null;
  /** "pass" | "fail@<seq>" | null */
  last_replay_result: string | null;
}

export interface FlowStepRow {
  flow_id: number;
  seq: number;
  action: string;
  target_role: string | null;
  target_name: string | null;
  value: string | null;
  url_after: string | null;
  /**
   * 0-based position among the elements replay will match by role+name.
   * NULL on flows recorded before Phase 3 — those still fail on ambiguity.
   */
  target_nth: number | null;
}

export interface FindingRow {
  id: number;
  session_id: number;
  fid: string;
  title: string;
  severity: string;
  oracle: string;
  confidence: string;
  page_key: string | null;
  created_at: string;
  /** Identity of the DEFECT across sessions (§1.5), not of this sighting. */
  fingerprint: string | null;
  first_seen_session: number | null;
}

export interface ObservationRow {
  id: number;
  session_id: number;
  type: string;
  page_key: string | null;
  detail: string | null;
  created_at: string;
}

export interface HealEventRow {
  id: number;
  flow_id: number;
  seq: number;
  old_target: string;
  new_target: string;
  model_note: string | null;
  session_ref: string | null;
  created_at: string;
}

/** A flow plus its steps, which is how everything outside db.ts wants it. */
export interface StoredFlow extends FlowRow {
  steps: FlowStepRow[];
}
