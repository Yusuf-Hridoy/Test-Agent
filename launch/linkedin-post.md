# LinkedIn post

**Suggested image:** a screenshot of `magpie dashboard` — the coverage block and
the flows table with its green/amber/red status chips. Run `magpie dashboard` on
a project with a few runs behind it and crop to the top two sections.

**Alt text:** "Magpie dashboard showing 3 sessions, 5 pages mapped, element
coverage, and a flows table with verified, draft and broken flows."

---

Your 100th test run shouldn't start from zero.

Every browser agent I tried could test a web app once, then forgot everything —
the login page, where the cart lives, which button it already checked — and paid
full price to rediscover it tomorrow.

So I built Magpie: a testing agent with persistent memory.

It explores your app once, expensively. Every passed objective becomes a
replayable flow in a local SQLite file. After that, regression runs replay
everything it knows for zero model calls — a 4-step checkout flow that cost 27
calls to discover now replays in 2.0 seconds for nothing.

When a flow breaks it tells you when it last passed. When someone renames a
button it repairs itself — then reports the flow as healed, not passed, because
those are not the same claim.

Free-tier LLM APIs throughout. Open source, MIT. The limitations are in the
README, written down honestly.

🔗 github.com/Yusuf-Hridoy/Test-Agent

#QA #TestAutomation #Playwright #AIAgents #OpenSource

<!--
Body: 150 words (heading, image note, link line and hashtags excluded;
`wc -w` reports 153 because it counts the three standalone em-dashes).

Numbers cited:
- "cost 27 calls to discover ... replays in 2.0 seconds"
  → PHASE-2-BRIEF.md §2 Run Log, scenario A2: the 4-step flow
    `enter-valid-first-name-last-name-and-zip` — "PASS in 2.0 s, zero model
    calls — the same ground the recording session spent 27 calls to discover."
- "zero model calls" is asserted in code, not estimated
  → src/memory/__tests__/replay.test.ts and regress.test.ts assert usage == 0.
- "healed, not passed"
  → PHASE-3-BRIEF.md §1.6 and CLAUDE.md decision log (2026-09-23, P3-T4):
    a healed flow is demoted to draft and the suite exits 1.

No employer or workplace is named anywhere in this post.
-->
