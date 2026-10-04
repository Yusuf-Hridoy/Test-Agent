# 90-second demo — screen recording script

The whole arc in one take: Magpie learns the app, something breaks, and it
notices — citing the date it last worked.

## Before you hit record

```bash
# terminal 1 — the app under test (breakable on cue)
npx tsx launch/fixture-shop.ts          # http://127.0.0.1:8099

# terminal 2 — the demo project
mkdir /tmp/magpie-demo && cd /tmp/magpie-demo
magpie init --name shop --url http://127.0.0.1:8099
echo 'GOOGLE_GENERATIVE_AI_API_KEY=…' >> .env
```

Do a **full rehearsal run first** and keep its memory: the charter run below
takes a few minutes in real time, not the 20 seconds it gets on screen. Record
it, then cut and speed it up. The regression run at 1:04 is genuinely that fast
— do not speed that one up, it is the point.

Terminal at ~16pt, dark theme, 1280×720. Two panes side by side after 0:56 so
the app and the terminal are both visible when the button changes.

---

## Beats

| Time | On screen | Narration caption |
|------|-----------|-------------------|
| **0:00–0:06** | Black. Title card. | *Every browser agent can test your app once. Then it forgets.* |
| **0:06–0:16** | `magpie init --name shop --url http://127.0.0.1:8099` → the generated tree scrolls past (`magpie.config.yaml`, `.env`, `.auth/`, `reports/`) | *One project folder. Config is committable; secrets are not.* |
| **0:16–0:22** | `magpie login --help` flashes by; cut to the fixture shop in the browser | *A real app needs a login — you do it by hand, once, and Magpie reuses the session. This demo shop needs none.* |
| **0:22–0:44** | `magpie run --charter "Add the second item to the cart"` — **sped up**. Let these land legibly: the `▶ O-01` objective headers, a `[6/80] click "Add to cart" → OK` line, the budget counter climbing | *It plans objectives, drives a real Chromium, and keeps evidence for every step.* |
| **0:44–0:50** | The `── COMPLETED ─` summary block, then the `report` path | *Zero to a report with repro steps, screenshots and a Playwright trace.* |
| **0:50–0:58** | `open reports/*/index.html` — scroll the report: header, objectives, screenshots | *Attachable to a ticket, opens offline.* |
| **0:58–1:04** | `magpie flows list` → the recorded flow, status `draft` → `magpie flows verify add-the-second-item-to-the-cart` → **PASS, LLM requests: 0** | *That run is now a flow. Replaying it costs no model calls at all.* |
| **1:04–1:10** | Cut to the app pane. Press **`r`** in terminal 1 — caption `renamed: "Add to cart" -> "Add to basket"`. The browser refresh shows the new label | *Now someone renames the button. This is the moment every recorded test dies.* |
| **1:10–1:24** | `magpie run --regress all` — real time, no speed-up. The `FAIL@2` row, then the finding: **`R-001 Flow … no longer passes`** and the `Last passed …` line | *It doesn't just fail. It tells you when it last worked — and it cost nothing to find out.* |
| **1:24–1:30** | `magpie dashboard` → the HTML page: coverage block, flows table, the new finding under **New**. Hold on the repo URL | *The testing agent that remembers your app. MIT, free-tier LLMs.* |

**End card:** `github.com/Yusuf-Hridoy/Test-Agent`

---

## The exact commands, in order

```bash
magpie init --name shop --url http://127.0.0.1:8099
magpie login --help
magpie run --charter "Add the second item to the cart"
open reports/*/index.html
magpie flows list
magpie flows verify add-the-second-item-to-the-cart
#   … press r in terminal 1 to rename the button …
magpie run --regress all
magpie dashboard
open dashboard.html
```

The flow slug comes from the charter, so check it with `magpie flows list`
during rehearsal and use the real one — do not guess it on camera.

## What to let the viewer actually read

Three frames carry the whole argument. Hold each for at least two seconds:

1. `LLM requests: 0` on the verify at 1:00.
2. `FAIL@2` next to the renamed target at 1:14.
3. `Last passed <date>` on the finding at 1:20.

Everything else can scroll.

## If something goes wrong on the take

- **The charter run finds nothing to record** — the fixture shop is small;
  "Add the second item to the cart" is the charter that reliably produces a
  flow. Rehearse until it does, then keep that memory folder.
- **`--regress all` says "0 flows"** — the flow is still `draft`. `verify` it
  first (beat 0:58), which is why that beat exists.
- **The rename doesn't break it** — you pressed `r` before the flow was
  recorded. Order matters: record, verify, *then* break.
- **A quota error mid-take** — free tiers are per model per day. Rehearse early,
  record later, or point `model.primary` at a fallback provider.

<!--
Claims in this script that are measured rather than hoped for:
- "replaying costs no model calls" / "LLM requests: 0"
  → PHASE-2-BRIEF.md §2 Run Log A2 and PHASE-3-BRIEF.md §1.7 Run Log B1;
    asserted in src/memory/__tests__/replay.test.ts and regress.test.ts.
- "tells you when it last worked"
  → PHASE-3-BRIEF.md §1.7 Run Log B5/B6: the regression finding carries
    lastPassAt; documented in docs/ci.md under `suite.json`.
- The rename-breaks-a-flow beat is the same mechanism the suite exercises via
  fakeapp.setAddLabel() — see src/memory/__tests__/heal.test.ts.
No employer or workplace is named anywhere in this script.
-->
