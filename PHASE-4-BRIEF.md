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

## 1.6 Run Log (P4-T5, self-run 2026-09-24)

Two targets: a local fixture shop with five linked pages, an out-of-scope link
and a page that can be added on cue (`/whatsnew`), and www.saucedemo.com live.
Gemini requests across the whole acceptance: **≈130**, all on
`gemini-3.1-flash-lite`, no quota error. Every run went through the real CLI, so
the explorer prompt was answered by a real model throughout.

| # | Result | Attempts | What happened |
|---|--------|----------|---------------|
| C1 | **PASS** | 2 | Fresh project, `run --explore`: queue starts `1 base`, discovers 3 pages mid-run, visits base → /catalogue → /cart → /help, generates objectives per page, **COMPLETED**, ingested (4 pages, 5 transitions, 1 flow). /help honestly returned `[]` — "nothing worth testing here". First attempt ended BUDGET_EXHAUSTED at 14/14 calls: my own budget, not a defect, and re-run at 30 with one objective per page. |
| C2 | **PARTIAL** | 2 | Skips covered ground ✓ — but only after a defect fix (below); before it, the landing page re-proposed the objective C1 had already recorded. Goes to worst-covered pages ✓ (`4 under-covered`, no frontier left). Element coverage rose 7→9 of 21, and flow ingest reported `1 already known`. **"Fewer LLM calls than C1" ✗: 20 vs 20.** Diagnosed, not fudged — see finding 2. |
| C3 | **PASS** | 1 | Added `/whatsnew` plus a nav link to it. The run announced `queued 1 newly discovered page(s)`, visited it as `frontier` in the same session, generated an objective for it, and `memory coverage` now lists it (5 pages known, /whatsnew 20% used). |
| C4 | **PASS** | 2 | Live saucedemo, `probe_url: /inventory.html`. Completed within budget (4/16 calls), coverage section rendered, and the generated objective exercised a never-interacted element (the sort combobox: *"Selecting 'Price (low to high)' … reorders the product list"*), which also turned up a real 4xx finding. First attempt seeded from `base_url` — saucedemo's login page — and wasted the session proposing objectives about logging in again; two defects fixed (below) and re-run. |
| C5 | **PASS** | 1 | The out-of-scope link is present on the landing page and was *seen* (`element_seen: link "Our partner site", interactions 0`) but appears in **no** frontier row, **no** page row and **no** navigation step. The three `example.com` strings in steps.jsonl are the model typing a test email address, not the link. |
| C6 | **PASS** | 1 | `memory coverage --json`: valid against the exported zod schema, 0 bytes on stderr, and reconciles with `memory show` — coverage says 5 pages / 6 flows, show says `pages 5 · flows 6`. |
| C7 | **PASS** | 1 | `strings` over every project's db, `-wal` and `-shm`, plus a recursive grep over all reports: `secret_sauce` 0 hits, Gemini key prefix 0, Groq key prefix 0, across all four acceptance projects. |
| C8 | **PASS** | 1 | 253 tests green, build and typecheck clean. Every Phase 1–3 test file is **byte-identical** to the last Phase 3 commit (`git diff e760d16 -- …` is empty); Phase 4 adds three new test files and one additive line to the fixture app. |

### Defects found and fixed during acceptance

1. **Recorded flows were keyed only by the page a flow ENDS on** (found by C2).
   A flow recorded as "click Catalogue on the landing page" ends on
   `/catalogue`, so the landing page was never told it had a flow and the
   explorer proposed the same objective a second time. Now keyed by start page
   and end page.
2. **Explore seeded from `base_url` even when `probe_url` was set** (found by
   C4). On saucedemo that is the login form whether or not you are logged in,
   so the session spent its first call generating objectives about logging in
   again. The seed queue now starts from the probe target when there is one.
3. **The auth check narrated `base_url` rather than the page it actually
   probed** (found by C4) — a reader chasing a failure would have looked at the
   wrong page.

### Spec conflict resolved

§1.3 says the per-page prompt lists "verified-flow names"; C2 expects ground
covered by "now-verified/**draft**" flows to be skipped. Drafts are now included
(broken flows are not): a draft is still ground captured as a replayable flow —
`--regress --include-draft` runs it — so proposing an objective for it spends a
model call to learn nothing.

### Findings from acceptance (not scenario failures)

1. **`href`-based discovery finds nothing on a JS-navigated app.** Probed
   saucedemo's inventory page directly: every in-app anchor is `href="#"` with
   navigation done in JavaScript, and the cart "link" carries no href at all.
   Only the three social links have real hrefs, and they are out of scope. So
   the frontier stays empty there — pages still enter the map when a session
   actually visits them, but nothing is discovered ahead of time. Treating every
   clickable as a candidate page is exactly the non-deterministic crawling §1.3
   avoids, so the honest fix is a Phase 5 one: record a click that changes the
   URL as a discovery, and/or ingest `sitemap.xml`.
2. **Site-wide navigation keeps every page under 100% for a long time**, which
   is why C2 cost the same as C1. The same "Home" link on five pages is five
   `element_seen` rows, so queue rule (2) re-queues the whole map every run. The
   mechanism that *does* make repeat exploration cheaper — a page at ratio 1
   drops out of the queue for good — is unit-tested rather than demonstrated
   live, because driving this fixture to full coverage would have cost more
   quota than the point is worth.
3. **A page that offers nothing says so.** `/help` returned `[]` twice. Worth
   keeping: it is the behaviour that stops explore inventing objectives about
   footer links.

## 3. Completion checklist
- [x] T0–T6 done; each task ended with a COMMIT POINT the user committed
- [x] C1–C8 run, Run Log filled — **C2 partial** (diagnosed above), the rest pass
- [x] CLAUDE.md: Phase 4 complete + decision log (14 entries, 1 deviation,
      1 spec conflict, 3 acceptance defects)
- [x] Handoff message delivered — PR stays unmerged until the reviewer signs off
