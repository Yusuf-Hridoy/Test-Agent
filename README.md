# Magpie

**The testing agent that remembers your app.**

Magpie is an open-source, self-hosted web-testing agent. You point it at a web
application with a charter — "log in, add an item to the cart, check the badge" —
and it drives a real Chromium browser, looks for defects, and produces a report
with evidence: repro steps, before/after screenshots, console and network logs,
and a Playwright trace.

It runs on **free-tier LLM APIs** (Gemini, Groq, Mistral). No paid key required.

> **Phase 1.** The execution core is complete: `init`, `login`, `run --charter`,
> budgets, guards, evidence and reports. Persistent memory — the part that makes
> the name true — lands in Phase 2, which compiles explored flows into
> deterministic replays that cost nothing to re-run.

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
  flows.draft.json  ← seam for Phase-2 replay
  trace.zip         ← npx playwright show-trace trace.zip
  shots/            ← numbered screenshots
```

## Commands

| Command | What it does |
|---|---|
| `magpie init --name <n> --url <u>` | Create a project folder: config, `.env`, `.gitignore`, `.auth/`, `reports/` |
| `magpie login [--as <name>]` | Open a headed browser, you log in, press Enter; the session is saved to `.auth/<name>.json` |
| `magpie run --charter "<what to test>" [--as <name>] [--headed]` | Plan and execute a test session, then write the report |

Exit codes: `0` a report exists (COMPLETED or BUDGET_EXHAUSTED) · `2` blocked
(ENVIRONMENT_DOWN, PLAN_FAILED, CRASHED) · `3` auth or config problem.

## Configuration (`magpie.config.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `name` | — | Project name, shown in the report |
| `base_url` | — | Where every session starts. If your landing page always shows the login form, point this at a page that *requires* a session (e.g. `/dashboard`) — otherwise Magpie cannot tell a live session from a dead one |
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
MEMORY     Phase 2
```

Budgets and safety are never enforced by prompting. The while-loop lives in
`src/harness/session.ts`; the model is called once per decision and can only act
through nine tools (`goto`, `click`, `fill`, `select`, `press`, `wait`, `look`,
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

A site that is simply down is never reported as a bug: connection failures, DNS
errors and mass 5xx pause the session, retry at 30/60/120 s, and finalize as
`ENVIRONMENT_DOWN` if the app does not come back.

## Security model

What **never leaves your machine**: your `.env`, your saved sessions in
`.auth/`, cookies, tokens, `Authorization` headers, and anything you type into a
password field. Values typed into password inputs are registered as secrets
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

## License

MIT.
