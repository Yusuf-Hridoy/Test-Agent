import { z } from "zod";
import type { MagpieConfig, Snapshot } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import type { UsageTracker } from "../model/usage.js";
import { askModel, ModelExhaustedError, type GenerateFn } from "../model/ask.js";
import { HEAL_SYSTEM_PROMPT, healUserMessage } from "../agent/prompts.js";
import { truncate } from "../util.js";
import { SECRET_PLACEHOLDER, type FlowStepRow } from "./types.js";

export interface HealTarget {
  role: string;
  name: string;
  nth: number | null;
}

export type HealVerdict =
  | { verdict: "relocated"; target: HealTarget; note: string }
  | { verdict: "broken"; note: string }
  /** No opinion: the budget is spent, or no provider answered. */
  | { verdict: "unavailable"; note: string };

export interface HealRequest {
  flowName: string;
  flowDescription: string | null;
  step: FlowStepRow;
  reason: string;
  snapshot: Snapshot;
}

export type Healer = (req: HealRequest) => Promise<HealVerdict>;

const verdictSchema = z.union([
  z.object({
    verdict: z.literal("relocated"),
    target: z.object({
      role: z.string().min(1),
      name: z.string().min(1),
      nth: z.number().int().nonnegative().nullish(),
    }),
    note: z.string().optional(),
  }),
  z.object({ verdict: z.literal("broken"), note: z.string().optional() }),
]);

/** Models like to wrap JSON in prose or fences; take the outermost object. */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in the reply");
  return body.slice(start, end + 1);
}

export function parseVerdict(text: string): HealVerdict {
  const parsed = verdictSchema.parse(JSON.parse(extractJsonObject(text)));
  if (parsed.verdict === "broken") {
    return { verdict: "broken", note: parsed.note ?? "the model reported the flow as broken" };
  }
  return {
    verdict: "relocated",
    target: {
      role: parsed.target.role,
      name: parsed.target.name,
      nth: parsed.target.nth ?? null,
    },
    note: parsed.note ?? "relocated by the model",
  };
}

export interface HealerOptions {
  cfg: MagpieConfig;
  usage: UsageTracker;
  secrets: SecretStore;
  /** Total heal calls allowed across the whole suite. */
  maxCalls: number;
  log?: (line: string) => void;
  /** Test seam, mirroring askModel's. */
  generate?: GenerateFn;
}

export interface HealerHandle {
  heal: Healer;
  /** How many model calls healing has actually spent. */
  readonly calls: number;
}

/**
 * A bounded, single-shot healer.
 *
 * One call per failed step and never a second opinion on the same one: a model
 * asked twice will eventually find something to click, and "eventually found
 * something" is exactly the failure mode that makes a green regression suite
 * worthless.
 */
export function createHealer(opts: HealerOptions): HealerHandle {
  let calls = 0;
  const log = opts.log ?? (() => {});

  const heal: Healer = async (req) => {
    if (calls >= opts.maxCalls) {
      return {
        verdict: "unavailable",
        note: `healing budget spent (${opts.maxCalls} call(s) allowed by regress.max_heal_calls)`,
      };
    }
    calls++;

    // Hard Rule 2: a secret never reaches a provider, not even as context.
    const value =
      req.step.value === SECRET_PLACEHOLDER
        ? SECRET_PLACEHOLDER
        : req.step.value === null
          ? null
          : opts.secrets.redact(req.step.value);

    let text: string;
    try {
      const res = await askModel(
        {
          system: HEAL_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: healUserMessage({
                flowName: req.flowName,
                flowDescription: req.flowDescription,
                seq: req.step.seq,
                action: req.step.action,
                oldRole: req.step.target_role,
                oldName: req.step.target_name,
                oldNth: req.step.target_nth,
                value,
                reason: req.reason,
                snapshot: req.snapshot,
              }),
            },
          ],
          tools: {},
        },
        opts.cfg,
        opts.usage,
        opts.secrets,
        opts.generate,
      );
      text = res.text;
    } catch (err) {
      const why = err instanceof ModelExhaustedError ? err.message : String(err);
      log(`  healer unavailable: ${truncate(why, 120)}`);
      return { verdict: "unavailable", note: `no model answered: ${truncate(why, 200)}` };
    }

    try {
      const verdict = parseVerdict(text);
      log(
        verdict.verdict === "relocated"
          ? `  healer suggests role=${verdict.target.role} "${truncate(verdict.target.name, 40)}"`
          : `  healer says the flow is broken: ${truncate(verdict.note, 80)}`,
      );
      return verdict;
    } catch (err) {
      // An unparseable answer is no answer. Asking again would be the second
      // opinion this healer exists to refuse.
      log(`  healer reply was unusable: ${truncate((err as Error).message, 100)}`);
      return { verdict: "unavailable", note: `the healer's reply could not be used: ${(err as Error).message}` };
    }
  };

  return {
    heal,
    get calls() {
      return calls;
    },
  };
}
