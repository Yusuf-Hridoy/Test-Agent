# PHASE-4-BRIEF.md — Explore mode & coverage

> You (Claude Code) are building Phase 4. CLAUDE.md Hard Rules apply.
> **Git protocol (user-operated):** the USER makes every git operation; you make
> none — no add, commit, branch, or push. Instead, at the end of each task,
> STOP and print a "COMMIT POINT" block: the files changed and the exact
> commit message (`P4-Tn: <summary>`). Wait for the user to say "committed"
> before starting the next task, so each commit cleanly contains one task.
> The user opens the PR from `phase-4`; the reviewer reads it; the user merges.
> Ask the user to commit this brief first, with the roadmap flip
> (CLAUDE.md: Phase 4 → CURRENT) in the same commit.

## 0. Goal

`magpie run --explore` — Magpie tests without being told what to test:
1. It **discovers** the app: crawls from what it knows, prioritizing the
   **frontier** (pages seen as links but never visited) and under-covered pages.
2. It **generates its own objectives** from what it finds (forms → input
   probing, lists → interaction sampling, state controls → transitions),
   avoiding ground already covered by verified flows.
3. It reports **coverage** honestly: of the app Magpie *knows about*, what has
   been visited and interacted with — plus what remains on the frontier.
   Coverage of the unknown is unknowable; the report says so in one line.
4. Everything learned lands in memory exactly as charter runs do — explore
   feeds the same app map, flows, and findings.

Plus one small debt: `auth.probe_url` (deferred in Phases 2 and 3 — now due).

## Out of scope (Phase 5)
Dashboard, docs site, launch material, parallel exploration, `--resume`,
visual-diff oracles, sitemap/robots ingestion (note as Phase 5 candidate).

## 1. Design

### 1.0 P4-T0 — repo debt (do FIRST)
The user has placed `PHASE-1-BRIEF.md` in the repo root alongside this file.
Verify it exists; if absent, STOP and ask the user for it. If present, print
the first COMMIT POINT: `P1: commit the Phase 1 brief retroactively`
(PHASE-1-BRIEF.md only), and wait for "committed".

### 1.1 `auth.probe_url` (P4-T1)
New optional config field under `auth`. When set, the logged-out heuristic runs
against `probe_url` instead of `base_url`; when unset, behavior is unchanged.
Generated config template documents it with the saucedemo example
(`probe_url: /inventory.html`). Update the two CLI messages that currently
explain the base_url workaround. 🧪 both branches of the heuristic.

### 1.2 Frontier & element coverage (P4-T2, migration 003)
```sql
CREATE TABLE frontier (
  page_key TEXT PRIMARY KEY, sample_url TEXT NOT NULL,
  first_seen TEXT NOT NULL, seen_on_page TEXT,        -- page_key of referrer
  visited_at TEXT                                      -- NULL = still frontier
);
CREATE TABLE element_seen (
  page_key TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  interactions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_key, role, name)
);
```
Ingestion additions (all runs, not only explore): every in-scope link/anchor in
a snapshot whose normalized page_key is not in `pages` → upsert into `frontier`;
a page entering `pages` marks its frontier row visited. Every snapshot element
→ upsert `element_seen` (last_seen); every acted-on element → `interactions+1`.
Out-of-scope links are never frontier (guard rules apply at ingestion too).
🧪 fixture session produces expected frontier + element_seen rows; scope
exclusion respected; idempotent re-ingest.

### 1.3 Explore session (P4-T3)
`magpie run --explore` (flags: `--headed`, `--as`, plus everything budgets
already give). Reuses the Phase 1 session engine end to end — same harness,
budgets, evidence, oracles, ingestion. What changes is only where objectives
come from:
- **Seed queue** (deterministic code, no LLM): (1) frontier pages, oldest
  first, capped `explore.max_new_pages` (default 8); (2) known pages with the
  lowest element-interaction ratio; (3) if memory is empty, the queue is just
  `base_url`.
- **Per-page objective generation** (one LLM call per page, prompt ≤40 lines,
  new in prompts.ts): given the page snapshot + which of its elements were
  never interacted with + verified-flow names touching this page, return STRICT
  JSON: up to `explore.max_objectives_per_page` (default 3) objectives with
  techniques (reuse the Phase 1 technique enum), explicitly avoiding what
  verified flows already cover. Objectives execute on the normal executor loop.
- **Mid-run discovery:** new in-scope pages found while executing are appended
  to this session's queue until `budget.max_steps` / `max_llm_requests` cut it
  off — budgets are the crawl horizon, no separate crawl limit.
- **Safety unchanged:** guard rules, forbidden elements, scope, redaction. An
  explore session on a real app is the risk case the guards were built for —
  add a config-template comment saying exactly that next to `scope.exclude`.
🧪 scripted-model explore on fakeapp: queue order honored, mid-run discovery
appended, objectives avoid a fixture verified flow, budgets stop the crawl.

### 1.4 Coverage (P4-T4)
- `magpie memory coverage`: pages known / visited / frontier remaining;
  element coverage per page (interacted ÷ seen, worst 10 listed); verified-flow
  count per page. Plain table + `--json`.
- Explore report gains a Coverage section: what this session added (pages,
  elements, flows drafted), frontier before → after, and the one honest line:
  "Coverage is measured against pages Magpie has discovered; unknown areas are
  not included." 🧪 numbers reconcile against fixture DB by hand-computed values.

### 1.5 Explore acceptance (P4-T5, self-run; Run Log in this file)
| # | Scenario | Expected |
|---|---|---|
| C1 | Fresh project (fakeapp), `run --explore` | ≥3 pages discovered, frontier consumed in seed order, objectives generated per page, session COMPLETED, ingested |
| C2 | Immediate second `--explore` | skips ground covered by now-verified/draft flows; goes to remaining frontier / worst-covered elements; fewer LLM calls than C1 |
| C3 | Add a brand-new page + link to fakeapp; `--explore` | new link enters frontier at ingestion and is visited this run or queued; `memory coverage` shows it |
| C4 | `--explore` on saucedemo (live) | completes within budgets on free tier; coverage section renders; at least one generated objective exercises a never-interacted element |
| C5 | Scope check: fakeapp page linking out-of-scope | the external link never appears in frontier or steps |
| C6 | `memory coverage --json` | schema-valid (zod), reconciles with `memory show` counts |
| C7 | Secret sweep (db, wal, shm, reports, prompt logs) | zero hits for key prefixes and demo password |
| C8 | Full suite + build green; Phases 1–3 test files byte-identical |
Same escalation + free-tier quota rules as before. Fill the Run Log table
(scenario, result, attempts, fix).

## 2. Tasks
- **P4-T0** commit PHASE-1-BRIEF.md (§1.0)
- **P4-T1** auth.probe_url (§1.1)
- **P4-T2** migration 003 + ingestion frontier/element coverage (§1.2)
- **P4-T3** explore mode (§1.3)
- **P4-T4** coverage command + report section (§1.4)
- **P4-T5** acceptance C1–C8 + Run Log
- **P4-T6** docs: README explore section (what it does, the safety paragraph —
  explore on production is a misuse, staging + scope.exclude are mandatory
  advice), recommended cadence (explore weekly / charter per feature / regress
  nightly with --fail-on-skipped), CLAUDE.md status + decision log.

## 3. Completion checklist
- [ ] T0–T6 done; each task ended with a COMMIT POINT the user has committed
- [ ] C1–C8 pass, Run Log filled
- [ ] CLAUDE.md: Phase 4 COMPLETE + decision log (deviations with reasons)
- [ ] Handoff message to the user: the ordered list of commits made, the
      command to push and open the PR from `phase-4`, what explore does in two
      sentences, and anything deferred to Phase 5 — **PR stays unmerged until
      the reviewer signs off**
