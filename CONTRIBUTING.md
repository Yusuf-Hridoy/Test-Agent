# Contributing to Magpie

Thanks for looking. This is a small, deliberately-scoped project; the fastest
way to get a change in is to keep it small too.

## Getting set up

```bash
git clone https://github.com/Yusuf-Hridoy/Test-Agent.git && cd Test-Agent
npm install
npx playwright install chromium
npm run build
npm test
```

Node ≥ 20. **No API key is needed to develop or test Magpie** — the suite drives
a local fixture app with a scripted model, and CI asserts that no provider key
is even reachable, so a test can never quietly start depending on one.

```bash
npm test                               # full suite
npx vitest run src/memory              # one area
npm run dev -- run --charter "…"       # run the CLI from source
npm run build                          # tsc, strict
```

Running the real agent against a real app does need a key — put it in the
project's `.env`, never in a shell profile you might commit.

## How the codebase is laid out

```
src/
  cli/        command definitions
  config/     config schema (zod), loader, .env handling
  model/      provider adapter, rate limiter, fallback chain, redaction
  browser/    Playwright wrapper: session, snapshot, actions, guards
  agent/      the loop: system prompts, tools, planners
  harness/    budgets, loop detection, checkpoints, scope guard, auth check
  evidence/   step logger, screenshots, finding builder
  report/     HTML report, suite report, dashboard, terminal output
  memory/     SQLite + migrations, page keys, ingest, replay, healing, coverage
```

The division of labour is the thing to internalise before changing anything:

> **The model decides what to test and what things mean. Plain code decides when
> to stop, retry and give up.**

Budgets, loop detection, the scope guard and the forbidden-element list are
enforced by the harness that wraps every step — never by asking the model
nicely. A patch that moves a safety limit into a prompt will not be merged.

## House rules

- **Strict TypeScript.** No `any` without a comment justifying it.
- **Never log or prompt a secret.** Redaction applies at every write boundary:
  prompts, step records, reports, and the database. See
  `src/model/redact.ts` and the tests in `src/harness/__tests__/redaction.test.ts`.
- **Evidence or it did not happen.** A finding needs repro steps, screenshots,
  console/network context and a trace reference.
- **No fake output.** If something cannot be verified, it reports BLOCKED with
  the reason — never an invented pass or failure.
- **Migrations are append-only.** Add the next numbered migration in
  `src/memory/db.ts`; never edit one that has shipped.
- Add a test when it is cheap. Ship working over perfect.

## Database changes

Add a new numbered entry to `MIGRATIONS` and bump `SCHEMA_VERSION`. Existing
project databases only run the migrations they have not seen, so an old project
must keep opening cleanly — there is a test for exactly that in
`src/memory/__tests__/db.test.ts`.

## How this project is built

Magpie is built in numbered phases, each with a brief (`PHASE-N-BRIEF.md`)
listing its tasks, its verification steps and an acceptance run whose results
are recorded in the same file. `CLAUDE.md` is the project brain: architecture,
hard rules, and a decision log explaining *why* things deviate from the obvious
choice. If a design decision looks strange, the decision log probably says why —
check there before assuming it is an accident.

Phases 1–5 are complete, so new work is ordinary issues and pull requests
rather than phase briefs. The post-1.0 backlog is in the
[README](README.md#post-10-backlog).

## Pull requests

- One concern per PR.
- `npm run build && npm test` green before you open it. CI runs the same thing.
- Say what you verified by hand, and how. "I ran it against staging and the
  suite went from 4 passed to 5 passed" is worth more than a paragraph of
  description.
- If you changed behaviour that the docs describe, change the docs in the same
  PR. Every example in `docs/` is meant to be copy-paste runnable.

## Reporting a bug

Use the issue template — it asks for your `magpie --version`, the command you
ran, and an excerpt of `reports/<timestamp>/steps.jsonl`, which is usually
enough to see what happened. **Scrub it first**: Magpie redacts secrets it knows
about, but your application's data is your own.
