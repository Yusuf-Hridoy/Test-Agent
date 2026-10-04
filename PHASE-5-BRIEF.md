# PHASE-5-BRIEF.md — Polish & launch

> You (Claude Code) are building Phase 5, the final phase. CLAUDE.md Hard Rules
> apply. **Git protocol (user-operated, unchanged):** no git operations by you;
> end each task with a COMMIT POINT block (files + exact `P5-Tn:` message) and
> wait for "committed". This phase REQUIRES branch `phase-5` and a PR: the
> first COMMIT POINT tells the user to `git checkout -b phase-5` first, the
> handoff ends with push + PR instructions, and the PR stays unmerged until
> the reviewer signs off. Commit this brief with the roadmap flip.

## 0. Goal

Make Magpie presentable, installable, and launchable:
1. `magpie dashboard` — one static HTML overview of a project's entire memory.
2. A README + docs/ that let a stranger succeed in 10 minutes on a free key.
3. Installable: `npx <package>` works from a packed tarball; npm-publish ready.
4. CI: GitHub Actions running the FULL suite (fakeapp tests need no API keys)
   with a green badge in the README.
5. A launch kit: LinkedIn post, article draft, 90-second demo script.
v1.0.0 at the end. No new testing capabilities in this phase — polish only.

## Out of scope (post-1.0 backlog, listed in README as such)
`--resume`, sitemap/robots ingestion, parallel replay, visual-diff oracles,
multi-project dashboard, a served (non-static) dashboard, plugin oracles.

## 1. Tasks

### P5-T1 — `magpie dashboard`
`magpie dashboard [--out <path>]` renders `<project>/dashboard.html` from the
memory DB: header (project, totals, last session); coverage block (pages
visited/frontier, worst-covered pages); flows table (slug, status chip, last
replay, heal history count); findings (NEW vs KNOWN, severity, oracle chips,
linking to report folders via relative paths); sessions timeline (mode badge:
charter/explore/regress, status, LLM requests). Same constraints as reports:
single file, inline CSS, offline, no framework; reuse report rendering helpers
rather than duplicating them. Empty DB renders a friendly getting-started
card, not a crash. 🧪 renders against a fixture DB; empty-DB case; no
absolute paths in the HTML.

### P5-T2 — Packaging
Decide the npm package name: check availability of `magpie-qa`; if taken, use
the scoped `@yusuf-hridoy/magpie` (record choice in the decision log). Set
package.json: version `1.0.0`, description, repository, keywords (qa, testing,
agent, playwright, llm, regression, exploratory), `files` whitelist (dist,
templates, README, LICENSE — audit that no test fixture or fakeapp ships),
`engines.node >= 20`, bin verified. `prepublishOnly`: build + unit tests.
Postinstall note (NOT a script) in README: `npx playwright install chromium`
is a required manual step — do not auto-install browsers on npm install.
🧪 `npm pack` then, in a temp dir, `npm i -g <tarball>` (or npx against it):
`magpie --help`, `magpie init` work. The publish itself is the USER's command
(`npm publish --access public`); print it in the handoff, never run it.

### P5-T3 — README overhaul
Order: one-paragraph pitch (the agent that remembers; explore → charter →
regress for free); badges (CI, npm once published, license); 60-second
quickstart (npx, init, login, one charter run on saucedemo with expected
output snippet); "How memory works" with a compact architecture diagram
(ASCII or inline SVG committed to docs/); the cadence pattern (explore weekly,
charter per feature, regress nightly `--fail-on-skipped`); security model
(what never leaves the machine, what reaches LLM providers, free-tier data
note); honest limitations section (no visual oracles, healing ≠ passing,
coverage = known app only, free-tier rate limits); post-1.0 backlog; link to
docs/. Keep it under ~300 lines; depth lives in docs/.

### P5-T4 — docs/
`docs/config.md` (every field, default, example), `docs/cli.md` (every command
and flag), `docs/memory.md` (schema tour, flow lifecycle draft→verified→broken,
healing semantics), `docs/ci.md` (move/expand the Phase 3 recipe; Actions +
cron; suite.json fields), `docs/faq.md` — positioning answers, factual not
salesy: vs Playwright Test Agents (dev-time codegen vs runtime memory), vs
generic browser agents (session amnesia, evidence, budgets), why free-tier
works (replay = 0 calls). Every doc example must be copy-paste runnable.

### P5-T5 — GitHub CI + repo polish
`.github/workflows/ci.yml`: Node 20, `npm ci`, `npx playwright install
--with-deps chromium`, build, `vitest run` (FULL suite — fakeapp/scripted-model
tests need no API keys; assert in the workflow that no `GOOGLE_*`/`GROQ_*`/
`MISTRAL_*` env is set so a key can never be required accidentally), on push +
PR. Badge wired into README. Also: repo description + topics list for the user
to paste into GitHub settings (printed in handoff; you cannot set them),
`CONTRIBUTING.md` (lite: build, test, phase-brief workflow), issue template
(bug report asking for steps.jsonl excerpt + magpie version).

### P5-T6 — Launch kit → `launch/` (committed; it's part of the portfolio)
- `launch/linkedin-post.md`: ≤150 words + suggested image = dashboard
  screenshot; hook on the memory thesis ("your 100th test run shouldn't start
  from zero"); no employer mentions.
- `launch/article.md`: 800–1200 word draft, "I built a testing agent that
  remembers the app" — problem (session amnesia + rerun cost), the four-layer
  architecture, the honest bits (healed ≠ passed, coverage honesty, criterion
  misses found by acceptance), free-tier economics with the replay-=-0-calls
  number from a real Run Log, what's next. First person, engineer voice, no
  hype adjectives.
- `launch/demo-script.md`: 90-second screen recording script: init → login →
  charter run (narration lines on screen) → report open → break the fakeapp →
  regress catches it citing last pass → dashboard. Timestamped beats.
🧪 none — but every number quoted must come from a real Run Log or report in
the repo (cite which, in an HTML comment), per Hard Rule 9.

### P5-T7 — Acceptance D1–D7 (self-run; Run Log in this file)
| # | Scenario | Expected |
|---|----------|----------|
| D1 | `magpie dashboard` on the Phase 4 acceptance project | renders offline; counts reconcile with `memory show`; links resolve to report folders |
| D2 | Dashboard on a fresh empty project | getting-started card, exit 0 |
| D3 | `npm pack` → install tarball in a clean temp dir → `magpie --help`, `init`, `login --help` | all work; package contains no fixtures/fakeapp/tests (`tar -t` audit) |
| D4 | Push branch → Actions run | full suite green in CI, badge resolves |
| D5 | Follow README quickstart verbatim in a fresh directory (your real key) | a stranger's path works end to end; any stumble = fix the README, not the user |
| D6 | Docs audit: run every copy-paste example in docs/ | all runnable as written |
| D7 | Secret + employer sweep over README, docs/, launch/ | zero key prefixes, zero employer/workplace names |

## 2. Completion checklist
- [x] T1–T6 done. T1–T5 committed on `phase-5`; **T6 (`launch/`) is still
      uncommitted** — see the handoff.
- [x] D1, D2, D3, D6, D7 pass; Run Log filled. **D4 and D5 remain with the
      user** (a push, and a real key).
- [x] CLAUDE.md: decision log updated; roadmap flips to all-green once D4/D5
      land.
- [x] Handoff delivered: push + PR, npm publish, GitHub description/topics,
      the v1.0.0 tag after review + merge, and the launch order.

## 3. Run Log (P5-T7, self-run 2026-10-04)

**D1, D2, D3, D6, D7 PASS. D4 and D5 are blocked on the user** — D4 needs the
branch pushed before Actions can run, D5 spends real Gemini quota on the user's
key. Nothing was faked to close them.

| # | Result | What happened |
|---|--------|---------------|
| D1 | **PASS (on a substitute project — see below)** | Counts reconcile exactly with `memory show`: sessions 3, pages 2, transitions 2, flows 2, findings 1. All 3 report links resolve to real `index.html` files on disk. Offline: 0 `<script>`/`<link>` tags, 0 external refs, 0 absolute paths. Rendered through Chromium and inspected: coverage block, least-exercised pages, open frontier, flows table with status chips and last-replay results, the finding under **New in the latest run**, and a 3-row sessions timeline badged `regress` / `charter` / `charter`. |
| D2 | **PASS** | `magpie init` then `magpie dashboard` on an empty project: getting-started card rendered, **exit 0**, no Coverage section, no crash. |
| D3 | **PASS** | `npm pack` → 60 files, 100 kB. `tar -tzf` audit for `__tests__\|fakeapp\|fixture\|test-projects\|launch/\|docs/\|scripts/\|.map\|.ts\|BRIEF\|CLAUDE` → **zero matches**; the tarball holds only `dist/`, `templates/`, `README.md`, `LICENSE`, `package.json`. Installed into a clean temp project: `magpie --version` → `1.0.0`, `--help` lists all six commands, `init` scaffolds, `login --help` works, and `dashboard` renders (so templates resolve from the installed `dist`). |
| D4 | **BLOCKED — needs the user to push** | Workflow written and YAML-validated. The no-key guard was tested both ways locally: clean env passes; with `GEMINI_API_KEY` set it fails and prints `GEMINI_API_KEY=<redacted>`, never a value. The CI condition itself was reproduced locally — this machine has no provider key in its environment, and the full suite is **264 green** under exactly that condition. Only the Actions run and the badge resolving remain unverified. |
| D5 | **BLOCKED — needs the user's Gemini key** | Everything in the quickstart that does not spend quota was verified: `magpie init` and `magpie dashboard` run from the globally-installed tarball (D3), and every `magpie …` line in the README was checked against the built CLI's own `--help` (T4). The live charter run against saucedemo is the user's to perform. |
| D6 | **PASS** | Every copy-paste example executed, not read. All 8 read-only `docs/cli.md` commands and all 13 `--help` invocations: OK. `docs/memory.md`: `sqlite3 .schema`, the flows query and the `heal_events` audit join all run; `flows rename` and `flows delete -y` run against a copy. `docs/ci.md`: the `jq '[.findings[] \| select(.status == "NEW")] \| length'` recipe runs against a real `suite.json` → `0`. `docs/config.md`: all 6 YAML blocks fed through the real `parseConfig` → valid. Both `docs/ci.md` workflow blocks parse as YAML. All local markdown links across README, CONTRIBUTING and docs resolve → **0 broken**. |
| D7 | **PASS** | Over `README.md`, `docs/`, `launch/`, `CONTRIBUTING.md` and `.github/`: zero Google/Groq/OpenAI/Slack key prefixes; zero opaque tokens (the only long strings are a flow slug and report folder names); zero employer or workplace names; `secret_sauce` appears nowhere outside `scripts/demo.ts`, which CLAUDE.md designates as its one allowed home; no `.env` or `.auth/` file is tracked by git. |

### D1's substitution, stated plainly

**The Phase 4 acceptance project no longer exists on this machine.** A
filesystem-wide search for `magpie.db` found only the empty databases created
during this phase's own smoke tests. Phase 4's projects were not committed
(`reports/` and `memory/` are gitignored) and have since been removed.

Rather than report D1 unverifiable, I built an equivalent project **through the
real code path**: two charter sessions driven by `runSession` against the test
suite's fixture shop — real planner, real browser, real oracles, real evidence,
real `ingestIntoMemory` — followed by a real `magpie run --regress all
--include-draft` through the built CLI, which replayed both flows in 0.8 s each
and reported `LLM requests: 0`. Only the model's replies were scripted; no row
was hand-inserted. The resulting database is as real as Phase 4's was, and
carries all three session modes the dashboard has to render.

Two things that is genuinely weaker than the literal scenario: the pages and
findings come from a 5-page fixture rather than saucedemo, and no model
provider was involved. Neither affects what D1 tests — that the dashboard
reconciles with memory and links resolve.

### Found during acceptance

1. **The harness rejected my first two scripted plans** (`PLAN_FAILED`) because
   they had 2 objectives and `MIN_OBJECTIVES` is 5. Not a defect — the planner
   validation doing its job, and worth recording because it is the kind of
   thing that looks like a bug for ten minutes.
2. **`CLAUDE.md` pointed at a file that does not exist** —
   `PHASE-1-ACCEPTANCE-BRIEF.md`, deleted in `ee691c1`. Fixed during T6 to name
   the commit it can be recovered from; the recovery command was verified.
3. **No defect was found in Phase 5's own code.** Worth saying rather than
   leaving implied: unlike Phases 1–4, acceptance here changed no behaviour.
   This phase ships no new testing capability, which is the point of it.
