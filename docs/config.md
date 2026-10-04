# `magpie.config.yaml`

One file per project, **safe to commit** — secrets live in `.env`, which
`magpie init` gitignores. Unknown keys are rejected rather than ignored, so a
typo fails the run instead of silently doing nothing.

A minimal config is two lines:

```yaml
name: "shop"
base_url: "https://shop.example.com"
```

Everything else has a default. A realistic one:

```yaml
name: "shop"
base_url: "https://staging.shop.example.com"

auth:
  strategy: form-login
  probe_url: /dashboard
  user_env: APP_USER
  pass_env: APP_PASS

scope:
  include:
    - "staging.shop.example.com/**"
  exclude:
    - "*/admin/**"
    - "*/billing/**"

budget:
  max_steps: 120
  max_llm_requests: 40
  max_minutes: 25

model:
  primary: gemini
  fallback: [groq, mistral]
  min_delay_ms: 7000

explore:
  max_new_pages: 6
  max_objectives_per_page: 2

run:
  headed: false
```

---

## `name` · `base_url`

| Key | Default | Meaning |
|---|---|---|
| `name` | **required** | Project name, shown in reports and the dashboard |
| `base_url` | **required** | Absolute `http`/`https` URL where every session starts |

## `auth`

| Key | Default | Meaning |
|---|---|---|
| `auth.strategy` | `manual` | `manual` → capture a session with `magpie login`. `form-login` → Magpie fills the login form itself |
| `auth.login_url` | — | Only if the login form is not on `base_url` |
| `auth.probe_url` | `base_url` | The page Magpie opens to decide whether the saved session is alive. A path is resolved against `base_url` |
| `auth.user_env` | `APP_USER` | Name of the `.env` variable holding the username |
| `auth.pass_env` | `APP_PASS` | Name of the `.env` variable holding the password |

**Set `probe_url` when your landing page shows the login form whether or not you
are logged in** — that page cannot answer "is this session alive?". On
saucedemo:

```yaml
auth:
  probe_url: /inventory.html
```

The session then *continues* from the probe target rather than bouncing back to
`base_url`. On the apps this field exists for, `base_url` is the login screen,
which is the one page that tells the planner nothing.

## `scope`

| Key | Default | Meaning |
|---|---|---|
| `scope.include` | `<host of base_url>/**` | Globs the browser is allowed to navigate to |
| `scope.exclude` | `[]` | Globs refused even when included |

Globs match against **`host + path`, with no scheme**. `**` crosses path
separators; `*` does not — which is why the default is `host/**` and not
`host/*`, since the latter would refuse `/inventory/item.html`.

```yaml
scope:
  include:
    - "shop.example.com/**"
    - "cdn.shop.example.com/**"
  exclude:
    - "*/admin/**"
    - "shop.example.com/logout"
```

A refused navigation is logged as a step and returned to the model as a tool
error — it is never silent.

## `forbidden_elements`

Case-insensitive substring match against an element's accessible name. Clicking
a match is refused in the browser layer, not by prompting.

Default:

```yaml
forbidden_elements:
  - "logout"
  - "log out"
  - "sign out"
  - "delete"
  - "remove account"
  - "billing"
  - "payment"
  - "purchase"
  - "subscribe"
```

Setting the key **replaces** the list, so include the defaults you still want.
Your app's destructive verbs may differ — "archive", "revoke", "cancel plan".

## `budget`

Hard limits, enforced by the harness in plain code. The loop cannot exceed them
whatever the model outputs.

| Key | Default | Meaning |
|---|---|---|
| `budget.max_steps` | `80` | Browser actions + harness events |
| `budget.max_llm_requests` | `60` | Model calls for the whole session |
| `budget.max_minutes` | `20` | Wall-clock time |

Hitting one ends the session as `BUDGET_EXHAUSTED`, which still writes a full
report and still exits `0` — the run happened, it just ran out of room.

Free-tier sizing: an exploratory session spends roughly one call per page plus a
few per objective. `max_llm_requests: 30` is a sane ceiling for a daily free
quota; raise it when you have more.

## `model`

| Key | Default | Meaning |
|---|---|---|
| `model.primary` | `gemini` | First provider tried |
| `model.fallback` | `[groq, mistral]` | Tried in order on quota/auth failure |
| `model.min_delay_ms` | `7000` | Minimum spacing between calls to one provider |
| `model.ids` | see below | Override a model ID when a provider retires one |

Defaults — all free-tier, all tool-calling:

| Provider | Model | Vision | Key env var |
|---|---|---|---|
| `gemini` | `gemini-3.1-flash-lite` | yes | `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`) |
| `groq` | `openai/gpt-oss-120b` | **no** — screenshots are dropped with a note | `GROQ_API_KEY` |
| `mistral` | `mistral-small-latest` | yes | `MISTRAL_API_KEY` |

Free-tier quotas are **per model per day**, which is why the default is
flash-lite rather than a bigger flash model: `gemini-3.6-flash` allows 20
requests a day, and a single session exhausts that on its own.

Override an ID when a provider retires one:

```yaml
model:
  ids:
    gemini: gemini-3.1-flash-lite
```

Pinned IDs are deliberate. A moving alias like `gemini-flash-latest` makes runs
non-reproducible, which is the opposite of what a QA tool is for.

## `run`

| Key | Default | Meaning |
|---|---|---|
| `run.headed` | `false` | Show the browser window (`--headed` overrides) |
| `run.slow_network_grace_ms` | `15000` | Extra time a timed-out action gets on one retry before it counts as a failure |

## `regress`

| Key | Default | Meaning |
|---|---|---|
| `regress.heal` | `false` | Let a model relocate a failed step (same as `--heal`) |
| `regress.max_heal_calls` | `10` | Hard cap on healing calls for a whole suite |

Healing is off unless you ask for it. A healed flow is demoted to `draft` and
the suite exits `1` — see [memory.md](memory.md#healing).

## `explore`

| Key | Default | Meaning |
|---|---|---|
| `explore.max_new_pages` | `8` | Never-visited pages one session may take off the frontier |
| `explore.max_objectives_per_page` | `3` | Objectives generated per page — one model call produces them all |

Budgets remain the real horizon: these shape the crawl, `budget` stops it.

---

## `.env`

Never committed. Written as a skeleton by `magpie init`:

```bash
# LLM provider keys — you only need the ones you use.
GOOGLE_GENERATIVE_AI_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=

# Application credentials, used when auth.strategy is "form-login".
APP_USER=
APP_PASS=
```

Every non-empty value here is registered as a secret before the first model call
and masked out of prompts, logs, step records, reports and memory. Existing
environment variables take precedence over the file, which is how CI secrets get
in.

## Project layout

```
my-tests/
  magpie.config.yaml    # this file — safe to commit
  .env                  # secrets — gitignored
  .auth/                # saved browser sessions — gitignored
  memory/magpie.db      # the app map and flows — commit optional
  reports/<timestamp>/  # one folder per run
  dashboard.html        # magpie dashboard
```

`memory/` is gitignored by default. Committing it is a reasonable choice: it
holds no secrets, and it means your replayable flows arrive with the repository
and are reviewable in pull requests. Delete that line from the generated
`.gitignore` to do so — see [ci.md](ci.md#committing-memory).
