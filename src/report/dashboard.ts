import fs from "node:fs";
import path from "node:path";
import {
  allFindings,
  allSessions,
  counts,
  flowOverview,
  type FindingWithSession,
  type FlowOverview,
  type MemoryDb,
} from "../memory/db.js";
import type { SessionRow } from "../memory/types.js";
import { asPercent, coverageReport, type CoverageReport } from "../memory/coverage.js";
import { EXPLORE_CHARTER } from "../types.js";
import { escapeHtml, isoNow, truncate } from "../util.js";
import { MAGPIE_VERSION } from "../version.js";
import { styleBlock, TEMPLATES_DIR } from "./html.js";

const TEMPLATE = path.join(TEMPLATES_DIR, "dashboard.html");

/** The file `magpie dashboard` writes when no --out is given. */
export const DASHBOARD_FILENAME = "dashboard.html";

export interface DashboardInput {
  db: MemoryDb;
  /**
   * The project folder. Links to report folders are rendered relative to the
   * directory the dashboard is written into, which is this one by default —
   * a dashboard full of /Users/… paths is useless the moment it is shared.
   */
  dir: string;
  projectName: string;
  baseUrl?: string;
  /** Where the file will live, if not `<dir>/dashboard.html`. */
  outDir?: string;
  /** Overridable so tests can assert on a fixed footer. */
  now?: string;
}

export function writeDashboard(input: DashboardInput, outFile: string): string {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderDashboard({ ...input, outDir: path.dirname(outFile) }));
  return outFile;
}

export function renderDashboard(input: DashboardInput): string {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const { db, projectName } = input;
  const c = counts(db);
  const empty = c.sessions === 0 && c.pages === 0 && c.flows === 0;
  const body = empty
    ? `${title(input)}\n${gettingStarted()}\n${footer(input)}`
    : [
        title(input),
        totals(input),
        coverageSection(coverageReport(db)),
        flowsSection(flowOverview(db)),
        defectsSection(defectsOf(allFindings(db)), input),
        sessionsSection(allSessions(db), input),
        footer(input),
      ].join("\n");

  return template
    .replace("{{STYLE}}", () => styleBlock())
    .replace("{{TITLE}}", escapeHtml(`Magpie — ${projectName}`))
    .replace("{{BODY}}", () => body);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function title(input: DashboardInput): string {
  return `<h1>${escapeHtml(input.projectName)} <span class="chip">memory</span></h1>
<p class="sub">${escapeHtml(input.baseUrl ?? "")}</p>`;
}

function totals(input: DashboardInput): string {
  const c = counts(input.db);
  const last = allSessions(input.db)[0];
  const tiles: [string, string, string][] = [
    [String(c.sessions), "sessions", ""],
    [String(c.pages), "pages mapped", `${c.transitions} transitions`],
    [String(c.flows), "flows", ""],
    [String(c.findings), "finding sightings", ""],
  ];
  const cards = tiles
    .map(
      ([n, label, sub]) =>
        `<div class="tile"><div class="n">${escapeHtml(n)}</div><div class="label">${escapeHtml(label)}</div>` +
        (sub ? `<div class="muted" style="font-size:12px">${escapeHtml(sub)}</div>` : "") +
        `</div>`,
    )
    .join("\n");
  const lastLine = last
    ? `<p class="sub" style="margin:0">Last run ${escapeHtml(when(last.started_at))} — ` +
      `${modeBadge(last)} <span class="chip">${escapeHtml(last.status)}</span> ` +
      `<span class="chip">${last.llm_requests} LLM calls</span></p>`
    : `<p class="sub" style="margin:0">No sessions recorded yet.</p>`;
  return `<div class="totals">${cards}</div>\n${lastLine}`;
}

function gettingStarted(): string {
  return `<div class="card">
  <h2 style="margin-top:0">Nothing remembered yet</h2>
  <p>This project has no sessions, no pages and no flows. Magpie learns the
  application by testing it, so the dashboard fills itself in after the first run.</p>
  <div class="label">Start here</div>
  <pre>magpie login                 # only if the app needs a session
magpie run --explore         # let Magpie find its own way around
magpie run --charter "Log in and add an item to the cart"
magpie dashboard             # come back here</pre>
  <p class="muted" style="margin-bottom:0">Flows recorded during a run replay with
  <code>magpie run --regress all</code> and cost no model calls at all.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function coverageSection(cov: CoverageReport): string {
  const worst = cov.worstPages.length
    ? `<div class="label" style="margin-top:16px">Least-exercised pages</div>
<table>
  <thead><tr><th>Used</th><th>Page</th><th>Elements</th><th>Verified flows</th></tr></thead>
  <tbody>${cov.worstPages
    .map(
      (p) => `<tr>
    <td class="nowrap">${escapeHtml(asPercent(p.ratio))}<div class="bar"><span style="width:${Math.round(p.ratio * 100)}%"></span></div></td>
    <td>${escapeHtml(truncate(p.pageKey, 70))}</td>
    <td class="muted nowrap">${p.interacted}/${p.seen}</td>
    <td class="muted">${p.verifiedFlows}</td>
  </tr>`,
    )
    .join("\n")}</tbody>
</table>`
    : "";

  const frontier = cov.frontier.length
    ? `<div class="label" style="margin-top:16px">Frontier — linked, never opened</div>
<table><tbody>${cov.frontier
        .map(
          (f) =>
            `<tr><td>${escapeHtml(truncate(f.pageKey, 70))}</td><td class="muted">seen on ${escapeHtml(truncate(f.seenOnPage ?? "(unknown)", 50))}</td></tr>`,
        )
        .join("\n")}</tbody></table>
<p class="muted" style="margin:10px 0 0">Run <code>magpie run --explore</code> to work through it.</p>`
    : "";

  return `<h2>Coverage</h2>
<div class="card">
<table>
  <tbody>
    <tr><td>Pages known</td><td><strong>${cov.pages.known}</strong> <span class="muted">(${cov.pages.visited} visited, ${cov.pages.frontier} on the frontier)</span></td></tr>
    <tr><td>Elements used</td><td><strong>${cov.elements.interacted}</strong> of ${cov.elements.seen} seen <span class="muted">(${escapeHtml(asPercent(cov.elements.ratio))})</span>
      <div class="bar"><span style="width:${Math.round(cov.elements.ratio * 100)}%"></span></div></td></tr>
    <tr><td>Flows</td><td><strong>${cov.flows.total}</strong>
      <span class="chip flow-verified">${cov.flows.verified} verified</span>
      <span class="chip flow-draft">${cov.flows.draft} draft</span>
      <span class="chip flow-broken">${cov.flows.broken} broken</span></td></tr>
  </tbody>
</table>
${worst}
${frontier}
<p class="muted" style="margin:14px 0 0">${escapeHtml(cov.note)}</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

function flowsSection(flows: FlowOverview[]): string {
  if (!flows.length) {
    return `<h2>Flows</h2><div class="card muted">No flows recorded yet. A charter run drafts one whenever it completes a sequence of actions worth keeping.</div>`;
  }
  const rows = flows
    .map(
      (f) => `<tr>
    <td><span class="chip flow-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span></td>
    <td><code>${escapeHtml(f.slug)}</code><div class="muted" style="font-size:12.5px">${escapeHtml(truncate(f.name, 70))}</div></td>
    <td class="muted nowrap">${f.steps}</td>
    <td class="nowrap">${lastReplay(f)}</td>
    <td class="muted nowrap">${f.heals ? `${f.heals}×` : "—"}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Flows (${flows.length})</h2>
<div class="card"><table>
  <thead><tr><th>Status</th><th>Flow</th><th>Steps</th><th>Last replay</th><th>Healed</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="muted" style="margin:12px 0 0">A healed flow is demoted to draft on purpose: healing proves something similar is still on the page, not that the application still does what the flow asserts.</p>
</div>`;
}

function lastReplay(f: FlowOverview): string {
  if (!f.last_replay_at) return `<span class="muted">never</span>`;
  const ok = f.last_replay_result === "pass";
  return `<span class="${ok ? "ok" : "bad"}">${escapeHtml(f.last_replay_result ?? "?")}</span>
    <div class="muted" style="font-size:12.5px">${escapeHtml(when(f.last_replay_at))}</div>`;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

interface Defect {
  key: string;
  title: string;
  severity: string;
  oracle: string;
  confidence: string;
  pageKey: string | null;
  sightings: number;
  firstSeen: string;
  lastSeen: string;
  latestReportDir: string | null;
  /** First sighted by the newest run that found anything — tonight's damage. */
  isNew: boolean;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * One card per defect, not per sighting.
 *
 * Findings are grouped by the fingerprint that already decides NEW vs KNOWN
 * inside a run (Phase 3 §1.5). Rows written before fingerprints existed fall
 * back to their title, which is the only identity they have.
 */
export function defectsOf(rows: FindingWithSession[]): Defect[] {
  const byKey = new Map<string, FindingWithSession[]>();
  for (const r of rows) {
    const key = r.fingerprint ?? `title:${r.title}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  // "New" means new in the newest run that recorded anything at all: a run that
  // found nothing cannot make last night's defects new again.
  const newestWithFindings = rows.reduce((n, r) => Math.max(n, r.session_id), 0);

  const defects = [...byKey.entries()].map(([key, list]): Defect => {
    // allFindings() returns newest first, so [0] is the latest sighting.
    const latest = list[0]!;
    const first = list[list.length - 1]!;
    return {
      key,
      title: latest.title,
      severity: latest.severity,
      oracle: latest.oracle,
      confidence: latest.confidence,
      pageKey: latest.page_key,
      sightings: list.length,
      firstSeen: first.created_at,
      lastSeen: latest.created_at,
      latestReportDir: latest.report_dir,
      isNew: first.session_id === newestWithFindings,
    };
  });

  return defects.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
      b.lastSeen.localeCompare(a.lastSeen),
  );
}

function defectsSection(defects: Defect[], input: DashboardInput): string {
  if (!defects.length) {
    return `<h2>Findings</h2><div class="card muted">No findings recorded. Either the application behaved, or nothing has tested it yet.</div>`;
  }
  const fresh = defects.filter((d) => d.isNew);
  const known = defects.filter((d) => !d.isNew);
  return [
    `<h2>New in the latest run (${fresh.length})</h2>`,
    fresh.length
      ? `<div class="card"><table>${fresh.map((d) => defectRow(d, input)).join("\n")}</table></div>`
      : `<div class="card muted">Nothing new — every defect below was already known to this project.</div>`,
    known.length
      ? `<h2>Known defects (${known.length})</h2>\n<div class="card"><table>${known
          .map((d) => defectRow(d, input))
          .join("\n")}</table></div>`
      : "",
  ].join("\n");
}

function defectRow(d: Defect, input: DashboardInput): string {
  const sevClass = d.severity === "high" || d.severity === "medium" ? ` sev-${escapeHtml(d.severity)}` : "";
  const link = reportLink(input, d.latestReportDir);
  return `<tr>
  <td>
    <strong>${escapeHtml(truncate(d.title, 90))}</strong>
    <div style="margin-top:6px">
      <span class="chip${sevClass}">${escapeHtml(d.severity)}</span>
      <span class="chip oracle-${escapeHtml(d.oracle)}">${escapeHtml(d.oracle)}</span>
      <span class="chip">confidence: ${escapeHtml(d.confidence)}</span>
      ${d.pageKey ? `<span class="chip">${escapeHtml(truncate(d.pageKey, 50))}</span>` : ""}
    </div>
  </td>
  <td class="muted nowrap">
    ${d.sightings > 1 ? `seen ${d.sightings}× <div style="font-size:12.5px">since ${escapeHtml(when(d.firstSeen))}</div>` : `first seen ${escapeHtml(when(d.firstSeen))}`}
  </td>
  <td class="nowrap">${link}</td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionMode = "charter" | "explore" | "regress";

/** What kind of run this was, read back out of what was stored about it. */
export function sessionMode(s: Pick<SessionRow, "status" | "charter">): SessionMode {
  if (s.status === "REGRESSION" || (s.charter ?? "").startsWith("regression:")) return "regress";
  if (s.charter === EXPLORE_CHARTER) return "explore";
  return "charter";
}

function modeBadge(s: Pick<SessionRow, "status" | "charter">): string {
  const mode = sessionMode(s);
  return `<span class="mode ${mode}">${mode}</span>`;
}

function sessionsSection(sessions: SessionRow[], input: DashboardInput): string {
  if (!sessions.length) return "";
  const rows = sessions
    .map(
      (s) => `<tr>
    <td class="muted nowrap">${escapeHtml(when(s.started_at))}</td>
    <td>${modeBadge(s)}</td>
    <td class="nowrap">${escapeHtml(s.status)}</td>
    <td class="muted nowrap">${s.llm_requests}</td>
    <td>${escapeHtml(truncate(s.charter ?? "", 80))}</td>
    <td class="nowrap">${reportLink(input, s.report_dir)}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Sessions (${sessions.length})</h2>
<div class="card"><table>
  <thead><tr><th>When</th><th>Mode</th><th>Status</th><th>LLM</th><th>Charter</th><th>Report</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/**
 * A link to a run's report folder, relative to where the dashboard is written.
 *
 * A report that lives outside the project (or on the machine that produced the
 * database, which is not necessarily this one) gets its folder name as plain
 * text: an absolute path in a shared HTML file is a broken link that also
 * leaks the author's home directory.
 */
function reportLink(input: DashboardInput, reportDir: string | null): string {
  if (!reportDir) return `<span class="muted">—</span>`;
  const from = input.outDir ?? input.dir;
  const rel = path.relative(from, reportDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `<span class="muted">${escapeHtml(path.basename(reportDir))}</span>`;
  }
  const href = rel.split(path.sep).join("/");
  return `<a href="${escapeHtml(href)}/index.html">report</a>`;
}

/** "2026-09-24 18:40" — local, readable, and short enough for a table cell. */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function footer(input: DashboardInput): string {
  return `<footer>
  Generated by Magpie v${escapeHtml(MAGPIE_VERSION)} on ${escapeHtml(input.now ?? isoNow())} from this project's memory.<br>
  Refresh it with <code>magpie dashboard</code> after any run.
</footer>`;
}
