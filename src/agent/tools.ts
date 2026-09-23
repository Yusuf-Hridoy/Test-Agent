import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { MAX_WAIT_MS } from "../browser/actions.js";

/**
 * The model's entire surface (brief §1.4). No tool has an `execute`: the harness
 * dispatches every call itself, one per turn, so budgets and guards always apply.
 */
export const magpieTools = {
  goto: tool({
    description:
      "Navigate to a URL inside the allowed scope. Relative paths are resolved against the current page.",
    inputSchema: z.object({ url: z.string().describe("absolute or site-relative URL") }),
  }),
  click: tool({
    description: "Click an element from the latest snapshot.",
    inputSchema: z.object({ id: z.string().describe("element id from the latest snapshot, e.g. e4") }),
  }),
  fill: tool({
    description: "Type text into an input or textarea from the latest snapshot (replaces its value).",
    inputSchema: z.object({
      id: z.string().describe("element id from the latest snapshot"),
      text: z.string(),
    }),
  }),
  select: tool({
    description: "Choose an option in a <select> from the latest snapshot.",
    inputSchema: z.object({
      id: z.string().describe("element id from the latest snapshot"),
      value: z.string().describe("the option's value or visible label"),
    }),
  }),
  press: tool({
    description: "Press a keyboard key, e.g. Enter, Tab, Escape, ArrowDown.",
    inputSchema: z.object({ key: z.string() }),
  }),
  wait: tool({
    description: "Wait for the page to settle. Use sparingly.",
    inputSchema: z.object({ ms: z.number().int().min(0).max(MAX_WAIT_MS) }),
  }),
  look: tool({
    description:
      "Take a screenshot of the current page; it is attached to your next message. Only when layout or visual state matters.",
    inputSchema: z.object({}),
  }),
  report_finding: tool({
    description:
      "Record a defect: observed behaviour contradicts what a reasonable user would expect, or contradicts the objective.",
    inputSchema: z.object({
      title: z.string().describe("one line, specific"),
      severity: z.enum(["high", "medium", "low"]),
      expected: z.string(),
      actual: z.string(),
    }),
  }),
  mark_objective: tool({
    description:
      "Finish the current objective: passed when it is demonstrably complete, blocked when you cannot proceed.",
    inputSchema: z.object({
      status: z.enum(["passed", "blocked"]),
      note: z.string().describe("what you verified, or why you are blocked"),
    }),
  }),
} satisfies ToolSet;

export type MagpieToolName = keyof typeof magpieTools;

export const BROWSER_TOOLS: MagpieToolName[] = ["goto", "click", "fill", "select", "press", "wait"];

export function isBrowserTool(name: string): boolean {
  return (BROWSER_TOOLS as string[]).includes(name);
}

/** Runtime shapes of the tool inputs, for the harness's dispatcher. */
export const toolInput = {
  goto: z.object({ url: z.string() }),
  click: z.object({ id: z.string() }),
  fill: z.object({ id: z.string(), text: z.string() }),
  select: z.object({ id: z.string(), value: z.string() }),
  press: z.object({ key: z.string() }),
  wait: z.object({ ms: z.number() }),
  look: z.object({}),
  report_finding: z.object({
    title: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    expected: z.string(),
    actual: z.string(),
  }),
  mark_objective: z.object({
    status: z.enum(["passed", "blocked"]),
    note: z.string().optional().default(""),
  }),
};
