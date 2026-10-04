# Memory

Everything Magpie remembers about one application lives in a single SQLite file:

```
<project>/memory/magpie.db
```

No server, no cloud, no vector database. It is readable with any SQLite client:

```bash
sqlite3 memory/magpie.db .schema
sqlite3 memory/magpie.db "SELECT slug, status, last_replay_result FROM flows"
```

The schema is versioned and migrated forward at open. Migrations are numbered
and never edited after they ship, so an old project database upgrades itself the
first time a newer Magpie opens it.

```bash
magpie memory stats        # includes the schema version
```

---

## Schema tour

| Table | What it holds |
|---|---|
| `sessions` | One row per run: status, charter, report folder, model requests spent |
| `pages` | Every page seen, keyed by a normalized `page_key`, with visit count and its last-seen element list |
| `transitions` | Which action moved the browser from which page to which, and how often |
| `flows` | A named, replayable sequence: slug, status, start page, last replay result |
| `flow_steps` | The steps themselves, in replay order |
| `findings` | Every sighting of every defect: title, severity, oracle, confidence, fingerprint |
| `observations` | Per-session notes the oracles need later (page visits, slow pages) |
| `heal_events` | Every time a model relocated a step, old target → new target |
| `frontier` | Pages linked from somewhere Magpie has been, but never opened |
| `element_seen` | One row per element per page, with how often it was actually used |

### Page keys

A page is identified by `host + path` with entity ids collapsed:

```
shop.example.com/item/4711                       → shop.example.com/item/:id
shop.example.com/order/9f1c4e2a-…-b7            → shop.example.com/order/:id
shop.example.com/2026-09-18-release-notes       → unchanged
```

A path segment counts as an id when it is purely numeric, a UUID, ≥16 characters
of hex, or ≥16 characters of base64url containing **both** a digit and an
uppercase letter. That last clause is the interesting one: length alone would
collapse readable slugs like `add-cheapest-item-to-cart`, and the map would lose
exactly the pages a tester cares about. Real opaque ids — ULIDs, Stripe keys,
session tokens — carry both.

The effect: a shop with 10 000 products maps to the size of a shop with one.

### Visit counts count arrivals

`pages.visit_count` counts *arrivals*, not steps. A page the agent poked at
twenty times is not twenty times more interesting than one it saw once — and
the planner ranks pages by this number.

---

## Flows

A flow is a passed objective compiled into a deterministic script. Steps are
targeted by **role + accessible name + position**, never by a snapshot id —
snapshot ids die with the session.

```bash
magpie flows show add-item-to-cart
```

```
Add an item to the cart
slug         add-item-to-cart
status       verified
starts on    shop.example.com/inventory.html
recorded     2026-09-22 09:44 (O-02)
last replay  pass at 2026-09-24 03:00

SEQ  STEP                            ENDS ON
1    goto https://shop.example.com/  shop.example.com/inventory.html
2    click "Add to cart" (match 3)   shop.example.com/inventory.html
3    click "Cart"                    shop.example.com/cart.html
```

`(match 3)` is `target_nth`: *which* of several identical buttons was used, so
"add the third product" replays as the third product rather than the first.
Flows recorded before this existed refuse to guess between identical targets;
re-run the charter once and they learn their positions.

The replayable actions are `goto`, `click`, `fill`, `select` and `press` — the
deterministic subset of the agent's tools. A `fill` whose value was redacted
shows as `{secret}` and refuses to replay.

### Lifecycle

```
            recorded from a passed objective
                         │
                         ▼
                      ┌───────┐
      replay passes   │ draft │   replay fails
         ┌────────────┤       ├────────────┐
         │            └───────┘            │
         ▼                                 ▼
   ┌──────────┐     replay fails     ┌────────┐
   │ verified │────────────────────► │ broken │
   │          │ ◄────────────────────┤        │
   └──────────┘   replay passes      └────────┘
         ▲                                 │
         │        healed → demoted to draft│
         └─────────────────────────────────┘
```

| Status | Meaning | In `--regress all` |
|---|---|---|
| `draft` | Recorded, never proven by a replay | skipped unless `--include-draft` |
| `verified` | A replay passed against the live app | **run** |
| `broken` | A replay failed — the app changed, or the flow was always fragile | skipped, and listed as SKIPPED with the reason |

Promotion to `verified` happens **only** through a real passing replay
(`magpie flows verify <slug>`). There is deliberately no way to set it by hand:
if there were, `magpie flows list` would stop being trustworthy.

A **guard refusal** is the one outcome that does not change the status. Adding
something to `forbidden_elements` says nothing about the application, so marking
the flow broken would read as a regression that did not happen. A refused flow
exits `3` (configuration), not `1` (failed test).

### Replay costs nothing

```bash
magpie flows replay add-item-to-cart
```

Zero model calls — the usage counter is *asserted* to be zero, not assumed. If a
replay ever spent a request without being asked to, it fails rather than quietly
billing you.

A replay either passes or fails **at an exact step**, with a screenshot, the
console/network delta and a Playwright trace in
`reports/<timestamp>-replay-<slug>/`. It never guesses: a target that matches
zero elements — or more than one it cannot disambiguate — is a failure, not an
invitation to click something similar.

Target resolution tries exact name, then substring, then text. Exact-first
removes *false* ambiguity (a "Cart" target also matching "Add to cart") without
ever choosing between genuine matches.

### Secrets are never stored

No credential reaches the database. A value the redactor masked is stored as the
literal `{secret}`, and replay refuses to run that step rather than invent one:

```
FAIL  log-in at step 2/4
      flow contains a secret value; secrets are never stored — re-record via a charter run
```

Rare in practice: authentication comes from the saved `storageState` in
`.auth/`, not from replaying a typed password.

---

## Healing

```bash
magpie run --regress all --heal
```

On a failed step Magpie asks the model **once** whether that element still
exists under a different label, showing it the current page. Three answers:

| Verdict | What happens |
|---|---|
| `relocated` | The step is retried against the new target, the flow is patched, and a row is written to `heal_events` |
| `broken` | The flow fails. A real defect reported honestly beats a test quietly repaired |
| `unavailable` | The heal budget is spent, or no provider answered — treated as a plain failure |

Four rules make this safe to trust:

1. **Healed is not passed.** A healed flow is reported `HEALED`, demoted to
   `draft`, and the suite exits `1`. Healing proves something similar is still
   on the page, not that the application still does what the flow asserts. It
   earns `verified` back on its next clean, heal-free replay.
2. **One call per step, no second opinion** — even when the relocated target
   also fails. A model asked twice will eventually find *something* to click,
   and "eventually found something" is the failure mode that makes a green
   regression suite worthless.
3. **Capped for the whole suite** by `regress.max_heal_calls` (default 10).
4. **Never touches** a step a guard refused, or a `{secret}` value.

Every heal is auditable:

```bash
sqlite3 memory/magpie.db \
  "SELECT f.slug, h.seq, h.old_target, h.new_target, h.model_note
   FROM heal_events h JOIN flows f ON f.id = h.flow_id ORDER BY h.created_at DESC"
```

---

## Findings across runs

Findings are **fingerprinted**, so the same defect seen on three nights is one
defect with three sightings — not three defects.

- `NEW` — first sighted in this run.
- `KNOWN` — reported before, carrying `seenCount` and `firstSeenAt`.

A nightly report leads with what broke tonight and files the rest under *known,
seen 4× since 2026-09-19*. **Nothing is ever auto-closed:** a finding that stops
appearing is not thereby fixed, and Magpie will not pretend otherwise.

The `regression` oracle is the one this whole design exists for. Not "this looks
wrong to a language model", but **"this worked on Sunday and does not work
today"** — with the date it last passed and which run proved it. It is raised on
every run of a flow that is still broken, not only the night it first breaks:
otherwise a nightly suite reports a breakage once and then goes quiet, which is
how a broken flow becomes invisible.

---

## Coverage is coverage of the map

```bash
magpie memory coverage
magpie memory coverage --json
```

Magpie draws its own map, so coverage measures how much of **what it has found**
has been exercised — never a claim about the whole application. Every coverage
output says so, and that sentence is not boilerplate.

Two deliberate choices in the numbers:

- **Nameless elements are not counted.** Nothing could ever say "this one was
  exercised" about them, so counting them would depress every ratio by a
  constant.
- **A page with nothing interactive scores 100%**, not 0%. It cannot be
  under-explored, and ranking it worst would send the explorer back to it
  forever.

**Known limit:** discovery reads real `href`s. On an app that navigates in
JavaScript — every in-app link an `href="#"` — the frontier stays empty and the
map grows only as sessions actually walk pages. Traditional link navigation
crawls properly. Fixing this (treating a click that changes the URL as a
discovery, and ingesting `sitemap.xml`) is top of the post-1.0 backlog.

---

## Inspecting, sharing and forgetting

```bash
magpie memory show                       # counts, top pages, flows, recent sessions
magpie memory stats                      # size on disk, schema version, totals
magpie dashboard                         # all of it as one offline HTML page
magpie flows show add-item-to-cart       # the exact steps replay will run
magpie flows delete add-item-to-cart -y  # forget one flow
rm -rf memory/                           # forget everything; the next run starts fresh
```

`magpie init` gitignores `memory/`. Committing it is a deliberate and reasonable
choice: it holds no secrets, and checking it in gives your team a shared set of
replayable flows that arrive with the repository. Delete the `memory/` line from
the generated `.gitignore` if you want that — see
[ci.md](ci.md#committing-memory).
