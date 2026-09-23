import { z } from "zod";
import type { MagpieConfig, Objective, Snapshot } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import type { UsageTracker } from "../model/usage.js";
import { askModel, type GenerateFn } from "../model/ask.js";
import { PLANNER_SYSTEM_PROMPT, plannerUserMessage } from "./prompts.js";

const MIN_OBJECTIVES = 5;
const MAX_OBJECTIVES = 15;

const objectiveSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(3),
  technique: z.enum([
    "happy-path",
    "boundary",
    "required-field",
    "invalid-input",
    "cancel-midway",
    "duplicate",
    "state-transition",
  ]),
});

const planSchema = z.array(objectiveSchema).min(MIN_OBJECTIVES).max(MAX_OBJECTIVES);

export class PlanFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanFailedError";
  }
}

/** Models like to wrap JSON in prose or fences; take the outermost array. */
export function extractJsonArray(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array found in the reply");
  return body.slice(start, end + 1);
}

export function parsePlan(text: string): Objective[] {
  const parsed: unknown = JSON.parse(extractJsonArray(text));
  const objectives = planSchema.parse(parsed);
  // Renumber unless every id is already well-formed AND unique — duplicate ids
  // would make findings and flows point at the wrong objective.
  const ids = objectives.map((o) => o.id);
  const usable = ids.every((id) => /^O-\d+$/.test(id)) && new Set(ids).size === ids.length;
  return objectives.map((o, i) => ({
    id: usable ? o.id : `O-${String(i + 1).padStart(2, "0")}`,
    description: o.description,
    technique: o.technique,
    status: "planned" as const,
  }));
}

/**
 * One planning call (a second only if the first reply will not parse).
 * Two failures → PLAN_FAILED (brief §1.1).
 */
export async function planSession(args: {
  charter: string;
  snapshot: Snapshot;
  cfg: MagpieConfig;
  usage: UsageTracker;
  secrets: SecretStore;
  log?: (line: string) => void;
  /** App briefing from project memory (Phase 2); absent on a first run. */
  memory?: string;
  /** Test seam, mirroring askModel's. */
  generate?: GenerateFn;
}): Promise<Objective[]> {
  const { charter, snapshot, cfg, usage, secrets } = args;
  const log = args.log ?? (() => {});
  const messages = [
    { role: "user" as const, content: plannerUserMessage(charter, snapshot, args.memory) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await askModel(
      { system: PLANNER_SYSTEM_PROMPT, messages, tools: {} },
      cfg,
      usage,
      secrets,
      args.generate,
    );
    try {
      const plan = parsePlan(res.text);
      log(`planned ${plan.length} objectives via ${res.provider}`);
      return plan;
    } catch (err) {
      const reason = err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : (err as Error).message;
      if (attempt === 1) {
        throw new PlanFailedError(
          `the planner did not return a usable plan after two attempts: ${reason}`,
        );
      }
      log(`plan reply unusable (${reason}) — asking once more`);
      messages.push({ role: "assistant", content: res.text } as never);
      messages.push({
        role: "user",
        content:
          `That reply could not be used: ${reason}\n` +
          `Answer again with STRICT JSON ONLY — an array of ${MIN_OBJECTIVES}-${MAX_OBJECTIVES} ` +
          `objects with keys id, description, technique. No prose, no code fences.`,
      } as never);
    }
  }
  throw new PlanFailedError("unreachable");
}
