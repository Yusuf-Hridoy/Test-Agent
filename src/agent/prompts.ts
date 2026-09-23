import type { CoreMessage } from "ai";
import type { Objective, Snapshot } from "../types.js";
import { renderSnapshot } from "../browser/snapshot.js";

/** Executor system prompt — kept verbatim from PHASE-1-BRIEF §P1-T6. */
export function executorSystemPrompt(args: {
  objective: string;
  stepsLeft: number;
  llmLeft: number;
}): string {
  return `You are Magpie, a meticulous senior QA engineer executing ONE test objective
against a live web application. You control the browser only through the
provided tools.

Context you receive each turn: the current objective, the latest page snapshot
(url, title, interactive elements with ids, page text), results of your
previous tool calls, and occasionally a screenshot you requested via \`look\`.

Rules:
1. Work ONLY on the current objective: ${args.objective}. When it is demonstrably
   complete, call mark_objective(status:"passed"). If you cannot proceed after
   trying reasonable alternatives, call mark_objective(status:"blocked", note).
2. Interact only with element ids from the LATEST snapshot.
3. One tool call per turn. Prefer snapshot text over \`look\`; use \`look\` only
   when layout/visual state matters.
4. Call report_finding when observed behavior contradicts expected behavior a
   reasonable user would assume, or contradicts the objective's expectation.
   Be precise in expected vs actual. Do not report styling nitpicks.
5. Never attempt: logout, deletion of accounts/data, payments, or navigation
   outside the allowed scope. Such calls will be refused by the system.
6. If a tool result says you are stuck or an element is missing, change
   strategy: navigate elsewhere, or block the objective with a clear note.
7. Budget remaining: ${args.stepsLeft} steps, ${args.llmLeft} model calls. Be economical.`;
}

export const PLANNER_SYSTEM_PROMPT = `You are Magpie's test planner: a senior QA lead who turns a testing charter
into a short, concrete plan for a web application.

You will receive the charter and a snapshot of the application's landing page.
Produce test objectives that a browser-driving agent can execute one at a time.

Rules:
- EVERY explicit requirement in the charter must appear as an objective, even if
  the application looks incapable of it. Never silently replace an impossible
  requirement with an achievable one: an objective that turns out to be
  impossible gets marked blocked with a reason, which is a useful test result.
  Quietly testing something easier produces a green report for work nobody did.
- Cover the charter first; add adjacent risk only where the charter implies it.
- Each objective is ONE verifiable outcome, phrased so success or failure is
  obvious from the screen (e.g. "Cart badge shows 1 after adding an item").
- Order them so earlier objectives set up later ones.
- Do not invent objectives that log out, delete accounts or make real payments.
  If the charter explicitly asks for one, include it anyway and let the harness
  refuse the unsafe action — safety is enforced by the system, not by leaving
  the objective out of the plan.
- Choose the technique that matches what the objective actually exercises.

Answer with STRICT JSON ONLY: an array of 5 to 15 objects, no prose, no code
fences, shaped exactly:
[{"id":"O-01","description":"...","technique":"happy-path"}]

technique must be one of: happy-path, boundary, required-field, invalid-input,
cancel-midway, duplicate, state-transition.`;

export function plannerUserMessage(charter: string, snap: Snapshot): string {
  return [
    `CHARTER: ${charter}`,
    ``,
    `LANDING PAGE SNAPSHOT:`,
    renderSnapshot(snap),
  ].join("\n");
}

/** Approximate token budget for one executor turn (brief §3). */
const MAX_PROMPT_CHARS = 32_000;
const TOOL_HISTORY = 6;

export interface TurnInput {
  objective: Objective;
  snapshot: Snapshot;
  /** One line per recent tool call/result pair, oldest first. */
  history: string[];
  /** Harness oracle notes raised since the last turn. */
  oracleNotes: string[];
  /** Base64 PNG requested via `look`, consumed by exactly one turn. */
  pendingScreenshot?: string;
  /** Extra harness instruction, e.g. the plain-text stall nudge. */
  systemNote?: string;
}

/**
 * Message window for one executor turn. Only the LATEST snapshot is included —
 * accumulating snapshots is the context-explosion killer (brief §3).
 */
export function buildExecutorMessages(input: TurnInput): CoreMessage[] {
  const history = input.history.slice(-TOOL_HISTORY);
  const sections = [
    `CURRENT OBJECTIVE ${input.objective.id} (${input.objective.technique}): ${input.objective.description}`,
    ``,
    `LATEST PAGE SNAPSHOT:`,
    capSnapshot(renderSnapshot(input.snapshot), MAX_PROMPT_CHARS - overheadOf(input)),
  ];

  if (history.length) {
    sections.push(``, `YOUR RECENT ACTIONS:`, ...history.map((h) => `- ${h}`));
  }
  for (const note of input.oracleNotes) {
    sections.push(``, `SYSTEM ORACLE NOTE: ${note}`);
  }
  if (input.systemNote) sections.push(``, input.systemNote);
  sections.push(``, `Take the single next action for this objective.`);

  const text = sections.join("\n");
  if (!input.pendingScreenshot) return [{ role: "user", content: text }];
  return [
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", image: input.pendingScreenshot },
      ],
    },
  ];
}

function overheadOf(input: TurnInput): number {
  const extras =
    input.history.join("\n").length +
    input.oracleNotes.join("\n").length +
    (input.systemNote?.length ?? 0) +
    input.objective.description.length;
  return Math.min(extras + 500, MAX_PROMPT_CHARS / 2);
}

/**
 * Keep a rendered snapshot under budget: drop page text first, then the tail of
 * the element list (the least-visible elements sort last).
 */
export function capSnapshot(rendered: string, limit: number): string {
  if (rendered.length <= limit) return rendered;

  const marker = "\nPAGE TEXT:\n";
  const cut = rendered.indexOf(marker);
  if (cut >= 0) {
    const head = rendered.slice(0, cut);
    const body = rendered.slice(cut + marker.length);
    const room = limit - head.length - marker.length;
    if (room > 200) {
      return `${head}${marker}${body.slice(0, room)}\n[page text truncated]`;
    }
    rendered = `${head}${marker}[page text omitted to fit the context budget]`;
    if (rendered.length <= limit) return rendered;
  }

  const lines = rendered.split("\n");
  while (lines.length > 8 && lines.join("\n").length > limit) {
    // Drop from the tail of the element list, which is sorted least-visible last.
    const lastElement = lines.findLastIndex((l) => /^ {2}e\d+ /.test(l));
    if (lastElement < 0) break;
    lines.splice(lastElement, 1);
  }
  lines.push("[element list truncated to fit the context budget]");
  return lines.join("\n").slice(0, limit);
}
