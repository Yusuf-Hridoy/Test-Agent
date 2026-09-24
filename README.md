# Magpie

**The testing agent that remembers your app.**

Magpie is an open-source, self-hosted web-testing agent. You point it at a web
application with a charter — "log in, add an item to the cart, check the badge" —
and it drives a real Chromium browser, looks for defects, and produces a report
with evidence: repro steps, before/after screenshots, console and network logs,
and a Playwright trace.

It runs on **free-tier LLM APIs** (Gemini, Groq, Mistral). No paid key required.

> **Phase 4.** Three ways to run it, one memory underneath.
> `run --charter` tests what you describe · `run --explore` tests what Magpie
> finds on its own · `run --regress all` replays every verified flow for **zero
> model calls** and tells you what broke since last night.
> See [Memory](#memory), [Explore mode](#explore-mode),
> [Regression mode](#regression-mode), [Recommended cadence](#recommended-cadence)
> and [Running Magpie in CI](docs/ci.md).

---

## Install

```bash
git clone <this repo> && cd magpie
npm install
npx playwright install chromium
npm run build
npm link            # optional: puts `magpie` on your PATH
```

Node ≥ 20 required.

## Quickstart (2 minutes, against the public Sauce Labs demo shop)

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=...   # free key: https://aistudio.google.com/apikey
                                          # (GEMINI_API_KEY works too)
npm run demo
```

`npm run demo` creates a throwaway project, logs into
[saucedemo.com](https://www.saucedemo.com) with its published demo credentials,
and runs this charter headed so you can watch:

> Log in, add the cheapest item to the cart, verify cart badge shows 1, remove
> it, verify badge clears.

### …or on your own app

```bash
mkdir my-app-tests && cd my-app-tests
magpie init --name my-app --url https://app.example.com
$EDITOR .env                 # add your LLM key
magpie login                 # log in by hand; the session is saved to .auth/
magpie run --charter "Search for a product, filter by price, open a result"
```

Live narration looks like this:

```
▶ O-02 Adding an item updates the cart badge
  [6/80] click "Add to cart" → OK (/inventory.html)
  ! F-001 http_5xx (high): Server error: /api/cart
  ! O-02 finding — badge never updated
```

and every run leaves a folder you can attach to a ticket:

```
reports/2026-09-16_14-32-05/
  index.html        ← self-contained report; open it offline, mail it, attach it
  steps.jsonl       ← every step, appended as it happened (crash-safe)
  session.json      ← the machine-readable result
  flows.draft.json  ← the passed objectives, compiled into memory as flows
  trace.zip         ← npx playwright show-trace trace.zip
  shots/            ← numbered screenshots
```

## Commands

| Command | What it does |
|---|---|
| `magpie init --name <n> --url <u>` | Create a project folder: config, `.env`, `.gitignore`, `.auth/`, `reports/` |
| `magpie login [--as <name>]` | Open a headed browser, you log in, press Enter; the session is saved to `.auth/<name>.json` |
| `magpie run --charter "<what to test>" [--as <name>] [--headed]` | Plan and execute a test session, then write the report |
| `magpie run --explore [--headed]` | Let Magpie choose what to test, page by page |
| `magpie memory show` | Pages, flows and sessions this project remembers |
| `magpie memory stats` | Database size, totals, schema version |
| `magpie memory coverage [--json]` | Pages visited vs. frontier, element coverage per page, where to look next |
| `magpie flows list` | Every remembered flow: status, steps, last replay |
| `magpie flows show <slug>` | One flow's steps, in the order replay runs them |
| `magpie run --regress all [--fail-on-skipped] [--include-draft] [--heal] [--json]` | Replay remembered flows as a suite — **no model calls** unless you pass `--heal` |
| `magpie flows replay <slug> [--headed] [--as <name>]` | Replay one flow against the live app — **no model calls** |
| `magpie flows verify <slug>` | Replay, and promote the flow to `verified` if it passes |
| `magpie flows rename <slug> <new name>` | Give a flow a human name |
| `magpie flows delete <slug> [-y]` | Forget a flow (its steps go with it) |

Exit codes: `0` a report exists (COMPLETED or BUDGET_EXHAUSTED), or every replay
passed · `1` a replay **failed or was healed** · `2` blocked (ENVIRONMENT_DOWN,
PLAN_FAILED, CRASHED) · `3` auth or config problem. Full table for regression
runs: [docs/ci.md](docs/ci.md#exit-codes).

## Configuration (`magpie.config.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `name` | — | Project name, shown in the report |
| `base_url` | — | Where every session starts |
| `auth.probe_url` | `base_url` | Page Magpie opens to decide whether the saved session is alive. Set it when your landing page shows the login form whether or not you are logged in — that page cannot answer the question. A path is resolved against `base_url` (saucedemo: `/inventory.html`) |
| `auth.strategy` | `manual` | `manual` = capture a session with `magpie login`; `form-login` = Magpie fills the form itself |
| `auth.login_url` | — | Only if the login form is not on `base_url` |
| `auth.user_env` / `auth.pass_env` | `APP_USER` / `APP_PASS` | Names of the `.env` variables holding credentials |
| `scope.include` | `<host>/**` | Globs matched against `host/path`. Navigation outside is refused |
| `scope.exclude` | `[]` | Globs that are refused even when included, e.g. `*/admin/**` |
| `forbidden_elements` | logout, delete, billing, payment, purchase, subscribe… | Case-insensitive substrings; clicking a matching element is refused |
| `budget.max_steps` | `80` | Hard cap on browser actions + harness events |
| `budget.max_llm_requests` | `60` | Hard cap on model calls |
| `budget.max_minutes` | `20` | Hard cap on wall-clock time |
| `model.primary` / `model.fallback` | `gemini` / `[groq, mistral]` | Provider chain; Magpie fails over on quota errors |
| `model.min_delay_ms` | `7000` | Minimum spacing between calls to one provider (free-tier pacing) |
| `model.ids` | see below | Override a model ID when a provider retires one |
| `run.headed` | `false` | Show the browser |
| `run.slow_network_grace_ms` | `15000` | Extra time a timed-out action gets on one retry before it counts as a failure |
| `regress.heal` | `false` | Let a model relocate a failed step during `--regress` (same as `--heal`) |
| `regress.max_heal_calls` | `10` | Hard cap on healing model calls for a whole suite |
| `explore.max_new_pages` | `8` | How many never-visited pages one exploratory session may take off the frontier |
| `explore.max_objectives_per_page` | `3` | Objectives generated per page — one model call produces them all |

Default models (all free-tier, all tool-calling). Free-tier quotas are **per
model per day** — Magpie defaults to models whose daily quota can sustain a whole
session (`gemini-3.6-flash`, for instance, allows only 20 requests/day):

| Provider | Model | Vision |
|---|---|---|
| `gemini` | `gemini-3.1-flash-lite` | yes |
| `groq` | `openai/gpt-oss-120b` | no — screenshots are dropped with a note |
| `mistral` | `mistral-small-latest` | yes |

## How it works

Four layers, with a deliberate division of labour: **the model decides what to
test and what things mean; plain code decides when to stop, retry and give up.**

```
REASONING  LLM via the Vercel AI SDK — one single-shot call per decision
HARNESS    deterministic TypeScript — budgets, loop detection, scope guard,
           environment monitor, evidence capture, report
EXECUTION  Playwright (Chromium) — navigate / observe / act, storageState auth
MEMORY     SQLite per project — app map, replayable flows, past findings
```

Where to go is decided by code (the explorer's queue, the regression selection);
what to test and what things mean is decided by the model. Budgets and safety are
never enforced by prompting. The while-loop lives in `src/harness/session.ts`;
the model is called once per decision and can only act through nine tools (`goto`, `click`, `fill`, `select`, `press`, `wait`, `look`,
`report_finding`, `mark_objective`). If it asks for something forbidden, the
harness refuses and tells it so.

### Findings carry their oracle

Every finding records *which* check fired and how much to trust it:

| Oracle | Confidence | Fires when |
|---|---|---|
| `crash` | high | the page process crashed |
| `http_5xx` | high | a request returned a server error |
| `http_4xx_unexpected` | high | a user-triggered request 404'd/403'd |
| `console_error` | high | the page logged an error |
| `llm_judgment` | **low** | the model judged behaviour wrong |
| `regression` | high | a flow that used to replay no longer does |
| `performance` | **low** | the same page needed extra time on its last three visits |

A site that is simply down is never reported as a bug: connection failures, DNS
errors and mass 5xx pause the session, retry at 30/60/120 s, and finalize as
`ENVIRONMENT_DOWN` if the app does not come back.

## Memory

Generic browser agents test once and forget. Magpie keeps what it learned in
`<project>/memory/magpie.db` — one SQLite file per project — and spends model
tokens only on ground it has not covered.

```bash
magpie run --charter "Add an item to the cart and check the badge"   # explores, costs tokens
magpie memory show                                                   # what it learned
magpie flows replay add-an-item-to-the-cart                          # re-runs it for free
```

### What is stored

| Table | What it holds |
|---|---|
| `pages` | Every page seen, keyed by normalized `host/path`, with visit counts and the last-seen element list |
| `transitions` | Which action moved the browser from which page to which (`click "Add to cart"`) |
| `flows` / `flow_steps` | Each passed objective as a replayable step list, targeted by role + accessible name — never by snapshot id, which dies with the session |
| `findings` | Title, severity, oracle and confidence of every finding, keyed to the page it fired on |
| `sessions` | One row per run: status, charter, report folder, model requests spent |

Entity ids in URLs collapse to `:id` (`shop.test/item/4711` →
`shop.test/item/:id`), so the map of a shop with 10 000 products stays the size
of a shop with one.

### Replay costs nothing

`magpie flows replay <slug>` drives a real Chromium through the recorded steps
with **no model in the loop** — the usage counter is asserted to be zero, not
assumed. That is the economic point of the whole tool: explore expensively once,
then re-run known ground for free as often as you like.

A replay either passes or fails **at an exact step**, with a screenshot, the
console/network delta and a Playwright trace in
`reports/<timestamp>-replay-<slug>/`. It never heals itself and never guesses: if
a step's target matches zero elements — or more than one — that is a failure, not
an invitation to click something similar. A failed flow is marked `broken`; a
passing one is `verified`.

| Status | Meaning |
|---|---|
| `draft` | Recorded from a passed objective, never replayed |
| `verified` | A replay passed against the live app |
| `broken` | A replay failed — the app changed, or the flow was always fragile |

### Later runs plan against it

When a project has memory, the planner is handed a short briefing (~1200 tokens)
listing the most-visited pages, the verified flows and known high-severity
findings, with one added rule: extend or vary known ground rather than re-test it
identically. A project with no memory sends exactly the prompt Phase 1 sent, so a
first run against a new app is unchanged.

### Secrets are never stored

No credential reaches the database. A value that the redactor masked is stored as
the literal placeholder `{secret}`, and replay **refuses** to run that step rather
than invent a value:

```
FAIL  log-in at step 2/4
      flow contains a secret value; secrets are never stored — re-record via a charter run
```

This is rare in practice: authentication comes from the saved `storageState` in
`.auth/`, not from replaying a typed password.

### Inspecting, sharing and deleting

```bash
magpie memory show                       # counts, top pages, flows, recent sessions
magpie memory stats                      # size on disk, schema version, totals
magpie flows show add-an-item-to-cart    # the exact steps replay will run
magpie flows delete add-an-item-to-cart  # forget one flow
rm -rf memory/                           # forget everything; the next run starts fresh
sqlite3 memory/magpie.db .schema         # it is just SQLite — read it however you like
```

`magpie init` gitignores `memory/` by default. Committing it is a deliberate
choice and a reasonable one: it holds no secrets, and checking it in gives your
team a shared set of replayable flows that arrive with the repository. Delete the
`memory/` line from the generated `.gitignore` if you want that.

## Explore mode

Nobody has time to write a charter for every corner of an application. Point
Magpie at one and let it decide:

```bash
magpie run --explore
```

```
exploring 1 page(s): 1 base

◆ 127.0.0.1:8098/ (base)
  O-01 [happy-path] Clicking the 'Catalogue' link navigates the user to the products listing page
  queued 3 newly discovered page(s)

◆ 127.0.0.1:8098/catalogue (frontier)
  O-02 [state-transition] Clicking 'Add to cart' on the 'Widget' item updates the cart indicator

◆ 127.0.0.1:8098/cart (frontier)
  O-03 [required-field] Submitting the order with an empty Full name shows a validation error

◆ 127.0.0.1:8098/help (frontier)
  nothing worth testing here
```

Where it goes is decided by **plain code**, not by a model: pages on the
frontier first (linked from somewhere Magpie has been, never opened), then the
pages whose elements are least exercised, then — for a project with no memory at
all — wherever you told it to start. What is worth testing *on* a page is the
one question a model answers, in a single call per page. Pages found along the
way are appended to the queue, and **budgets are the only crawl limit**: when
`max_steps` or `max_llm_requests` runs out, the session finalizes with
everything it learned.

Each page is told which of its elements have never been interacted with, and
which flows already cover it, so exploration adds ground rather than repeating
it. A page that genuinely has nothing to test says so — `[]` is a legitimate
answer, and better than three objectives about a footer link.

Everything lands in the same memory as a charter run: the app map, the flows
(which `--regress` can then replay for free), and the findings.

### ⚠ Explore against staging, not production

Every other mode does what you asked. **Explore does what it decides**, and the
only things standing between it and a page you did not want touched are
`scope.exclude` and `forbidden_elements`. So:

- Run it against **staging or a disposable environment**. Exploring production
  is a misuse of it, not a brave choice.
- Fill in **`scope.exclude`** before the first exploratory run — admin areas,
  anything that emails customers, anything that spends money.
- Keep **`forbidden_elements`** honest for your app. The defaults refuse
  logout, delete, billing, payment, purchase and subscribe; your app's
  destructive verbs may differ.
- Use an account whose damage you can absorb, and expect it to be used: an
  explorer fills in forms and presses buttons, which is the entire point.

The guards are enforced in code, not by prompting, and every refusal is logged
as a step. But a guard cannot know that `/admin/rebuild-index` is expensive —
only you can.

### Coverage, honestly

```bash
magpie memory coverage
```

```
pages known     5
  visited       5
  frontier      0 (linked, never opened)
elements used   10 of 30 seen (33%)
flows           6 (0 verified, 6 draft, 0 broken)

least-exercised pages
  USED  PAGE                      ELEMENTS  FLOWS
  20%   127.0.0.1:8098/           1/5       0
  20%   127.0.0.1:8098/help       1/5       0
  33%   127.0.0.1:8098/catalogue  2/6       0

Coverage is measured against pages Magpie has discovered; unknown areas are
not included.
```

That last line is not boilerplate. Magpie draws its own map, so coverage is a
measure of how much of *what it has found* has been exercised — never a claim
about the whole application. `--json` gives the same document (schema-stable,
caveat included) for a dashboard or a CI step.

One known limit: discovery reads real `href`s. On an application that navigates
in JavaScript — every in-app link an `href="#"` — nothing is discovered ahead of
time, and the map grows only as sessions actually walk through pages. Traditional
link navigation crawls properly.

## Regression mode

Once flows are remembered, a whole suite of them replays for nothing:

```bash
magpie run --regress all                  # every verified flow, no model calls
magpie run --regress all --include-draft  # …and the ones not yet proven
magpie run --regress add-item-to-cart     # just this one, whatever its status

# In CI: machine-readable, and red if the suite has quietly stopped covering anything
magpie run --regress all --fail-on-skipped --json > suite.json
```

```
── REGRESSIONS ───────────────────────────────────────────────
  OUTCOME  FLOW                     STEPS  TIME   DETAIL
  PASS     log-in                   3/3    2.1s
  FAIL@3   add-item-to-cart         2/5    6.4s   no element matched "Add to cart"
  SKIP     checkout-with-card       0/6    0.0s   broken — heal it or re-record it

totals    1 passed · 1 failed · 0 healed · 0 refused · 1 skipped · 0 untested
LLM requests: 0
findings  1 new · 0 known
  R-001 NEW   Flow "add-item-to-cart" no longer passes
```

**Nothing is quietly dropped.** A `broken` flow is listed as SKIPPED with the
reason rather than disappearing from the suite, and the last line of the summary
says how much actually ran:

```
⚠ 3 flows skipped — suite exercised 0 of 3 (use --fail-on-skipped to make this exit 1)
```

Skipping is not failing, so by default such a suite still exits `0`. Pass
**`--fail-on-skipped`** — as you should in CI — and it exits `1` when any flow
was skipped or none ran at all. A regression run that silently shrinks as flows
break is one that reports green while covering less and less.

### The regression oracle

A flow that used to replay and now does not becomes a **high-confidence
finding** citing when it last worked. That is the memory-based oracle this whole
design was for: not "this looks wrong to a language model", but "this worked on
Sunday and does not work today", which is the sentence a QA engineer can act on.

Findings are fingerprinted across sessions, so a nightly report leads with what
broke **tonight** and files the rest under *known, seen 4× since 2026-09-19*.
Nothing is ever auto-closed: a finding that stops appearing is not thereby
fixed, and Magpie will not pretend otherwise.

### Healing, and why healed is not passed

Apps get refactored, and a renamed button should not cost you a whole flow:

```bash
magpie run --regress all --heal      # costs model calls, up to regress.max_heal_calls
```

On a failed step Magpie asks the model **once** whether that element still
exists under a different label. If it does, the step is retried against the new
target, the flow is patched, and the change is recorded in `heal_events`. If the
model says the element is genuinely gone, that is a `broken` verdict and the
flow fails — a real defect reported honestly beats a test quietly repaired.

A healed flow is reported as **HEALED**, demoted to `draft`, and exits `1`:
healing shows something similar is still on the page, not that the application
still does what the flow asserts. It earns `verified` back on its next clean,
heal-free replay.

Healing is off unless you ask for it, never touches a step a guard refused or a
`{secret}` value, is capped for the whole suite, and never gets a second opinion
on the same step — a model asked twice will eventually find *something* to
click.

### Targeting the right element

Flows record **which** of several matching elements was used, so "add the third
product" replays as the third product rather than the first. Flows recorded
before this existed still refuse to guess between identical targets; re-run the
charter once and they learn their positions.

For nightly runs, exit codes and `suite.json`, see
**[Running Magpie in CI](docs/ci.md)**.

## Recommended cadence

The three modes are not alternatives; they are a cycle. Exploration finds
ground, charters test it deliberately, regression keeps it honest, and the
cheapest mode runs the most often.

| When | Command | Costs |
|---|---|---|
| **Nightly**, in CI | `magpie run --regress all --fail-on-skipped --json` | nothing — zero model calls |
| **Per feature**, while you build it | `magpie run --charter "…"` | a few dozen model calls |
| **Weekly**, against staging | `magpie run --explore` | a few dozen model calls |
| **After either**, when a flow needs proving | `magpie flows verify <slug>` | nothing |

A useful rhythm on a new app: explore once to draw the map, read
`magpie memory coverage` to see what it found, write charters for the flows that
matter to your users, then let the nightly regression suite carry them. Each
exploratory run afterwards costs less on the ground it has already covered — a
page with every element exercised drops off the queue for good.

Two honest caveats. Absence of a finding is never proof of a fix: Magpie does
not auto-close anything. And a `broken` flow is skipped rather than failed, so
`--fail-on-skipped` is what keeps a shrinking suite from reporting green — see
[docs/ci.md](docs/ci.md#a-broken-flow-must-not-make-ci-green).

## Security model

What **never leaves your machine**: your `.env`, your saved sessions in
`.auth/`, cookies, tokens, `Authorization` headers, and anything you type into a
password field — including out of `memory/magpie.db`, where a masked value is
stored as `{secret}` and refuses to replay. Values typed into password inputs are registered as secrets
*before* they are typed, and every prompt, log line and step record is redacted
against that set. `magpie login` deliberately discards its Playwright trace so
your password is never recorded.

What **is sent to your LLM provider**: the charter, the current page's URL,
title, visible interactive elements (role, accessible name, non-password
values), up to 2000 characters of page text, your recent tool results, and — only
when the model calls `look` — a screenshot. Snapshots are sent one at a time,
never accumulated.

What Magpie **will not do**: click anything matching `forbidden_elements`
(logout, delete, billing, payment…), or navigate outside `scope.include`. Both
refusals are logged as steps and returned to the model as errors.

Free-tier notice: Magpie paces itself (`model.min_delay_ms`, default 7 s) to stay
inside free-tier rate limits, retries once on a quota error, then fails over to
the next provider. `budget.max_llm_requests` caps a session's total spend of
requests regardless.

## Development

```bash
npm test                       # unit + integration (no API key needed)
npm run dev -- run --charter "…"
npx tsx scripts/smoke-browser.ts    # browser layer against saucedemo, no key
npx tsx scripts/smoke-model.ts <project-dir>   # one live model call, needs a key
```

The integration test in `src/harness/__tests__/session.test.ts` runs the entire
loop against a local fixture app with a scripted model, so the harness, guards,
oracles, evidence and report are all covered without spending a token.
`src/memory/__tests__/replay.test.ts` goes further: it records a flow with a
scripted model, replays it with none, breaks the fixture app on cue to prove the
replay fails at the right step, then fixes it and re-verifies.
`explore.test.ts` drives a whole exploratory session against the fixture app —
queue order, mid-run discovery, scope refusals, and budgets stopping the crawl —
also without spending a token.

## License

MIT.
