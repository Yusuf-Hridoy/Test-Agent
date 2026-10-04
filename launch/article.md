# I built a testing agent that remembers the app

<!--
Draft article, ~1,050 words. First person, engineer voice.
Every number below is traced to a Run Log in this repository; citations are in
HTML comments next to each claim, per CLAUDE.md Hard Rule 9.
-->

I kept running into the same thing with browser agents. You point one at a web
application, give it a charter — "log in, add an item to the cart, check the
badge" — and it does a genuinely good job. It reads the page, decides what to
click, notices when something looks wrong. Then the session ends and it forgets
all of it.

Tomorrow it starts from zero. It re-discovers the login page, re-learns where
the cart is, re-reasons about the same five screens, and bills you the full
token price to arrive back where it already was. For a one-off exploration
that's fine. For regression testing — which is most of QA, and the part that
actually has to happen every night — it's the whole cost of the tool, repeated
forever.

So I built Magpie, which is the same idea with one thing added: it remembers.

## The bet

The economics only work one way round: **explore expensively once, compile the
result into something deterministic, then spend model tokens only on novelty.**

Concretely — when a charter run completes an objective, that objective is
compiled into a *flow*: an ordered list of steps targeted by role, accessible
name and position. Not by CSS selector, and definitely not by the snapshot id
the model used during the session, because that dies the moment the page
re-renders. Flows go into a SQLite file in the project folder, next to a map of
every page the agent has seen and every finding it has ever reported.

After that, `magpie run --regress all` replays everything it knows with no model
in the loop at all.

The numbers from my own acceptance runs: a 4-step checkout-form flow cost 27
model calls to discover, and replays in **2.0 seconds for zero calls**. A
catalogue flow that has to click the *third* of six identical "Add to cart"
buttons replays in 2.1 seconds, also for nothing — and I checked the screenshot
to confirm it really picked the third item rather than getting lucky on the
first.
<!--
2.0 s / 27 calls → PHASE-2-BRIEF.md §2 Run Log, scenario A2.
2.1 s third-product → PHASE-3-BRIEF.md §1.7 Run Log, scenario B1: "PASS in
2.1 s, 0 model calls. Verified visually from the replay screenshot — the third
product (Sauce Labs Bolt T-Shirt) shows Remove while the other five still show
Add to cart."
-->

"Zero" there is asserted in code, not estimated. If a replay ever spent a model
request without being asked to, the test fails rather than quietly billing
someone.

That property is what makes the free-tier constraint survivable, and the free
tier is not a demo — it's the actual target. I built this entirely on free
Gemini, Groq and Mistral keys. A whole Phase 3 acceptance cost **10 model
requests**: eight to record a charter, two to heal a renamed button. Everything
else ran free.
<!-- 10 requests → CLAUDE.md §11, Phase 3: "Acceptance spent 10 model requests
in total (8 recording a charter, 2 healing); everything else ran free." -->

## Four layers, and a rule about which one decides what

The architecture is four layers, but the thing that actually matters is the
division of labour between two of them:

> **The model decides what to test and what things mean. Plain code decides when
> to stop, retry and give up.**

- **Reasoning** — an LLM through the Vercel AI SDK, called once per decision,
  able to act only through nine tools.
- **Harness** — ordinary TypeScript: budgets, loop detection, the scope guard,
  the forbidden-element list, the environment monitor, evidence capture.
- **Execution** — Playwright driving Chromium, with traces as evidence.
- **Memory** — the SQLite file.

Budgets and safety are never enforced by prompting. "Please don't click Delete"
in a system prompt is not a safety mechanism; it's a wish. Max steps, max model
calls, max minutes, the scope guard and the destructive-verb list are all plain
code wrapping every step, and the loop cannot exceed them whatever the model
outputs. When the model asks for something forbidden, the harness refuses,
*logs the refusal as a step*, and hands the error back as a tool result.

The same instinct shows up in how a site being down is handled. A connection
failure or a wave of 5xx on previously-working pages is not an application bug —
it's an outage. The session pauses, retries at 30/60/120 seconds, and finalizes
as `ENVIRONMENT_DOWN` rather than filing a dozen fake defects.

## The parts I had to be honest about

A tool that tells you what you want to hear is worse than no tool, so some of
the design is deliberately unflattering.

**Healed is not passed.** If a flow breaks because someone renamed a button,
`--heal` asks the model *once* whether that element exists under a new label,
and patches the flow if it does. But the result is reported as HEALED, the flow
is **demoted to draft**, and the suite exits non-zero. Healing proves something
similar is still on the page; it does not prove the application still does what
the flow asserted. It also never gets a second opinion on the same step — a
model asked twice will eventually find *something* to click, and "eventually
found something" is exactly how a green regression suite becomes worthless.

**Coverage is coverage of the map.** Magpie draws its own map of the
application, so its coverage number describes how much of *what it has found*
has been exercised. Every coverage output ends with a sentence saying so. That
line is not boilerplate; it's the difference between a useful metric and a
misleading one.

**Nothing is ever auto-closed.** A finding that stops appearing is not thereby
fixed — it may simply not have been reached. Findings accumulate sightings
("seen 4× since 2026-09-19") and a human closes them.

And two acceptance criteria I wrote for myself simply didn't pass, which I
recorded rather than reworded. One exploratory scenario was supposed to cost
fewer model calls on the second run over the same app; it cost exactly the same,
**20 against 20**, because a site-wide nav bar keeps every page below full
coverage and re-queues the whole map. The mechanism that *does* make repeat runs
cheaper is real and unit-tested — a page at 100% drops off the queue for good —
but it didn't show up in that live run, so the scenario is marked PARTIAL with
the diagnosis attached.
<!-- 20 vs 20 → PHASE-4-BRIEF.md §1.6 Run Log, scenario C2, marked PARTIAL. -->

Live acceptance runs have been worth far more than the unit tests for this kind
of bug. Phase 1 alone turned up 19 real defects that only appeared against a
real browser and a real model, and Phase 4 found three more — including flows
being keyed only by the page they *end* on, so an exploratory run kept proposing
an objective it had already recorded.
<!-- 19 defects → CLAUDE.md §11, Phase 1. 3 defects → PHASE-4-BRIEF.md §1.6. -->

## Where it is

v1.0.0, MIT, self-hosted, 264 tests that run without any API key at all because
the suite drives a local fixture app with a scripted model.

What's next, in order: `--resume` for interrupted sessions, and fixing discovery
on JavaScript-navigated apps — right now the crawler reads real `href`s, so an
app where every in-app link is `href="#"` yields an empty frontier. Pages still
enter the map when a session walks them, but nothing is found ahead of time.
That one is written down in the README's limitations section, where I'd rather
a potential user find it than discover it themselves.

🔗 **github.com/Yusuf-Hridoy/Test-Agent**
