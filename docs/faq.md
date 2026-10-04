# FAQ

Factual answers to the questions that decide whether this tool is for you.

---

## How is this different from Playwright's codegen / test agents?

They solve a **dev-time authoring** problem; Magpie solves a **runtime
exploration and regression** problem. Playwright's tooling watches you use the
app and writes test code you then own, review and maintain — excellent, and
entirely complementary.

Magpie never asks you to write or own a test file. It decides what to test
(from a charter, or on its own), judges what it sees, and keeps the result as
data in a database rather than as code in your repository. The output of a
Playwright codegen session is a `.spec.ts` you maintain. The output of a Magpie
session is a report with evidence, plus a flow that replays itself.

Use codegen when you know exactly what the test should assert and want it in
source control. Use Magpie when you want something to go *look*, and to notice
next month that what worked last month stopped working.

They share a foundation — Magpie drives Playwright and ships Playwright traces
as evidence, so `npx playwright show-trace trace.zip` works on any Magpie run.

## How is this different from a generic browser agent?

Three things, in order of how much they matter.

**1. It remembers.** A generic agent starts every session from zero: it
re-discovers your login page, re-learns where the cart is, re-reasons about the
same five screens, and pays full token price each time. Magpie writes what it
learned to a per-project SQLite file, so the second run plans *against* the
first, and ground it has already covered replays with no model in the loop at
all.

**2. Evidence is the product.** In QA a finding without evidence is worthless.
Every Magpie finding ships with repro steps, before/after screenshots, console
errors, failed network requests, a Playwright trace, and — crucially — **which
oracle fired and how much to trust it**. A finding that only a language model
believes is labelled `llm_judgment` and marked low-confidence, every time.

**3. Budgets are code, not prompting.** Max steps, max model calls, max minutes,
loop detection, the scope guard and the forbidden-element list are enforced by
the harness that wraps every step. The loop cannot exceed them whatever the
model outputs. "Please don't click Delete" in a system prompt is not a safety
mechanism.

## Does it really work on a free API tier?

Yes, and that constraint shaped the architecture rather than being bolted on.

The expensive part — exploring an app, judging what you see — happens once.
After that, `magpie run --regress all` replays everything it has learned with
**zero model calls**. That is asserted in code, not assumed: if a replay ever
spent a request without being asked to, it fails rather than quietly billing
you.

Measured on the real acceptance runs in this repository: a 4-step checkout flow
that took a whole exploratory session to discover replays in **2.0 seconds for
0 calls**; a catalogue flow in 2.1 seconds. A nightly regression suite is
therefore free forever, which is exactly the run you want happening every night.

Magpie also paces itself for free tiers: a configurable minimum delay between
calls (default 7 s), one retry on a quota error, then failover to the next
provider in the chain, with a hard per-session cap on requests.

## Will my application's data be sent to an LLM provider?

Some of it, redacted. Each decision sends: the charter, the current page's URL
and title, its visible interactive elements (role, accessible name, non-password
values), up to 2000 characters of page text, your recent tool results, and — only
when the model asks to `look` — a screenshot.

Never sent: cookies, tokens, `Authorization` headers, anything in `.env`, your
saved session in `.auth/`, and anything typed into a password field. Values typed
into password inputs are registered as secrets *before* they are typed, and every
prompt, log line, step record, report and database write is redacted against that
set.

Free LLM tiers generally reserve the right to train on what you send. If your
staging data is sensitive, that is a decision to make deliberately — a paid key
from the same providers works unchanged, and so does pointing Magpie at a
seeded staging environment.

## Can it test behind a login?

Yes, two ways. `magpie login` opens a headed browser, you log in by hand, and the
session is saved to `.auth/` — Magpie reuses it and never sees your password.
Or set `auth.strategy: form-login` with credentials in `.env`, and it logs in
itself; that is the one that works unattended in CI.

If your landing page shows the login form whether or not you are logged in, set
[`auth.probe_url`](config.md#auth) to a page that genuinely requires a session.

## What does it find, and what does it miss?

**Finds**, with high confidence: server errors (`http_5xx`), unexpected 4xx on
user-triggered requests, console errors, page crashes, and — the one this design
exists for — `regression`: a flow that used to replay and no longer does, citing
the date it last passed.

**Finds**, with low confidence and labelled as such: `llm_judgment` (the model
thinks the behaviour is wrong) and `performance` (a page needed extra time on
its last three visits).

**Misses**: anything visual. Magpie reads the accessibility tree and the
network, not pixels. A broken layout that throws no error, a mis-rendered chart,
a wrong colour — it will not notice. Screenshots are evidence, not a baseline.
Visual-diff oracles are on the post-1.0 list.

## Is it safe to point at production?

`--charter` and `--regress` do what you asked, so they are as safe as the
charter and the flows you wrote.

**`--explore` is different and should go at staging.** It decides for itself
what to click, and the only things between it and a page you did not want
touched are `scope.exclude` and `forbidden_elements`. Both are enforced in the
browser layer and every refusal is logged — but a guard cannot know that
`/admin/rebuild-index` is expensive. Only you can.

## What happens when the app is down?

It is never reported as a bug. Connection failures, DNS errors and mass 5xx on
previously-working pages pause the session, retry at 30/60/120 seconds, and
finalize as `ENVIRONMENT_DOWN` (exit `2`) if the application does not come back.
Remaining flows in a suite are marked `UNTESTED` rather than failed.

The same applies in reverse: if no model provider is reachable but the app is
up, the session finalizes honestly instead of spending its step budget on
retries that cannot help.

## A flow broke because we renamed a button. Do I have to re-record it?

No — `magpie run --regress all --heal` asks the model once whether the element
still exists under a different label, and patches the flow if it does.

But a healed flow is reported `HEALED`, demoted to `draft`, and the suite exits
`1`. That is deliberate: healing proves something *similar* is still on the
page, not that the application still does what the flow asserts. A human should
look. It earns `verified` back on its next clean, heal-free replay. See
[memory.md](memory.md#healing).

## Why does my CI pass when all my flows are broken?

Because a `broken` flow is **skipped**, and skipping is not failing. Pass
`--fail-on-skipped` and the suite exits `1` when any flow was skipped or none
ran at all:

```bash
magpie run --regress all --fail-on-skipped --json > suite.json
```

This is the one way the design can go quietly green, which is why the flag
exists and why every CI example in these docs passes it. See
[ci.md](ci.md#a-broken-flow-must-not-make-ci-green).

## Does it close findings when they stop appearing?

No, and it never will. A defect that stops being reported is not thereby fixed —
it may simply not have been reached this time. Findings accumulate sightings
(`seen 4× since 2026-09-19`) and a human closes them.

## Can my team share what it has learned?

Yes — commit `memory/magpie.db`. It holds no secrets (a redacted value is stored
as `{secret}` and refuses to replay), it is a single file, and committing it
means your replayable flows arrive with the repository and are reviewable in
pull requests like any other test. `magpie init` gitignores it by default;
delete that line to opt in.

## Which model should I use?

The default, `gemini-3.1-flash-lite`, until you have a reason not to. It does
tool calling and vision, answers in about 1.5 seconds, and — the part that
matters on a free tier — has a daily quota large enough to sustain a whole
session. Bigger free models often do not: `gemini-3.6-flash` allows 20 requests
*per day*.

Groq (`openai/gpt-oss-120b`) is the verified fallback and has **no vision**, so
`look` degrades with a note rather than failing. Model IDs drift; override any
of them with [`model.ids`](config.md#model).

## What is deliberately not in 1.0?

`--resume` for an interrupted session, `sitemap.xml` ingestion, parallel replay,
visual-diff oracles, a multi-project or served dashboard, and plugin oracles.
See the [post-1.0 backlog](../README.md#post-10-backlog).
