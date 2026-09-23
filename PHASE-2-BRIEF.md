# PHASE-2-BRIEF.md — Memory (app map, named flows, deterministic replay)

> You (Claude Code) are building Phase 2. CLAUDE.md Hard Rules apply throughout.
> **Git protocol (new, mandatory):** work on branch `phase-2`; one commit per
> task (or per defect fix), message prefixed `P2-Tn:` (or `fix(P2-Tn):`), so the
> reviewer can read the phase as diffs. Do not squash. Merge to main only after
> the completion checklist passes.
> Update CLAUDE.md roadmap: Phase 2 → CURRENT. Commit this brief to the repo.

## 0. Goal

Magpie stops forgetting. After this phase:
1. Every run **ingests** what it learned into `<project>/memory/magpie.db`
   (SQLite): pages seen, transitions between them, flows that passed, findings.
2. Flows have **names** and can be listed, inspected, renamed, verified,
   deleted (`magpie flows …`, `magpie memory …`).
3. A saved flow **replays deterministically** — real browser, ZERO LLM calls —
   via `magpie flows replay <name>`, failing loudly at the exact step that broke.
4. The **planner uses memory**: a charter on a known app plans against the app
   map and existing flows instead of rediscovering from zero.

The economic point (CLAUDE.md §2) becomes real here: session N explores at LLM
cost; sessions N+1… replay known ground for free.

## Out of scope (Phase 3+, do NOT build)
- `magpie run --regress`, baselines, visual/regression oracles, memory-based
  oracle ("worked last week, fails now"), LLM healing of broken flows,
  cross-run finding dedup UI, `auth.probe_url` (still deferred), dashboard.
- Replay does not self-heal; a broken flow just fails with evidence and gets
  status `broken`. Healing is Phase 3.

## 1. Architecture

### 1.1 Storage decisions (fixed)
- One DB per project: `<project>/memory/magpie.db`, `better-sqlite3`
  (synchronous API), WAL mode, `schema_version` table, migrations as numbered
  SQL strings applied at open. Add `memory/` to the generated project
  `.gitignore` note: committing the DB is the USER'S choice (document both ways
  in README); default = ignored.
- **No secret ever enters the DB** (Hard Rule 2 extended): ingestion runs
  through the SecretStore; any value equal to `«redacted»` is stored as the
  placeholder `{secret}` and replay treats it as *unfillable* (see §1.4).
  Login is never replayed from stored values — sessions come from storageState.

### 1.2 Schema (exact DDL, migration 001)

```sql
CREATE TABLE schema_version (v INTEGER NOT NULL);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, charter TEXT,
  report_dir TEXT NOT NULL,
  llm_requests INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  page_key TEXT NOT NULL UNIQUE,      -- normalized host/path, see §1.3
  sample_url TEXT NOT NULL,
  title TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  elements_json TEXT                  -- last-seen ElementRef[] (redacted), ≤120
);
CREATE TABLE transitions (
  from_page INTEGER NOT NULL REFERENCES pages(id),
  to_page   INTEGER NOT NULL REFERENCES pages(id),
  action    TEXT NOT NULL,            -- e.g. click "Add to cart"
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (from_page, to_page, action)
);
CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,          -- e.g. add-cheapest-item-to-cart
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | verified | broken
  origin_session INTEGER REFERENCES sessions(id),
  origin_objective TEXT,
  start_page_key TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_replay_at TEXT, last_replay_result TEXT   -- pass | fail@<step> | null
);
CREATE TABLE flow_steps (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  action TEXT NOT NULL,               -- goto|click|fill|select|press
  target_role TEXT, target_name TEXT, -- how to find the element (no ids!)
  value TEXT,                          -- literal, or '{secret}' (unfillable)
  url_after TEXT,                      -- page_key observed after the step
  PRIMARY KEY (flow_id, seq)
);
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  fid TEXT NOT NULL,                  -- F-001 within its session
  title TEXT NOT NULL, severity TEXT NOT NULL,
  oracle TEXT NOT NULL, confidence TEXT NOT NULL,
  page_key TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_findings_page ON findings(page_key);
```

### 1.3 URL normalization → `page_key`
`normalizePageKey(url): string` — host + pathname, lowercased, no scheme/query/
hash; trailing slash stripped (root stays `/`); **parameterized**: any path
segment that is purely numeric, a UUID, or ≥16 chars of hex/base64-ish id →
`:id`. Examples:
`https://shop.test/item/4711?x=1` → `shop.test/item/:id`;
`…/inventory.html` → unchanged. 🧪 table-test ≥10 cases. This keeps the app
map finite on apps with per-entity URLs.

### 1.4 Replay semantics (`src/memory/replay.ts`)
`replayFlow(flow, project, opts): ReplayResult` — Playwright only, **zero LLM**:
- Start from storageState auth (same as a run); `goto` flow.start page
  (sample_url of `start_page_key`).
- Per step: resolve target by `getByRole(target_role, { name: target_name,
  exact: false })`; if 0 matches → `getByText(target_name)` fallback; if still
  0 or >1 after 5 s → **FAIL at step seq** (no guessing — ambiguity is failure;
  healing is Phase 3's job).
- `fill` with value `'{secret}'` → FAIL at that step with reason
  "flow contains a secret value; secrets are never stored — re-record via a
  charter run" (expected to be rare: auth comes from storageState).
- After each step, if `url_after` set: wait for URL whose page_key matches;
  mismatch after 10 s → FAIL at step.
- Evidence on failure: screenshot, the drained console/network delta, and a
  short replay report folder `reports/<ts>-replay-<slug>/` (reuse Phase 1
  evidence writers; steps.jsonl format unchanged, actor `"harness"`).
- Result updates the flow row: `last_replay_at/result`; a FAIL flips status
  `verified|draft → broken`; a PASS flips `draft → verified` and
  `broken → verified`.
- Hard assertion in code + test: `usage` after replay shows 0 requests for all
  providers.

### 1.5 Planner memory context
When a run starts on a project whose DB has data, `buildMemoryContext(db,
charter)` returns ≤1200 tokens of text appended to the planner's user message:
top pages by visit_count (page_key + title, ≤15), verified flow names +
descriptions (≤15), and open high-severity finding titles (≤5) — all already
redacted at ingestion. Planner prompt gains one rule: "If the charter matches an
existing verified flow, plan objectives that EXTEND or VARY it rather than
re-testing identical ground, and say so in the objective description." No other
prompt changes. If the DB is empty → context omitted entirely (Phase 1
behavior byte-identical; the fixture tests must still pass unmodified).

## 2. Tasks

### P2-T1 — DB module
**Create:** `src/memory/db.ts` (open/migrate/close; WAL; typed row interfaces in
`src/memory/types.ts` — do not widen `src/types.ts`), migration 001 (§1.2).
Add dep `better-sqlite3` + `@types/better-sqlite3`.
🧪 open→migrate→reopen idempotent; schema_version=1.
**Verify:** `sqlite3 memory/magpie.db .schema` (or a dump script) matches §1.2.

### P2-T2 — Normalizer
**Create:** `src/memory/pagekey.ts` per §1.3. 🧪 the table test.

### P2-T3 — Ingestion
**Create:** `src/memory/ingest.ts` — `ingestSession(db, sessionResult, reportDir)`:
insert session row; walk `steps.jsonl` → upsert pages (update last_seen,
visit_count, elements_json from the step's snapshot data where present) and
transitions (from→to with the action label); insert findings with page_key of
the step they occurred on; consume `flows.draft.json` → for each passed
objective create a flow (status draft) + flow_steps, slug from the objective
description (reuse Phase 1 slugger; on collision append `-2`, `-3`…), values
passed through SecretStore → `'{secret}'` where redacted. Skip creating a flow
whose slug already exists with identical steps (idempotent re-ingest).
Wire into `runSession` finalize — ingestion failure must NOT fail the session
(log a warning observation instead). 🧪 ingest a fixture reportDir twice →
identical DB counts (idempotent); secrets fixture → `{secret}` stored, literal
absent from a full DB string dump.

### P2-T4 — Replay engine
**Create:** `src/memory/replay.ts` per §1.4 + `magpie flows replay <slug>`
(flags: `--headed`, `--as <name>`). 🧪 against the Phase 1 fakeapp: record via a
scripted-model session (existing test seam), replay → PASS, usage all zeros;
mutate the fakeapp (rename the button) → replay FAILs at the right seq, status
flips broken, evidence folder exists.

### P2-T5 — Memory CLI
**Create:** `src/cli/memory.ts`, `src/cli/flows.ts`:
`magpie memory show` (counts, top pages, recent sessions), `magpie memory
stats` (DB size, totals), `magpie flows list` (slug, name, status, last
replay), `magpie flows show <slug>` (steps, human-readable), `magpie flows
rename <slug> <new-name>`, `magpie flows verify <slug>`, `magpie flows delete
<slug>` (confirm prompt; cascades). Output: plain tables, no color deps.
**Verify:** each command against the T4 test project; delete → gone from DB.

### P2-T6 — Planner context
**Create:** `src/memory/context.ts` per §1.5; wire into `plan.ts`; add the one
planner-prompt rule. Token cap enforced by character budget (~4 chars/token).
🧪 empty DB → planner messages byte-identical to Phase 1 fixtures; populated
fixture DB → context present, ≤4800 chars, contains no `«redacted»`/`{secret}`
values beyond the placeholders themselves.

### P2-T7 — Docs
README: new "Memory" section (what is stored, where, how to inspect/delete,
the secrets-never-stored guarantee, replay = 0 LLM calls with the economics
sentence), CLI reference update, note on committing memory/ or not.
Config template comment for `memory/`. Update CLAUDE.md status + decision log.

### P2-T8 — Acceptance (self-run; user keys already in .env)
| # | Scenario | Expected |
|---|---|---|
| A1 | Fresh project → `npm run demo` | session ingested: `memory show` lists sessions=1, pages ≥3, flows ≥3 draft |
| A2 | `flows replay <a demo flow>` | PASS, terminal shows "LLM requests: 0", flow → verified |
| A3 | Second `magpie run` with a charter overlapping A1 | planner context visible in prompt log; ≥1 objective description references extending/varying known ground; session completes |
| A4 | Break target: replay a flow against saucedemo with a step whose target_name you edit in DB to nonsense | FAIL at that seq, status broken, evidence folder written |
| A5 | `flows delete` the broken flow | removed; `memory show` consistent |
| A6 | Secret sweep: `strings memory/magpie.db \| grep -iE "secret_sauce\|<first 8 chars of real key>"` | zero hits |
| A7 | Full unit suite + build green; Phase 1 acceptance projects still run (no regression in run mode) |
Fill a Run Log table (scenario, result, attempts, fix) in this file, as in
Phase 1. Same escalation rule: 3 failed fix attempts on one scenario → stop and
write a diagnosis. Track Gemini requests spent; pause if daily quota nears.

## 3. Completion checklist
- [ ] P2-T1…T7 done, per-task commits on `phase-2`
- [ ] A1–A7 pass, Run Log filled
- [ ] `git log --oneline` on the branch reads as a reviewable story
- [ ] CLAUDE.md: Phase 2 COMPLETE + decision log entries (incl. any schema or
      replay-semantics deviations, with reasons)
- [ ] Short handoff message to the user: what memory now does, one command to
      see it (`magpie memory show`), anything deferred
