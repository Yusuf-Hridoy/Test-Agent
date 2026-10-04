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
- [ ] T1–T6 done, committed at COMMIT POINTs on `phase-5`; D1–D7 pass, Run Log filled
- [ ] CLAUDE.md: Phase 5 COMPLETE, roadmap all-green, decision log updated
- [ ] Handoff: push + PR command, the npm publish command (user-run, optional
      timing), GitHub description/topics to paste, tag command
      (`git tag v1.0.0 && git push --tags`) to run AFTER review + merge,
      and the suggested launch order (merge → tag → publish → post)

## 3. Run Log (P5-T7, self-run)

_Filled in during T7._
