import { z } from "zod";
import type { MagpieConfig, Objective, Snapshot, Technique } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import type { UsageTracker } from "../model/usage.js";
import { askModel, type GenerateFn } from "../model/ask.js";
import { EXPLORER_SYSTEM_PROMPT, explorerUserMessage } from "./prompts.js";
import { extractJsonArray } from "./plan.js";

const TECHNIQUES = [
  "happy-path",
  "boundary",
  "required-field",
  "invalid-input",
  "cancel-midway",
  "duplicate",
  "state-transition",
] as const;

const generatedSchema = z.array(
  z.object({
    description: z.string().min(3),
    technique: z.enum(TECHNIQUES),
  }),
);

export interface GeneratedObjective {
  description: string;
  technique: Technique;
}

export function parseGenerated(text: string, max: number): GeneratedObjective[] {
  // An empty array is a legitimate answer ("nothing here is worth testing"), and
  // extractJsonArray handles "[]" fine.
  const parsed: unknown = JSON.parse(extractJsonArray(text));
  return generatedSchema.parse(parsed).slice(0, max);
}

/**
 * Objectives for one page (PHASE-4-BRIEF §1.3) — one model call.
 *
 * Unlike planning, a failure here is not fatal: this is one page of many, so an
 * unusable reply costs that page its turn and the session moves on. Killing the
 * whole crawl because a single generation came back malformed would throw away
 * every page already explored.
 */
export async function generateObjectives(args: {
  snapshot: Snapshot;
  untouched: { role: string; name: string }[];
  covered: string[];
  cfg: MagpieConfig;
  usage: UsageTracker;
  secrets: SecretStore;
  /** Objective numbering continues across pages, so ids stay unique. */
  startIndex: number;
  pageKey: string;
  log?: (line: string) => void;
  generate?: GenerateFn;
}): Promise<{ objectives: Objective[]; problem?: string }> {
  const max = args.cfg.explore.max_objectives_per_page;
  const log = args.log ?? (() => {});

  const res = await askModel(
    {
      system: EXPLORER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: explorerUserMessage({
            snapshot: args.snapshot,
            untouched: args.untouched,
            covered: args.covered,
            max,
          }),
        },
      ],
      tools: {},
    },
    args.cfg,
    args.usage,
    args.secrets,
    args.generate,
  );

  let generated: GeneratedObjective[];
  try {
    generated = parseGenerated(res.text, max);
  } catch (err) {
    const reason =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : (err as Error).message;
    log(`  could not read the objectives for this page (${reason}) — moving on`);
    return { objectives: [], problem: reason };
  }

  const objectives = generated.map((g, i) => ({
    id: `O-${String(args.startIndex + i + 1).padStart(2, "0")}`,
    description: g.description,
    technique: g.technique,
    status: "planned" as const,
    page: args.pageKey,
  }));
  log(`  ${objectives.length} objective(s) for this page via ${res.provider}`);
  return { objectives };
}
