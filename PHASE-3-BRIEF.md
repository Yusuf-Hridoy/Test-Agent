# PHASE-3-BRIEF.md — Regression, memory oracles, healing

> You (Claude Code) are building Phase 3. CLAUDE.md Hard Rules apply.
> **Git protocol:** branch `phase-3`, one commit per task (`P3-Tn:` /
> `fix(P3-Tn):`), no squash; merge via PR after the completion checklist.
> Commit this brief. Update CLAUDE.md roadmap: Phase 3 → CURRENT.

## 0. Goal

Magpie becomes a nightly-runnable regression system:
1. **Fidelity first:** replay can target "the 3rd 'Add to cart' button" —
   the structural gap acceptance found (`target_nth`, migration 002).
2. `magpie run --regress <slug|all>` replays flows as a suite: zero LLM by
   default, suite report, CI-ready exit codes and `--json`.
3. **Memory-based oracles:** "this flow passed in session N, fails now" becomes
   a first-class finding with oracle `regression`, confidence high, citing the
   last pass. Recurring slow pages become a low-severity `performance` finding.
4. **Healing (opt-in):** a failed step may ask the LLM once to re-locate the
   intended element; a healed flow is patched but demoted to `draft` until it
   passes a clean, heal-free replay. Honest accounting: healed ≠ passed.
5. **Finding dedup:** the same defect seen across sessions reports as KNOWN
   (first seen, count), so nightly reports surface only what's NEW.

## Out of scope (Phase 4+)
`--explore`, coverage matrix, dashboards, parallel replay, visual-diff oracles,
auto-scheduling (docs show a cron/Actions example; Magpie itself does not
schedule), `auth.probe_url` (still deferred — reassess in Phase 4).

## 1. Design decisions (fixed)

### 1.1 Migration 002
```sql
ALTER TABLE flow_steps ADD COLUMN target_nth INTEGER;      -- 0-based; NULL = legacy
ALTER TABLE findings  ADD COLUMN fingerprint TEXT;         -- see §1.5
ALTER TABLE findings  ADD COLUMN first_seen_session INTEGER;
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL, page_key TEXT, detail TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_obs_page ON observations(page_key, type);
CREATE TABLE heal_events (
  id INTEGER PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, old_target TEXT NOT NULL, new_target TEXT NOT NULL,
  model_note TEXT, session_ref TEXT, created_at TEXT NOT NULL);
UPDATE schema_version SET v = 2;
```

### 1.2 Recording `target_nth` (P3-T1)
At action time the browser layer already holds the acted-on Locator. Before
executing click/fill/select, compute: among elements matching the SAME
role+accessible-name resolution replay will use, which index is this element?
Store it into the step record → flows.draft.json (`targetNth`) → ingestion.
Replay resolution order becomes: exact name → substring → text; if >1 match and
`target_nth` is set → `.nth(target_nth)`; if >1 and NULL (legacy flow) → FAIL
as today, message now says "re-record to gain nth targeting". A flow recorded
from Phase 3 onward on a catalogue page must replay correctly.

### 1.3 Regression mode (P3-T2)
`magpie run --regress <slug>|all` (flags: `--include-draft`, `--heal`,
`--json`, `--headed`, `--as <name>`):
- Selects `verified` flows (`all`), plus drafts only with `--include-draft`;
  `broken` flows are listed as SKIPPED (fix path: heal or re-record) — never
  silently ignored.
- Replays sequentially, one browser context per flow (isolation beats speed in
  v1). Per-flow outcome: PASS | FAIL@seq | REFUSED@seq | HEALED(→draft) |
  SKIPPED. Suite report folder `reports/<ts>-regress/`: index.html (suite
  table + per-flow evidence links), suite.json (machine-readable; `--json`
  prints it to stdout as the ONLY stdout output, logs to stderr).
- Exit codes: 0 all pass (healed counts as NOT pass → exit 1), 1 ≥1 fail/healed,
  2 environment (envmon rules apply mid-suite: abort remaining, mark UNTESTED),
  3 config/auth.
- Hard assertion + test: with `--heal` absent, usage is all-zero after the
  whole suite.

### 1.4 Oracles (P3-T3)
- **regression** (confidence: high): a flow whose last_replay_result was `pass`
  (or status verified) now FAILs → Finding{oracle:"regression"} carrying: failed
  step, last-pass timestamp + session ref, replay evidence. Written to the
  suite report AND ingested into findings.
- **performance** (confidence: low, severity: low): at ingestion, if the same
  page_key has a `slow_page` observation in ≥3 consecutive sessions that
  visited it → one finding (dedup via fingerprint so it doesn't repeat nightly).
- Extend the `Oracle` type union with `"regression" | "performance"`; Phase 1
  report renders them with distinct chips.

### 1.5 Finding dedup (P3-T5)
`fingerprint = sha1(normalize(title) + "|" + page_key + "|" + oracle)` where
normalize lowercases and strips digits/ids. On ingestion: fingerprint exists →
increment occurrence (store first_seen_session on first insert), report marks
**KNOWN (seen N× since <date>)**; else **NEW**. Suite + run reports get a
"New findings" section above "Known". No auto-closing: absence of a finding is
not proof of fix in v1 (say so in README).

### 1.6 Healing (P3-T4) — opt-in, bounded, honest
Trigger: replay FAIL@seq with `--heal` (or config `regress.heal: true`).
One `askModel` call per failed step, max `regress.max_heal_calls` per suite
(default 10): system prompt (new, ≤35 lines, in prompts.ts) gives the flow
description, the failed step (action, old role+name+nth, value placeholderized),
the current snapshot, and demands STRICT JSON:
`{"verdict":"relocated","target":{"role":..,"name":..,"nth":..},"note":..}` or
`{"verdict":"broken","note":..}`.
- `relocated` → retry the step with the new target (guard-checked!). Success →
  continue flow; on flow completion: write heal_events row, PATCH flow_steps
  with the new target, set status `draft`, outcome HEALED. Failure of the
  retried step → outcome FAIL (no second opinion on the same step).
- `broken` → outcome FAIL; the regression finding gains model_note as context
  (finding stays oracle:"regression", confidence high — the FLOW failing is the
  evidence; the note is commentary).
- Healed-then-verified lifecycle: next clean replay (no heal used) promotes
  draft → verified, as Phase 2 already does. Never heal a REFUSED step.
- All heal I/O passes the SecretStore; `{secret}` values are never sent.

## 2. Tasks
- **P3-T1** migration 002 + nth recording end-to-end (browser layer → draft →
  ingest → replay). 🧪 fakeapp with two identical buttons: recorded flow replays
  the correct one; legacy NULL flow still fails with the re-record message.
- **P3-T2** regression runner + suite report + `--json` + exit codes.
  🧪 scripted suite: pass+fail+skip mix → correct outcomes, exit 1, valid
  suite.json (add a zod schema for it and validate in test).
- **P3-T3** oracles: regression finding wiring; performance observation
  ingestion + threshold. 🧪 both, incl. fingerprint dedup of the performance
  finding across 4 fixture sessions.
- **P3-T4** healer. 🧪 scripted model: relocated-success patches flow + demotes
  to draft + heal_events row; relocated-but-retry-fails → FAIL; broken verdict;
  heal budget exhausts; REFUSED never healed; zero heal calls without flag.
- **P3-T5** dedup + NEW/KNOWN in run and suite reports. 🧪 same finding across
  two ingested sessions → KNOWN(2×).
- **P3-T6** CI: docs page with a GitHub Actions workflow example (`magpie run
  --regress all --json`), non-interactive guarantees (no prompts in regress
  mode — audit and fix any), cron example. suite.json documented field-by-field.
- **P3-T7** README/CLAUDE.md updates; decision log for any deviation.
- **P3-T8** Acceptance (self-run, fill Run Log in this file; same escalation +
  quota rules as Phase 2):

| # | Scenario | Expected |
|---|---|---|
| B1 | Record a catalogue flow on saucedemo ("add the 3rd product"), replay | PASS via target_nth, 0 LLM |
| B2 | `run --regress all` on the acceptance project | suite report; verified flows PASS; broken listed SKIPPED; exit reflects results; usage all-zero |
| B3 | Mutate a flow's target in DB to a name that exists under a different label on the page; `--regress <slug> --heal` | HEALED: step relocated, flow patched, status draft, heal_events row, exit 1 |
| B4 | Clean replay of the healed flow (no --heal) | PASS → verified |
| B5 | Break the app for real (fakeapp control: remove the element); regress with --heal | model verdict broken OR relocate-retry fails → FAIL, regression finding (high conf) citing last pass |
| B6 | Ingest the B5 session twice / rerun regress | finding reported KNOWN(2×), NEW section empty on second report |
| B7 | `--regress all --json > s.json` | stdout is exactly the JSON, schema-valid; logs on stderr |
| B8 | Secret sweep: strings over db+wal+shm, grep suite reports for key prefixes and `secret_sauce` | zero hits (incl. heal prompts log) |
| B9 | Full suite + build green; Phase 1/2 fixtures unmodified still pass |

## 3. Completion checklist
- [ ] T1–T7 done, per-task commits on `phase-3`; B1–B9 pass, Run Log filled
- [ ] CLAUDE.md: Phase 3 COMPLETE + decision log; PR opened, NOT self-merged —
      reviewer reads the branch first (the user merges after review)
- [ ] Handoff message: what regression mode does, the one-liner for nightly CI,
      healed-vs-passed distinction explained in one sentence, anything deferred
