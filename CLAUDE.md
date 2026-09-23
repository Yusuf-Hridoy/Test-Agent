# CLAUDE.md — Project Brain

> **You (Claude Code) are the sole developer of this project.** Before writing any
> code, also read the current phase brief (e.g. PHASE-1-BRIEF.md) in full. When you
> complete a task: run its Verify block yourself (you can execute commands), then
> update the "Current status" section at the bottom of this file. Never work outside
> the current phase's scope. Never violate a Hard Rule.
>
> **Runtime model layer is fixed:** the built agent runs on the user's free-tier
> keys (Gemini/Groq/Mistral) via the Vercel AI SDK. Do NOT substitute the Anthropic
> API or Claude Agent SDK into the product's runtime, even though you yourself are
> Claude — the developer has no paid Anthropic key.

---

## 1. What we are building

**Working name: Magpie** (magpies remember faces for years — rename later if desired).

Magpie is an **open-source, self-hosted web-testing agent with persistent memory**.
A QA engineer points it at a web application; it performs exploratory or instructed
(charter-based) testing by driving a real browser, and — unlike every generic browser
agent — it **remembers the application across runs**: the page map, named business
flows, and past findings. Remembered flows replay deterministically with zero LLM
calls, so regression runs are nearly free.

One-line pitch: *"The testing agent that remembers your app."*

Primary user: a QA engineer at a terminal. Interface: CLI. A dashboard may come in a
late phase — never before.

## 2. Why it exists (context the code must serve)

- Generic agents (browser-use, Claude-style agents) can test once, but forget
  everything between sessions; every run re-discovers the app at full LLM cost.
- The winning economics: **explore expensively once → compile to deterministic
  replay → spend LLM tokens only on novelty and healing.**
- Evidence is the product in QA: every finding must ship with repro steps,
  screenshots, traces, console/network logs. A finding without evidence is worthless.
- The developer runs entirely on **free-tier LLM APIs** (Gemini, Groq, Mistral).
  The architecture must work within free-tier rate limits and must never assume a
  paid key exists.

## 3. Architecture (four layers)

```
┌──────────────────────────────────────────────────────┐
│ REASONING  — LLM via Vercel AI SDK (provider-agnostic)│
│   plans the session, chooses actions, judges results  │
├──────────────────────────────────────────────────────┤
│ HARNESS    — deterministic TypeScript (NO LLM)        │
│   budgets, loop detection, retries, checkpoints,      │
│   auth check, scope guard, evidence capture, report   │
├──────────────────────────────────────────────────────┤
│ EXECUTION  — Playwright (Chromium)                    │
│   navigate / observe / act / assert, storageState auth│
├──────────────────────────────────────────────────────┤
│ MEMORY     — SQLite (Phase 2+)                        │
│   app map, named flows, episodic findings, baselines  │
└──────────────────────────────────────────────────────┘
```

**Division of labor (memorize this):** the LLM decides *what to test* and *what
things mean*. Plain code decides *when to stop, retry, and give up*. Budgets and
safety are NEVER enforced by prompting — always by the harness.

## 4. Stack decisions (final — do not substitute)

| Concern            | Choice                                   | Why |
|--------------------|------------------------------------------|-----|
| Language           | TypeScript (Node ≥ 20)                   | Playwright-native, developer's home turf |
| Browser            | Playwright (`playwright` npm)            | traces = best evidence format in QA |
| Agent loop         | Vercel AI SDK (`ai` v5) + provider pkgs  | provider-agnostic tool-calling loop; works with free tiers |
| Model providers    | `@ai-sdk/google` (primary, vision), `@ai-sdk/groq`, `@ai-sdk/mistral` (fallbacks) | user's available free keys |
| Persistence        | SQLite via `better-sqlite3` (Phase 2+)   | zero-ops, file-based, portable |
| Config             | YAML (`yaml` pkg) + `.env` (`dotenv`)    | human-editable; secrets separated |
| CLI                | `commander`                              | boring and reliable |
| Validation         | `zod`                                    | tool schemas + config validation |
| Report             | self-contained single HTML file (no framework) | attachable to tickets, opens anywhere |

Explicitly rejected: Claude Agent SDK (needs paid Anthropic key), Stagehand (loses
Playwright traces; cloud gravity), any vector DB (overkill), any web framework
before the dashboard phase.

## 5. Repository layout

```
magpie/
  src/
    cli/            command definitions (init, login, run, report)
    config/         config schema (zod), loader, .env handling
    model/          provider adapter, rate limiter, fallback chain, redaction
    browser/        Playwright wrapper: session, snapshot, actions, evidence hooks
    agent/          the loop: system prompt, tools, charter planner
    harness/        budgets, loop detector, checkpoints, scope guard, auth check
    evidence/       step logger, screenshot/trace management, finding builder
    report/         HTML + terminal report generators
    memory/         db + migrations, page-key normalizer, ingest, replay, planner context
  templates/        report HTML template
  test-projects/    example generated project folder (docs/demo)
  package.json  tsconfig.json  README.md  CLAUDE.md  PHASE-*-BRIEF.md
```

A **project folder** (created by `magpie init`, lives anywhere on the user's disk):

```
<project>/
  magpie.config.yaml    # url, scope, budgets, model prefs — safe to commit
  .env                  # secrets — gitignored
  .auth/                # storageState session files — gitignored
  memory/               # SQLite db + compiled flows (Phase 2+) — commit optional
  reports/<timestamp>/  # per-run output: index.html, steps.jsonl, shots/, trace.zip
  .gitignore            # generated: .env, .auth/, reports/
```

## 6. Hard Rules (violating any of these = failed task)

1. **Secrets:** credentials only in `.env`; storageState only in `.auth/`; both
   gitignored by generated projects. Config files never contain secrets.
2. **Redaction:** cookies, tokens, Authorization headers, password field values are
   NEVER included in any prompt sent to any LLM provider. Redact before sending.
3. **Harness enforces limits:** max steps, max LLM requests, max duration, and
   loop detection are implemented in plain code that wraps every agent step.
   The loop CANNOT exceed budgets regardless of what the model outputs.
4. **Scope guard:** the browser layer refuses navigation outside `scope.include`
   or into `scope.exclude`; refuses clicks on elements matching
   `forbidden_elements` (defaults include: logout, delete, remove, billing/payment
   actions). Refusals are logged as steps, returned to the model as tool errors.
5. **Evidence always:** every step is appended to `steps.jsonl` as it happens
   (crash-safe). Every finding gets: repro steps, before/after screenshots,
   console errors, failed network requests, and the Playwright trace reference.
6. **Environment ≠ product:** connection failures, DNS errors, mass 5xx on
   previously-working pages → status `ENVIRONMENT_DOWN` after bounded retries;
   never reported as an application bug.
7. **Free-tier discipline:** a configurable minimum delay between LLM calls
   (default 7000 ms for Gemini free tier); on 429/quota errors, retry once after
   backoff, then fail over to the next provider in the chain; count requests per
   provider and stop the session gracefully when `budget.max_llm_requests` is hit.
8. **Findings carry their oracle:** every finding records WHICH oracle fired
   (`console_error`, `http_5xx`, `http_4xx_unexpected`, `crash`, `llm_judgment`,
   later `regression`) and a confidence level. `llm_judgment` findings are always
   marked low-confidence.
9. **No fake output:** if something cannot be verified, report BLOCKED with the
   reason and evidence — never invent a pass or a failure.

## 7. Coding conventions

- Strict TypeScript (`"strict": true`); no `any` unless justified by a comment.
- Every module exports a small, testable surface; side effects live at the edges.
- Errors are typed results where practical; the CLI translates them to exit codes
  (0 = ran, findings or not; 2 = blocked/environment; 3 = config/auth error).
- Log lines are structured (JSON to file, pretty to terminal).
- Keep dependencies minimal; prefer the standard library.
- Write a smoke test per module when cheap (`vitest`), but do not gold-plate:
  ship working over perfect. Manual verification steps are listed in each brief.

## 8. Phase roadmap

| Phase | Deliverable | Status |
|-------|-------------|--------|
| 1 | Execution core: init/login/run(charter), agent loop on free-tier models, harness, evidence, HTML report | complete (2026-09-19) |
| 2 | Memory: SQLite app map, named flows, flow compilation to deterministic replay | complete (2026-09-23) |
| 3 | Regression mode: replay compiled flows, memory-based oracles, LLM healing on breakage | **CURRENT** |
| 4 | Explore mode: coverage matrix, scenario planner, CI integration | pending |
| 5 | Polish: dashboard, docs site, public launch | pending |

Only the CURRENT phase's brief is authoritative. Do not implement future phases
early, even partially, unless the brief says to leave a seam for them.

## 9. Session protocol for the builder

1. Read the current phase brief fully (this file is auto-loaded).
2. Check "Current status" below; continue from the first unfinished task.
3. Work task by task, in order. After each task: execute the brief's Verify
   block yourself (unit tests, smoke scripts, CLI invocations); only live-run
   steps that need the user's API keys or manual login are handed back to the
   user as a short checklist. Then update "Current status".
4. If a decision is genuinely not covered by CLAUDE.md or the brief, choose the
   simplest option consistent with the Hard Rules, and record the decision in
   the Decision log below.
5. Never commit or print the contents of .env or .auth/; never paste user
   secrets into chat output or logs.

## 10. Decision log

- 2026-09-18: scope globs use `host/**` (not the brief's `host/*`) as the init default — minimatch's `*` does not cross `/`, so `host/*` would refuse every nested path (e.g. /inventory/item.html) and make the scope guard unusable. Globs match `host + path`, no scheme.
- 2026-09-18: model IDs pinned in `src/model/providers.ts` after checking provider docs — gemini `gemini-2.5-flash` (vision + tools, long-established free tier; Gemini 3.x flash models exist but the docs do not state their free-tier status, so the safer ID is the default and `model.ids.gemini` overrides it), groq `openai/gpt-oss-120b` (production tool-use model, **no vision** → `look` degrades on failover to it), mistral `mistral-small-latest` (alias for Mistral Small 4: tool calling + image input).
- 2026-09-18: `askModel`, `planSession` and `runSession` each take an optional `generate` function as a test seam — production callers omit it and get the real `generateText`. This is what lets the whole loop be tested against a local app with a scripted model and no API key.
- 2026-09-18: browser contexts get a tiny init script defining `__name` — esbuild (via tsx) rewrites local functions inside `page.evaluate` to `__name(fn,"fn")`, a helper that does not exist in the page. Compiled `dist/` never hits this; the shim keeps `npm run dev` / `npm run demo` working.
- 2026-09-18: snapshots tag elements with `data-magpie-id` in the DOM rather than matching by index — index matching breaks the moment the page mutates, and element ids must stay valid until the next action.
- 2026-09-18: the redactor's sensitive-key rule requires an assignment (`key:` / `key=`), not the brief's bare `[":= ]` — matching a space truncated ordinary prose ("no valid session — run `magpie login`") without protecting anything extra, since literal secret values are always masked by the secrets pass.
- 2026-09-18: redaction is applied at every write boundary (narration, objective notes, findings, observations, and the serialized checkpoint.json / session.json), not only to prompts — the integration test proved model-authored text otherwise carries secrets into the report.
- 2026-09-18: evidence is drained ~400 ms after an action, and again when an objective ends — requests a click kicks off resolve after the click returns, and without the delay their 5xx landed on the *next* objective.
- 2026-09-18: `magpie login` discards its Playwright trace (`closeBrowser` without a path) — a recording of a human typing their password is not evidence anyone wants on disk.
- 2026-09-18: `auth.probe_url` config field deferred to Phase 2 — `base_url` currently doubles as the session probe (documented in the config template, README and both CLI messages).
- 2026-09-18 (acceptance S0): gemini default changed `gemini-2.5-flash` → `gemini-3.6-flash`. The 2.5 ID is still returned by ListModels but `generateContent` refuses it: "no longer available to new users … use models/gemini-3.6-flash". Google's own error names the replacement, so that is what is pinned; ListModels is not a reliable availability signal for a given key.
- 2026-09-18 (acceptance): `GEMINI_API_KEY` is accepted as an alias for `GOOGLE_GENERATIVE_AI_API_KEY` (gemini-cli and the Google Python SDK use that name, so a key copied from either works unrenamed). Root `.gitignore` now ignores `.env`, `.auth/` and `reports/` anywhere in the tree, not just in generated projects.
- 2026-09-18 (acceptance S1): gemini default changed `gemini-3.6-flash` → `gemini-3.1-flash-lite`. Measured on the user's free-tier key: `gemini-3.6-flash` returns 429 `GenerateRequestsPerDayPerProjectPerModel-FreeTier value=20` — twenty requests **per day**, which a single Magpie session (30–60 calls) exhausts on its own. Quota buckets are per-model, and flash-lite survived when 3.6-flash was already exhausted. Verified on flash-lite: tool calling (`click({"id":"e1"})`), vision on a real screenshot, ~1.5s latency, `thoughtsTokenCount=0`. A free-tier default must be a model whose quota can sustain a whole session.
- 2026-09-18 (acceptance): `gemini-flash-latest` was rejected as a default — the moving alias timed out after 40s in a live probe while pinned IDs answered in 1.5–5s. Pinned IDs also keep runs reproducible, which is the point of a QA tool.
- 2026-09-18 (acceptance S5): `runSession` now redacts the `SessionResult` it RETURNS, not only the copy written to `session.json`. The planner quotes credentials it reads off the page (saucedemo publishes them on its login form), and the terminal summary and HTML report render the returned object — so secrets reached both while the JSON file looked clean.
- 2026-09-18 (acceptance S2): element ids fall back to role+name when a re-render strips the `data-magpie-id` tag; React replaces nodes between snapshot and click, which was costing 15s timeouts on saucedemo. Findings also carry only the last 6 steps as repro rather than the whole objective.
- 2026-09-19 (acceptance S3): a dead server parks Chromium on `chrome-error://chromewebdata/`, which the scope guard read as an out-of-scope navigation and "corrected" by navigating back — so an outage was silently reclassified as a scope violation and the objective was wrongly blocked. Browser error pages are now reported as navigation failures carrying `net::ERR_FAILED`, which the environment classifier recognises.
- 2026-09-19 (acceptance S3/S4): `askModel` distinguishes connection failures from quota/auth failures (`ModelExhaustedError.networkFailure`), and the harness finalizes ENVIRONMENT_DOWN — after the normal recovery window — when no provider is reachable. Without this a real Wi-Fi outage ended the session as BUDGET_EXHAUSTED, because the model call fails before any browser action can be classified. Provider-unreachable-but-app-up is also bounded, instead of spinning the step budget on a retry that cannot help.

- 2026-09-23 (P2-T1): `src/memory/db.ts` holds the shared typed queries as well as open/migrate/close. Ingest, replay, the CLI and the planner context all need the same handful of reads; a separate store module would only have forwarded to this one.
- 2026-09-23 (P2-T2): a path segment counts as an id when it is purely numeric, a UUID, ≥16 chars of hex, **or** ≥16 chars of base64url that contains both a digit and an uppercase letter. The last clause is the deviation worth knowing: length alone would collapse readable slugs (`add-cheapest-item-to-cart`, `2026-09-18-release-notes`) to `:id` and the app map would lose exactly the pages a tester cares about. Real opaque ids (ULIDs, Stripe keys, base64url tokens) carry both.
- 2026-09-23 (P2-T3): `FlowAction` gained `fromUrl` (the pre-action URL). The draft only recorded the URL *after* each action, so a flow's start page was unknowable — and replay has to begin somewhere. Drafts written before this change still ingest; their `start_page_key` is the first action's post-action URL, i.e. approximate.
- 2026-09-23 (P2-T3): ingestion is idempotent **by report directory** — a run already in `sessions` is skipped whole. Upserting instead would keep row counts stable but silently double `visit_count` on every re-ingest, which is the number the planner ranks pages by.
- 2026-09-23 (P2-T3): `visit_count` counts *arrivals*, not steps. A page the agent poked at twenty times is not twenty times more interesting than one it saw once.
- 2026-09-23 (P2-T4, replay-semantics deviation): a **guard refusal** records `refused@<seq>` and leaves the flow's status untouched, where the brief says a FAIL flips it to `broken`. Adding an element to `forbidden_elements` says nothing about the application, and marking the flow broken would read as a regression in the app under test. A refusal exits 3 (configuration), not 1 (failed test).
- 2026-09-23 (P2-T4): target resolution tries exact name, then substring, then text, before declaring 0-or->1 a failure. Exact-first is a refinement of §1.4, not a relaxation: it removes *false* ambiguity (a "Cart" target also matching "Add to cart") without ever choosing between genuine matches.
- 2026-09-23 (P2-T4): exit code 1 added for a failed replay (Phase 1 defined 0 ran / 2 environment / 3 config). CI has to be able to see a broken flow, and a failed test is not an environment problem.
- 2026-09-23 (P2-T5): `magpie flows verify <slug>` is deliberately a thin alias for `replay` — it promotes only on a real PASS. If `verified` could be set by hand it would be an opinion, and `flows list` would stop being trustworthy.
- 2026-09-23 (P2-T6): the planner rule about extending known ground lives in `PLANNER_SYSTEM_PROMPT` unconditionally, while the memory briefing is appended to the *user* message only when the project has memory. That keeps the planner `messages` byte-identical to Phase 1 on a first run, which is what the fixture tests assert.
- 2026-09-23 (P2-T8): acceptance A1 came back partial — the demo session never left `/inventory.html`, so the map held one page. Diagnosed as a faithful record rather than a defect (`form-login` authenticates before the first step is logged, and the badge charter does not navigate); the map reached 5 pages once a navigational charter ran. Logging the login page would mean snapshotting inside `ensureAuthenticated`, which is Phase 1 code and outside this brief.

## 11. Current status

- Phase: 3 — **in progress**, started 2026-09-23 on branch `phase-3`. Brief: PHASE-3-BRIEF.md (in the repo).
- Phase 2 — complete, acceptance run 2026-09-23, merged to `main` the same day (PR #1); the per-task `P2-Tn:` commits are unsquashed on main. Brief + Run Log: PHASE-2-BRIEF.md.
- Scenario results: **A2–A7 PASS**. **A1 PARTIAL** — `pages=1` instead of ≥3 because every objective of the demo charter ran on `/inventory.html`; diagnosed in the Run Log as a faithful record, not a defect (the map reached 5 pages / 4 transitions under a navigational charter).
- What works, measured live against www.saucedemo.com: three sessions ingested (≈73 Gemini requests total); a 4-step checkout-form flow recorded by the agent **replays in 2.0 s with zero model calls**; a flow broken on purpose fails at the exact step with screenshot, trace and all-zero usage; the third session's planner referenced a finding remembered from the first. 194 tests green, build clean.
- Known limitation, top candidate for Phase 3: **ambiguous targets**. `flow_steps` records role + accessible name only, so "add *this* item" on a catalogue page (six identical "Add to cart" buttons on saucedemo) cannot be replayed and fails by design. The fix is fidelity, not healing — record which of the N matches was acted on (`target_nth`, migration 002).

### Phase 1 (complete 2026-09-19), for reference

- Scenario results: **S0, S1, S2, S5, S6, S7, S8 PASS** as specified. **S3, S4 PASS by simulation** — a local server made unreachable on cue (state preserved) standing in for the Wi-Fi toggle, which no agent can perform. S7's `git status` half is N/A: the user chose to skip `git init`.
- Live running found and fixed **19 real defects**; PHASE-1-ACCEPTANCE-BRIEF.md carries the per-scenario Run Log with root causes. 141 tests green, build clean.
- Outstanding, by choice rather than blockage:
  - The literal Wi-Fi-toggle runs of S3/S4 (~5 min by hand) — projects prepared at `test-projects/s3-transient` / `s4-sustained`. The simulation covers the same code paths; the untested delta is the LLM provider being unreachable at the same time, which is covered by `src/harness/__tests__/outage.test.ts` instead.
  - No per-scenario commits exist: git was initialised after acceptance, so all of Phase 1 landed in a single `first commit`.
- Model note: `gemini-2.5-flash` is retired for new keys; `gemini-3.6-flash` allows 20 requests/day on the free tier. Pinned default is `gemini-3.1-flash-lite` (tools + vision, ~1.5s, own quota bucket). Groq `openai/gpt-oss-120b` is the verified fallback and has no vision, which exercises the screenshot-degradation path.
- Known issues: `npm audit` undici advisories via `@ai-sdk/provider-utils` (fix needs ai v6, pinned away by CLAUDE.md §4).
