import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, truncate } from "../util.js";
import { MAGPIE_VERSION } from "../version.js";
import type { SuiteFinding, SuiteResult } from "../memory/regress.js";

/**
 * The suite report reuses templates/report.html rather than shipping a second
 * copy of the same stylesheet — one place to change how a Magpie report looks.
 * The slots are generic containers; only what goes in them differs.
 */
const TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "report.html",
);

const OUTCOME_CLASS: Record<string, string> = {
  PASS: "ok",
  FAIL: "bad",
  REFUSED: "muted",
  HEALED: "warn",
  SKIPPED: "muted",
  UNTESTED: "muted",
};

export function writeSuiteReport(result: SuiteResult): string {
  const out = path.join(result.reportDir, "index.html");
  fs.writeFileSync(out, renderSuiteReport(result));
  return out;
}

export function renderSuiteReport(result: SuiteResult): string {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  return template
    .replace("{{TITLE}}", escapeHtml(`Magpie regression — ${result.project}`))
    .replace("{{HEADER}}", header(result))
    .replace("{{PLAN}}", flowTable(result))
    .replace("{{FINDINGS}}", findingSections(result))
    .replace("{{OBSERVATIONS}}", "")
    .replace("{{SCREENSHOTS}}", "")
    .replace("{{TIMELINE}}", "")
    .replace("{{FOOTER}}", footer(result));
}

function verdict(result: SuiteResult): { label: string; cls: string } {
  if (result.environmentDown || result.totals.untested) {
    return { label: "ENVIRONMENT DOWN", cls: "ENVIRONMENT_DOWN" };
  }
  if (result.totals.failed || result.totals.healed) return { label: "REGRESSIONS", cls: "CRASHED" };
  if (result.totals.refused) return { label: "REFUSED", cls: "AUTH_REQUIRED" };
  return { label: "ALL PASS", cls: "COMPLETED" };
}

function header(result: SuiteResult): string {
  const v = verdict(result);
  const t = result.totals;
  const chips = [
    `${t.passed} passed`,
    t.failed ? `${t.failed} failed` : "",
    t.healed ? `${t.healed} healed` : "",
    t.refused ? `${t.refused} refused` : "",
    t.skipped ? `${t.skipped} skipped` : "",
    t.untested ? `${t.untested} untested` : "",
  ]
    .filter(Boolean)
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
    .join("");
  return `<h1>Regression — ${escapeHtml(result.project)} <span class="badge ${v.cls}">${v.label}</span></h1>
<p class="sub">${escapeHtml(result.baseUrl)} · ${escapeHtml(result.startedAt.slice(0, 16).replace("T", " "))} · ${(result.durationMs / 1000).toFixed(1)}s</p>
<div class="card">${chips}
<p class="muted" style="margin:10px 0 0">Selection: <code>${escapeHtml(result.selection.requested)}</code>${result.selection.includeDraft ? " (including drafts)" : ""}${result.selection.heal ? " · healing enabled" : ""} · model calls: <strong>${result.healCalls}</strong> · exit ${result.exitCode}</p></div>`;
}

function flowTable(result: SuiteResult): string {
  const rows = result.flows
    .map((f) => {
      const cls = OUTCOME_CLASS[f.outcome] ?? "";
      const where = f.failedAt !== undefined ? ` at step ${f.failedAt}/${f.stepsTotal}` : "";
      const evidence = f.reportDir
        ? `<a href="${escapeHtml(path.relative(result.reportDir, f.reportDir))}/steps.jsonl">evidence</a>`
        : "";
      return `<tr>
  <td class="${cls}"><strong>${escapeHtml(f.outcome)}</strong>${escapeHtml(where)}</td>
  <td><code>${escapeHtml(f.slug)}</code><br><span class="muted">${escapeHtml(truncate(f.name, 70))}</span></td>
  <td>${escapeHtml(f.statusBefore)} → ${escapeHtml(f.statusAfter)}</td>
  <td>${(f.durationMs / 1000).toFixed(1)}s</td>
  <td>${f.reason ? `<span class="muted">${escapeHtml(truncate(f.reason, 120))}</span><br>` : ""}${evidence}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>Flows</h2>
<div class="card"><table>
<tr><th>Outcome</th><th>Flow</th><th>Status</th><th>Time</th><th>Detail</th></tr>
${rows || '<tr><td colspan="5" class="muted">No flows selected.</td></tr>'}
</table></div>`;
}

/**
 * New findings first. A nightly suite is read by someone with thirty seconds:
 * what broke since yesterday belongs above what has been broken for a week.
 */
function findingSections(result: SuiteResult): string {
  const isNew = (f: SuiteFinding) => f.status === "NEW";
  const fresh = result.findings.filter(isNew);
  const known = result.findings.filter((f) => !isNew(f));
  if (!result.findings.length) return "";
  return [
    `<h2>New findings (${fresh.length})</h2>`,
    fresh.length
      ? fresh.map(findingCard).join("\n")
      : `<div class="card muted">Nothing new — every failure below was already known.</div>`,
    known.length ? `<h2>Known findings (${known.length})</h2>` : "",
    known.map(findingCard).join("\n"),
  ].join("\n");
}

function findingCard(f: SuiteFinding): string {
  const since =
    f.status === "KNOWN"
      ? `<span class="chip">KNOWN — seen ${f.seenCount}× since ${escapeHtml((f.firstSeenAt ?? "").slice(0, 10))}</span>`
      : `<span class="chip">NEW</span>`;
  const lastPass = f.lastPassAt
    ? `<p class="muted">Last passed ${escapeHtml(f.lastPassAt.slice(0, 16).replace("T", " "))}${f.lastPassSession ? ` (${escapeHtml(f.lastPassSession)})` : ""}</p>`
    : "";
  return `<div class="card finding ${escapeHtml(f.severity)}">
<h3>${escapeHtml(f.id)} — ${escapeHtml(f.title)}</h3>
<p>${since}<span class="chip oracle-${escapeHtml(f.oracle)}">${escapeHtml(f.oracle)}</span><span class="chip">confidence ${escapeHtml(f.confidence)}</span><span class="chip">${escapeHtml(f.severity)}</span></p>
${lastPass}
<div class="grid">
  <div><div class="label">Expected</div><pre>${escapeHtml(f.expected)}</pre></div>
  <div><div class="label">Actual</div><pre>${escapeHtml(f.actual)}</pre></div>
</div>
</div>`;
}

function footer(result: SuiteResult): string {
  return `<footer>Magpie ${escapeHtml(MAGPIE_VERSION)} · suite.json alongside this file is the machine-readable form · ${escapeHtml(result.reportDir)}</footer>`;
}
