# Running Magpie in CI

A remembered flow replays with **no model calls**, so a nightly regression run
costs nothing but the minutes it takes. This page is the whole setup.

```bash
magpie run --regress all --json > suite.json
```

Exit code `0` means every flow that ran passed. Anything else is worth a look.

---

## What you need in CI

| Thing | Why | How |
|---|---|---|
| `magpie.config.yaml` | target, scope, budgets | committed in your test project |
| `memory/magpie.db` | the flows to replay | commit it (see below), or restore it from a cache/artifact |
| `.auth/<name>.json` | a logged-in session | a CI secret, or re-created each run with `auth.strategy: form-login` |
| An API key | **only** with `--heal` | omit `--heal` and you need no key at all |

### Committing memory

`magpie init` gitignores `memory/`. For CI you generally want the opposite:
delete that line from your project's `.gitignore` and commit the database. It
holds no secrets — a redacted value is stored as `{secret}` and refuses to
replay — and committing it means your regression suite arrives with the
repository and is reviewable in pull requests like any other test.

If you would rather not commit it, cache it between runs and accept that a cold
cache means an empty suite (which exits 0 and reports "0 flows" — check the
totals, not just the exit code).

### Authentication

Replay starts from a saved `storageState`, exactly like `magpie run`. Two ways
to get one into CI:

- **`form-login`** (simplest): set `auth.strategy: form-login` in the config and
  provide `APP_USER` / `APP_PASS` as CI secrets. Magpie logs in at the start of
  the run.
- **A stored session**: base64 the `.auth/default.json` you captured locally
  into a secret, and write it back before the run. Sessions expire — when yours
  does, the suite exits `3` with an auth error rather than reporting false
  failures.

---

## GitHub Actions

```yaml
name: magpie-regression
on:
  schedule:
    - cron: "0 3 * * *"        # 03:00 UTC, nightly
  workflow_dispatch:            # and on demand

jobs:
  regress:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      # Credentials for auth.strategy: form-login
      - name: Write .env
        working-directory: tests/magpie
        run: |
          echo "APP_USER=${{ secrets.APP_USER }}" >> .env
          echo "APP_PASS=${{ secrets.APP_PASS }}" >> .env

      - name: Replay every verified flow
        working-directory: tests/magpie
        run: npx magpie run --regress all --json > suite.json

      # Always upload: the evidence matters most when the step failed.
      - name: Upload evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: magpie-regression
          path: |
            tests/magpie/suite.json
            tests/magpie/reports/
          retention-days: 14
```

`--json` writes the suite document to **stdout and nothing else**; progress
lines go to stderr, so the redirect above captures clean JSON. Without `--json`
you get the human summary on stdout instead.

### Reading the result in a later step

```yaml
      - name: Fail the build on new regressions only
        if: always()
        working-directory: tests/magpie
        run: |
          new=$(jq '[.findings[] | select(.status == "NEW")] | length' suite.json)
          echo "new regressions: $new"
          test "$new" -eq 0
```

### Watch the skipped count, not just the exit code

A `broken` flow is **skipped**, and skipping is not failing — so a suite whose
flows have all broken exits `0` while testing nothing at all. That is the one
way this design can go quietly green, and it is worth one line of defence:

```yaml
      - name: Refuse to pass while flows are broken
        working-directory: tests/magpie
        run: |
          jq -e '.totals.skipped == 0' suite.json \
            || { echo "::warning::flows are broken and were not replayed"; exit 1; }
```

Either fix those flows (`--heal`, or re-record the charter) or delete them. A
regression suite that shrinks silently is worse than no suite.

## Cron (a plain server)

```cron
# Nightly at 03:00. Magpie does not schedule anything itself.
0 3 * * * cd /srv/magpie-tests && /usr/bin/npx magpie run --regress all --json \
  >> /var/log/magpie/$(date +\%F).json 2>> /var/log/magpie/$(date +\%F).log
```

---

## Exit codes

| Code | Meaning | Typical cause |
|------|---------|---------------|
| `0` | every flow that ran passed | nothing to do |
| `1` | at least one flow **failed or was healed** | a real regression, or a flow a model had to repair |
| `2` | the environment | the app was unreachable; remaining flows are marked `UNTESTED` and the suite stops |
| `3` | configuration or auth | no such flow, bad config, expired session, or a flow blocked by a guard |

A **healed** flow exits `1` on purpose. Healing proves something similar is
still on the page; it does not prove the application still does what the flow
asserts. The flow is demoted to `draft` and has to earn `verified` back with a
clean, heal-free replay.

## Non-interactive guarantees

`magpie run --regress` never prompts. The three commands that can ask a question
are `init` (pass `--name` and `--url`), `login` (interactive by nature, not for
CI) and `flows delete` (pass `--yes`) — and all three now refuse to prompt when
no terminal is attached, so a scripted call fails loudly instead of hanging a
job that looks like it is still working.

---

## `suite.json`, field by field

```jsonc
{
  "magpieVersion": "0.1.0",
  "project": "shop",                       // config `name`
  "baseUrl": "https://shop.example.com",
  "startedAt": "2026-09-23T03:00:01.123+00:00",   // ISO-8601 with offset
  "endedAt":   "2026-09-23T03:04:19.980+00:00",
  "durationMs": 258857,

  "selection": {
    "requested": "all",       // the --regress argument: "all" or a slug
    "includeDraft": false,    // --include-draft
    "heal": false             // --heal, or regress.heal in the config
  },

  "totals": {
    "total": 7,       // rows in `flows`, skipped ones included
    "passed": 5,
    "failed": 1,
    "refused": 0,     // a guard stopped the flow — config, not a defect
    "healed": 0,      // ran only because a model relocated a step
    "skipped": 1,     // listed but not run (broken, or draft without the flag)
    "untested": 0     // the app went down before these ran
  },

  "flows": [
    {
      "slug": "add-item-to-cart",
      "name": "Add an item to the cart",
      "statusBefore": "verified",     // flow status before this suite
      "statusAfter": "broken",        // …and after it
      "outcome": "FAIL",              // PASS|FAIL|REFUSED|HEALED|SKIPPED|UNTESTED
      "failedAt": 3,                  // 1-based step, when one failed
      "reason": "no element matched button \"Add to cart\" after 5s",
      "stepsRun": 3,
      "stepsTotal": 5,
      "durationMs": 4120,
      "reportDir": "reports/2026-09-23_03-00-12-replay-add-item-to-cart",
      "lastPassAt": "2026-09-22T03:01:44.002+00:00",  // when it last worked
      "healedStep": 3,                // present only on HEALED
      "healNote": "button:\"Add to cart\"#0 → button:\"Add to basket\"#0 (renamed)"
    }
  ],

  "findings": [
    {
      "id": "R-001",
      "title": "Flow \"add-item-to-cart\" no longer passes",
      "severity": "high",
      "oracle": "regression",     // always "regression" in a suite
      "confidence": "high",       // the flow failing IS the evidence
      "flow": "add-item-to-cart",
      "failedAt": 3,
      "expected": "The flow … replays end to end, as it did on 2026-09-22…",
      "actual": "Step 3 of 5 failed: …",
      "lastPassAt": "2026-09-22T03:01:44.002+00:00",
      "lastPassSession": "session 41 (REGRESSION)",
      "status": "NEW",            // NEW tonight, or KNOWN from earlier runs
      "seenCount": 1,             // sessions that have reported this defect
      "firstSeenAt": "2026-09-23T03:00:01.123+00:00",
      "reportDir": "reports/2026-09-23_03-00-12-replay-add-item-to-cart"
    }
  ],

  "usage": {                      // all zero unless --heal was used
    "gemini":  { "requests": 0, "inputTokens": 0, "outputTokens": 0 },
    "groq":    { "requests": 0, "inputTokens": 0, "outputTokens": 0 },
    "mistral": { "requests": 0, "inputTokens": 0, "outputTokens": 0 }
  },
  "healCalls": 0,                 // model calls spent on healing
  "environmentDown": false,       // the app became unreachable mid-suite
  "exitCode": 1,                  // same code the process exits with
  "reportDir": "reports/2026-09-23_03-00-01-regress"
}
```

Two fields deserve emphasis:

- **`status`** on a finding is what makes a nightly suite readable. `NEW` is
  what broke since the last run; `KNOWN` has been reported before and carries
  `seenCount` and `firstSeenAt`. Gate your build on `NEW` if a known-broken flow
  should not keep failing the pipeline.
- **`usage`** is the honesty check. Without `--heal` it is all zeros, and Magpie
  asserts that in code — if a suite ever spends a request without being asked
  to, it fails rather than quietly billing you.

## What this does not do

Magpie does not schedule anything, does not close findings on its own (a defect
that stops appearing is not thereby fixed), and does not retry a failed flow in
the hope of a different answer. All three are deliberate.
