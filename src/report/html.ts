import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, MagpieConfig, Objective, SessionResult, StepRecord } from "../types.js";
import { escapeHtml, truncate } from "../util.js";
import { MAGPIE_VERSION } from "../version.js";

const TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "report.html",
);

const STATUS_ICON: Record<Objective["status"], string> = {
  planned: "·",
  "in-progress": "…",
  passed: "✔",
  finding: "!",
  blocked: "✖",
};

export interface ReportInput {
  result: SessionResult;
  cfg: MagpieConfig;
  steps: StepRecord[];
  budgetSummary: string;
  providerSummary: string;
}

/** Self-contained single file: inline CSS, screenshots as base64 (brief §P1-T8). */
export function writeHtmlReport(input: ReportInput): string {
  const html = renderReport(input);
  const out = path.join(input.result.reportDir, "index.html");
  fs.writeFileSync(out, html);
  return out;
}

export function renderReport(input: ReportInput): string {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const { result, cfg } = input;
  const title = `Magpie — ${cfg.name} — ${result.status}`;
  return template
    .replace("{{TITLE}}", escapeHtml(title))
    .replace("{{HEADER}}", header(input))
    .replace("{{PLAN}}", plan(result.objectives))
    .replace("{{FINDINGS}}", findings(result, input.steps))
    .replace("{{OBSERVATIONS}}", observations(result))
    .replace("{{SCREENSHOTS}}", screenshots(result))
    .replace("{{TIMELINE}}", timeline(input.steps))
    .replace("{{FOOTER}}", footer(result));
}

function durationOf(result: SessionResult): string {
  const ms = new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function header(input: ReportInput): string {
  const { result, cfg } = input;
  const counts = countBy(result.findings);
  return `
<h1>${escapeHtml(cfg.name)} <span class="badge ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span></h1>
<p class="sub">${escapeHtml(cfg.base_url)}</p>
<div class="card">
  <div class="label">Charter</div>
  <div>${escapeHtml(result.charter)}</div>
  <p class="sub" style="margin:14px 0 0">
    <span class="chip">started ${escapeHtml(result.startedAt)}</span>
    <span class="chip">duration ${escapeHtml(durationOf(result))}</span>
    <span class="chip">${escapeHtml(input.budgetSummary)}</span>
    <span class="chip">${escapeHtml(input.providerSummary)}</span>
  </p>
  <p class="sub" style="margin:8px 0 0">
    <span class="chip">${result.objectives.length} objectives</span>
    <span class="chip">${result.objectives.filter((o) => o.status === "passed").length} passed</span>
    <span class="chip">${result.findings.length} findings${counts}</span>
    <span class="chip">${result.stepCount} steps</span>
  </p>
</div>`;
}

function countBy(list: Finding[]): string {
  if (!list.length) return "";
  const high = list.filter((f) => f.severity === "high").length;
  const medium = list.filter((f) => f.severity === "medium").length;
  const low = list.filter((f) => f.severity === "low").length;
  return ` (${[high && `${high} high`, medium && `${medium} medium`, low && `${low} low`]
    .filter(Boolean)
    .join(", ")})`;
}

function plan(objectives: Objective[]): string {
  if (!objectives.length) return `<h2>Plan</h2><div class="card muted">No plan was produced.</div>`;
  const rows = objectives
    .map(
      (o) => `<tr>
    <td><strong>${escapeHtml(o.id)}</strong></td>
    <td>${escapeHtml(o.description)}</td>
    <td><span class="chip">${escapeHtml(o.technique)}</span></td>
    <td>${STATUS_ICON[o.status]} ${escapeHtml(o.status)}</td>
    <td class="muted">${escapeHtml(o.note ?? "")}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Plan</h2>
<div class="card"><table>
  <thead><tr><th>ID</th><th>Objective</th><th>Technique</th><th>Status</th><th>Note</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

function findings(result: SessionResult, steps: StepRecord[]): string {
  if (!result.findings.length) {
    return `<h2>Findings</h2><div class="card muted">No findings recorded.</div>`;
  }
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return `<h2>Findings</h2>\n${sorted.map((f) => findingCard(f, result, steps)).join("\n")}`;
}

function findingCard(f: Finding, result: SessionResult, steps: StepRecord[]): string {
  const repro = steps
    .filter((s) => f.steps.includes(s.n) && s.actor === "model")
    .map(
      (s) =>
        `<li>${escapeHtml(s.action)} <code>${escapeHtml(truncate(JSON.stringify(s.args), 120))}</code> → ${escapeHtml(truncate(s.result.detail ?? "", 160))}</li>`,
    )
    .join("\n");
  const shots = f.screenshots
    .map((rel, i) => {
      const data = inlineImage(result.reportDir, rel);
      if (!data) return "";
      return `<figure><img alt="${escapeHtml(rel)}" src="${data}"><figcaption>${i === 0 ? "before" : "after"} — ${escapeHtml(rel)}</figcaption></figure>`;
    })
    .join("\n");
  return `<div class="card finding ${escapeHtml(f.severity)}">
  <h3>${escapeHtml(f.id)} — ${escapeHtml(f.title)}</h3>
  <p style="margin:0">
    <span class="chip">severity: ${escapeHtml(f.severity)}</span>
    <span class="chip oracle-${escapeHtml(f.oracle)}">oracle: ${escapeHtml(f.oracle)}</span>
    <span class="chip">confidence: ${escapeHtml(f.confidence)}</span>
    ${f.objectiveId ? `<span class="chip">${escapeHtml(f.objectiveId)}</span>` : ""}
  </p>
  <div class="grid">
    <div><div class="label">Expected</div>${escapeHtml(f.expected)}</div>
    <div><div class="label">Actual</div>${escapeHtml(f.actual)}</div>
  </div>
  ${repro ? `<div class="label">Repro steps</div><ol class="repro">${repro}</ol>` : ""}
  ${f.console?.length ? `<div class="label" style="margin-top:12px">Console</div><pre>${escapeHtml(f.console.join("\n"))}</pre>` : ""}
  ${f.network?.length ? `<div class="label" style="margin-top:12px">Network</div><pre>${escapeHtml(f.network.join("\n"))}</pre>` : ""}
  ${shots ? `<div class="shots">${shots}</div>` : ""}
</div>`;
}

function inlineImage(reportDir: string, rel: string): string | undefined {
  try {
    const buf = fs.readFileSync(path.join(reportDir, rel));
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * Every screenshot the run captured, collapsed. A clean run has no finding
 * cards, and a QA report with no visual evidence at all is not much of a report.
 */
function screenshots(result: SessionResult): string {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(result.reportDir, "shots")).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return "";
  }
  if (!files.length) return "";
  const shown = files.filter((f) => !result.findings.some((find) => find.screenshots.includes(path.join("shots", f))));
  const figures = (shown.length ? shown : files)
    .map((f) => {
      const data = inlineImage(result.reportDir, path.join("shots", f));
      return data
        ? `<figure><img alt="${escapeHtml(f)}" src="${data}"><figcaption>${escapeHtml(f)}</figcaption></figure>`
        : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!figures) return "";
  return `<h2>Screenshots</h2>
<details${result.findings.length ? "" : " open"}><summary>${files.length} captured during this run</summary>
<div class="shots">${figures}</div>
</details>`;
}

function observations(result: SessionResult): string {
  if (!result.observations.length) return "";
  const rows = result.observations
    .map(
      (o) =>
        `<tr><td><span class="chip">${escapeHtml(o.type)}</span></td><td>${escapeHtml(o.detail)}</td></tr>`,
    )
    .join("\n");
  return `<h2>Observations</h2><div class="card"><table><tbody>${rows}</tbody></table></div>`;
}

function timeline(steps: StepRecord[]): string {
  const rows = steps
    .map(
      (s) => `<tr>
    <td class="muted">${s.n}</td>
    <td class="muted">${escapeHtml(s.t.slice(11, 19))}</td>
    <td>${escapeHtml(s.actor)}</td>
    <td>${escapeHtml(s.action)}</td>
    <td>${escapeHtml(truncate(JSON.stringify(s.args), 80))}</td>
    <td class="${s.result.ok ? "ok" : "bad"}">${s.result.ok ? "ok" : "fail"}</td>
    <td>${escapeHtml(truncate(s.result.detail ?? "", 200))}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Step timeline</h2>
<details><summary>${steps.length} steps</summary>
<table>
  <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Args</th><th></th><th>Result</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</details>`;
}

function footer(result: SessionResult): string {
  const hasTrace = fs.existsSync(path.join(result.reportDir, "trace.zip"));
  const trace = hasTrace
    ? `Playwright trace: <a href="trace.zip">trace.zip</a> — open it with <code>npx playwright show-trace trace.zip</code>.`
    : `No Playwright trace was captured for this run.`;
  return `<footer>
  ${trace}<br>
  Steps: <a href="steps.jsonl">steps.jsonl</a> · Session: <a href="session.json">session.json</a><br>
  Generated by Magpie v${escapeHtml(MAGPIE_VERSION)} on ${escapeHtml(result.endedAt)}.
</footer>`;
}
