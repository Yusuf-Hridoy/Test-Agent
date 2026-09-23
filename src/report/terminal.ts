import type { SessionResult } from "../types.js";
import { truncate } from "../util.js";

const ICON: Record<string, string> = {
  planned: "·",
  "in-progress": "…",
  passed: "✔",
  finding: "!",
  blocked: "✖",
};

/** Compact end-of-run summary. The absolute report path is always the last line. */
export function renderTerminalReport(args: {
  result: SessionResult;
  budgetSummary: string;
  providerSummary: string;
  htmlPath: string;
}): string {
  const { result } = args;
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);

  lines.push("");
  lines.push(`── ${result.status} ${"─".repeat(Math.max(0, 60 - result.status.length))}`);
  lines.push(`charter   ${truncate(result.charter, 68)}`);
  lines.push(`budget    ${args.budgetSummary}`);
  lines.push(`providers ${args.providerSummary}`);
  lines.push("");

  if (result.objectives.length) {
    lines.push("objectives");
    for (const o of result.objectives) {
      lines.push(
        `  ${ICON[o.status] ?? "?"} ${pad(o.id, 6)} ${pad(o.status, 12)} ${truncate(o.description, 52)}`,
      );
      if (o.note && o.status !== "passed") lines.push(`      ${truncate(o.note, 70)}`);
    }
    lines.push("");
  }

  if (result.findings.length) {
    lines.push(`findings (${result.findings.length})`);
    for (const f of result.findings) {
      lines.push(
        `  ${pad(f.id, 6)} ${pad(f.severity, 7)} ${pad(f.oracle, 20)} ${pad(f.confidence, 5)} ${truncate(f.title, 44)}`,
      );
    }
  } else {
    lines.push("findings  none");
  }

  if (result.observations.length) {
    lines.push("");
    lines.push("observations");
    for (const o of result.observations) {
      lines.push(`  ${pad(o.type, 22)} ${truncate(o.detail, 54)}`);
    }
  }

  lines.push("");
  lines.push(`report    ${args.htmlPath}`);
  return lines.join("\n");
}

/**
 * Plain fixed-width table for the memory/flows commands. No colour, no
 * dependency: output that survives a pipe into a ticket is worth more than
 * output that looks pretty in one terminal.
 */
export function renderTable(headers: string[], rows: string[][], indent = "  "): string {
  if (!rows.length) return `${indent}(none)`;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    indent +
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** End-of-suite summary for `magpie run --regress`. */
export function renderSuiteTerminal(
  result: import("../memory/regress.js").SuiteResult,
  htmlPath: string,
): string {
  const t = result.totals;
  const headline =
    result.environmentDown || t.untested
      ? "ENVIRONMENT DOWN"
      : t.failed || t.healed
        ? "REGRESSIONS"
        : t.refused
          ? "REFUSED"
          : "ALL PASS";
  const lines: string[] = ["", `── ${headline} ${"─".repeat(Math.max(0, 60 - headline.length))}`];
  lines.push(
    renderTable(
      ["OUTCOME", "FLOW", "STEPS", "TIME", "DETAIL"],
      result.flows.map((f) => [
        f.outcome + (f.failedAt !== undefined ? `@${f.failedAt}` : ""),
        truncate(f.slug, 40),
        `${f.stepsRun}/${f.stepsTotal}`,
        `${(f.durationMs / 1000).toFixed(1)}s`,
        truncate(f.reason ?? "", 46),
      ]),
    ),
  );
  lines.push("");
  lines.push(
    `totals    ${t.passed} passed · ${t.failed} failed · ${t.healed} healed · ` +
      `${t.refused} refused · ${t.skipped} skipped · ${t.untested} untested`,
  );
  lines.push(`LLM requests: ${result.healCalls}`);
  if (result.findings.length) {
    const fresh = result.findings.filter((f) => f.status === "NEW").length;
    lines.push(`findings  ${fresh} new · ${result.findings.length - fresh} known`);
    for (const f of result.findings) {
      lines.push(`  ${f.id} ${f.status.padEnd(5)} ${truncate(f.title, 60)}`);
    }
  }
  lines.push("");
  lines.push(`report    ${htmlPath}`);
  lines.push(`suite     ${result.reportDir}/suite.json`);
  return lines.join("\n");
}
