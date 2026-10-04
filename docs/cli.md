# CLI reference

Every command, every flag. `magpie <command> --help` prints the same thing
shorter.

All commands take `--dir <dir>` (default: the current directory) and act on the
Magpie project there — the folder holding `magpie.config.yaml`.

| Command | Needs a model key | Touches the app |
|---|---|---|
| [`init`](#magpie-init) | no | no |
| [`login`](#magpie-login) | no | yes (you drive) |
| [`run --charter`](#magpie-run---charter-what-to-test) | **yes** | yes |
| [`run --explore`](#magpie-run---explore) | **yes** | yes |
| [`run --regress`](#magpie-run---regress-slugall) | only with `--heal` | yes |
| [`dashboard`](#magpie-dashboard) | no | no |
| [`memory show / stats / coverage`](#magpie-memory-show) | no | no |
| [`flows list / show / rename / delete`](#magpie-flows-list) | no | no |
| [`flows replay / verify`](#magpie-flows-replay-slug) | no | yes |

---

## `magpie init`

Creates a project folder: config, `.env` skeleton, `.gitignore`, `.auth/`,
`reports/`.

```bash
magpie init --name shop --url https://shop.example.com
```

| Flag | Default | Meaning |
|---|---|---|
| `--name <name>` | prompted | Project name, shown in reports and the dashboard |
| `--url <url>` | prompted | `base_url` — where every session starts |
| `--dir <dir>` | `.` | Where to create the project |

Without `--name`/`--url` it asks. It **refuses to prompt** when no terminal is
attached, so a scripted call fails loudly instead of hanging forever.

## `magpie login`

Opens a headed browser. You log in by hand, press Enter, and the session is
saved to `.auth/<name>.json`.

```bash
magpie login                 # saves .auth/default.json
magpie login --as admin      # saves .auth/admin.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--as <name>` | `default` | Auth profile name |

The Playwright trace of this command is **discarded on purpose** — a recording
of you typing your password is not evidence anyone wants on disk.

## `magpie run --charter "<what to test>"`

Plans objectives for your charter, drives the browser through them, and writes a
report.

```bash
magpie run --charter "Add the cheapest item to the cart and check the badge"
magpie run --charter "Search for a product and filter by price" --headed
magpie run --charter "Checkout with an invalid postcode" --as admin
```

| Flag | Default | Meaning |
|---|---|---|
| `--charter <string>` | — | What to test, in your own words |
| `--as <name>` | `default` | Which saved session to use |
| `--headed` | `run.headed` (`false`) | Show the browser window |
| `--dir <dir>` | `.` | Project directory |

## `magpie run --explore`

No charter. Magpie decides what to test, page by page: code picks where to go,
the model picks what is worth testing there.

```bash
magpie run --explore
magpie run --explore --headed
```

Where it goes, in order: pages on the frontier (linked from somewhere it has
been, never opened), then the pages whose elements are least exercised. Budgets
are the only crawl limit. Shape it with `explore.max_new_pages` and
`explore.max_objectives_per_page` — see [config.md](config.md#explore).

> **Run this against staging, not production.** `scope.exclude` and
> `forbidden_elements` are the only things between it and a page you did not
> want touched.

## `magpie run --regress <slug|all>`

Replays remembered flows against the live app. **No model calls** unless you
pass `--heal`.

```bash
magpie run --regress all                           # every verified flow
magpie run --regress all --include-draft           # …and the unproven ones
magpie run --regress add-item-to-cart              # one flow, whatever its status
magpie run --regress all --fail-on-skipped --json > suite.json   # CI
magpie run --regress all --heal                    # let a model relocate a renamed target
```

| Flag | Default | Meaning |
|---|---|---|
| `--regress <slug\|all>` | — | One flow by slug, or `all` |
| `--include-draft` | off | With `all`, also replay `draft` flows |
| `--fail-on-skipped` | off | Exit `1` if any flow was skipped, or none ran. **Use this in CI** |
| `--heal` | `regress.heal` (`false`) | One model call per failed step, to relocate a renamed target |
| `--json` | off | `suite.json` to stdout, progress to stderr |
| `--as <name>` | `default` | Which saved session to use |
| `--headed` | `run.headed` | Show the browser window |

Naming a flow explicitly runs it whatever its status; only `--regress all`
applies the verified/draft/broken selection rules.

Full CI recipe, exit codes and the `suite.json` fields: **[ci.md](ci.md)**.

## `magpie dashboard`

Renders one offline HTML page covering everything the project remembers:
coverage, flows, defects (new vs known) and every run.

```bash
magpie dashboard                       # writes ./dashboard.html
magpie dashboard --out public/qa.html  # somewhere else
```

| Flag | Default | Meaning |
|---|---|---|
| `--out <path>` | `<project>/dashboard.html` | A file, or a directory to drop `dashboard.html` into |

Read-only, no browser, no model calls — safe to run at any time, including in
CI. Links to report folders are relative, so the file can be moved or published
as an artifact. An empty project renders a getting-started card rather than
crashing.

## `magpie memory show`

Counts, the most-visited pages, every flow, and recent sessions.

```bash
magpie memory show
```

## `magpie memory stats`

Database path, size on disk (including WAL sidecars), schema version, totals.

```bash
magpie memory stats
```

## `magpie memory coverage`

What has actually been exercised, and where to look next.

```bash
magpie memory coverage
magpie memory coverage --json | jq .elements
```

| Flag | Meaning |
|---|---|
| `--json` | Print the coverage report as JSON (schema-stable, caveat included) |

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

That last line is not boilerplate — see [memory.md](memory.md#coverage-is-coverage-of-the-map).

## `magpie flows list`

Every remembered flow: status, step count, last replay.

```bash
magpie flows list
```

## `magpie flows show <slug>`

One flow's steps, in the exact order replay will run them.

```bash
magpie flows show add-item-to-cart
```

## `magpie flows replay <slug>`

Replays one flow against the live app. **Zero model calls**, always.

```bash
magpie flows replay add-item-to-cart
magpie flows replay add-item-to-cart --headed
```

| Flag | Default | Meaning |
|---|---|---|
| `--as <name>` | `default` | Which saved session to use |
| `--headed` | `run.headed` | Show the browser window |

Evidence lands in `reports/<timestamp>-replay-<slug>/`. A pass promotes nothing
on its own — use `verify` for that.

## `magpie flows verify <slug>`

Replays the flow and promotes it to `verified` **only** on a real pass.

```bash
magpie flows verify add-item-to-cart
```

Deliberately a thin alias for `replay`. There is no way to mark a flow verified
by hand: if there were, `flows list` would stop being trustworthy.

## `magpie flows rename <slug> <new name…>`

```bash
magpie flows rename add-item-to-cart Add an item to the cart
```

The slug does not change — scripts and CI keep working.

## `magpie flows delete <slug>`

```bash
magpie flows delete add-item-to-cart        # asks first
magpie flows delete add-item-to-cart --yes  # does not
```

Its steps go with it. Refuses to prompt when no terminal is attached, so pass
`--yes` in a script.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | A report exists — the session ran, findings or not; or every replay passed |
| `1` | A replay **failed or was healed**; or, with `--fail-on-skipped`, a flow was skipped or none ran |
| `2` | Blocked: `ENVIRONMENT_DOWN`, `PLAN_FAILED`, `CRASHED` |
| `3` | Configuration or auth: bad config, no API key, expired session, no such flow, or a flow a guard refused |

A finding is **not** a non-zero exit from `run --charter`: the session did its
job. Gate your build on `suite.json`, not on the charter run's exit code.

## Environment variables

| Variable | Used for |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` | Gemini (default primary) |
| `GROQ_API_KEY` | Groq fallback |
| `MISTRAL_API_KEY` | Mistral fallback |
| `APP_USER` / `APP_PASS` | Credentials for `auth.strategy: form-login` (names configurable) |

They are read from the project's `.env`, which `magpie init` gitignores.
Existing environment variables win over the file.
