# PHASE-1-BRIEF.md — Execution Core (detailed work order)

> Read CLAUDE.md first. This brief is the complete, authoritative work order for
> Phase 1. Work tasks in order (P1-T1 → P1-T10). After each task: run its
> "Verify" block, then update CLAUDE.md → "Current status". If anything here
> conflicts with CLAUDE.md Hard Rules, the Hard Rules win.

---

## 0. Goal

A working CLI, `magpie`, that can:
1. `magpie init` — create a test project folder for a target website
2. `magpie login` — capture an authenticated browser session by hand
3. `magpie run --charter "<instructions>"` — execute an instructed test session
   driven by free-tier LLMs (Gemini primary; Groq/Mistral fallback), inside hard
   budgets, surviving stuck states / slow pages / site outages
4. Produce: live terminal narration, `steps.jsonl`, screenshots, a Playwright
   `trace.zip`, and a self-contained `index.html` report with oracle-labeled,
   evidence-backed findings

### Out of scope (do NOT build in Phase 1)
- Memory/SQLite, `--explore`, `--regress`, dashboard, resume-from-checkpoint,
  interactive plan editing, parallel sessions. (T7 writes one seam file for
  Phase 2; nothing consumes it yet.)

---

## 1. Architecture deep dive

### 1.1 Session lifecycle (state machine)

```
INIT ──▶ AUTH_CHECK ──▶ PLANNING ──▶ EXECUTING ──▶ FINALIZING ──▶ DONE
            │               │            │
            │ auth dead     │ bad JSON   ├─ budget hit ────▶ FINALIZING (BUDGET_EXHAUSTED)
            ▼   (manual)    │  twice     ├─ outage ─▶ PAUSED ─ retries ─▶ EXECUTING
        EXIT code 3         ▼            │                └─ cap hit ─▶ FINALIZING (ENVIRONMENT_DOWN)
                     FINALIZING          └─ fatal crash ─▶ FINALIZING (CRASHED, trace still saved)
                     (PLAN_FAILED)
```

Session status enum (exact strings):
`"COMPLETED" | "BUDGET_EXHAUSTED" | "ENVIRONMENT_DOWN" | "PLAN_FAILED" | "CRASHED" | "AUTH_REQUIRED"`

CLI exit codes: `0` COMPLETED or BUDGET_EXHAUSTED (a report exists),
`2` ENVIRONMENT_DOWN / PLAN_FAILED / CRASHED, `3` AUTH_REQUIRED or config error.

### 1.2 One loop iteration (data flow)

```
        ┌────────────────────────── HARNESS (owns the loop) ─────────────────────────┐
        │ 1. budgets ok? loop-detector ok? env ok?  ── no ──▶ escalate / finalize    │
        │ 2. snapshot = browser.snapshot()                                           │
        │ 3. fingerprint = sha1(url + element ids/names) → loop detector             │
        │ 4. messages = [system, objective, snapshot(json), last tool results]       │
        │ 5. redact(messages) → model.askModel(messages, tools)   [rate-limited]     │
        │ 6. toolCall → dispatch:                                                    │
        │      browser action  → execute → step record → new console/network deltas  │
        │      report_finding  → finding builder (oracle=llm_judgment, low conf)     │
        │      mark_objective  → objective tracker                                   │
        │      look            → screenshot → next call includes image part          │
        │ 7. harness oracles: new console error / 5xx after action?                  │
        │      → auto-finding (high confidence), model informed next turn            │
        │ 8. append steps.jsonl + checkpoint.json                                    │
        └────────────────────────────────────────────────────────────────────────────┘
```

Key inversion to preserve everywhere: **the model is called once per decision
(`generateText`, single-shot). The while-loop, budget checks, and stop
conditions are plain TypeScript in `src/harness/session.ts`.** Never use the AI
SDK's multi-step/autonomous mode.

### 1.3 Core types — create `src/types.ts` first, exactly these shapes

```ts
export type Provider = "gemini" | "groq" | "mistral";

export interface MagpieConfig {            // parsed+validated magpie.config.yaml
  name: string;
  base_url: string;
  auth: { strategy: "manual" | "form-login"; login_url?: string;
          user_env: string; pass_env: string };
  scope: { include: string[]; exclude: string[] };
  forbidden_elements: string[];
  budget: { max_steps: number; max_llm_requests: number; max_minutes: number };
  model: { primary: Provider; fallback: Provider[]; min_delay_ms: number;
           ids?: Partial<Record<Provider, string>> };
  run: { headed: boolean; slow_network_grace_ms: number };
}

export interface ElementRef { id: string; role: string; name: string;
  tag: string; value?: string; disabled?: boolean; }

export interface Snapshot { url: string; title: string;
  elements: ElementRef[]; pageText: string; }        // pageText ≤ 2000 chars

export type StepActor = "model" | "harness";
export interface StepRecord { n: number; t: string;  // ISO timestamp
  actor: StepActor; action: string; args: unknown;   // redacted
  result: { ok: boolean; detail?: string }; url: string; fingerprint: string; }

export type Oracle = "console_error" | "http_5xx" | "http_4xx_unexpected"
  | "crash" | "llm_judgment";
export type Severity = "high" | "medium" | "low";

export interface Finding { id: string;               // F-001…
  title: string; severity: Severity; oracle: Oracle;
  confidence: "high" | "low";                        // hard oracle → high
  expected: string; actual: string;
  objectiveId?: string; steps: number[];             // step ns for repro
  screenshots: string[];                             // relative paths
  console?: string[]; network?: string[]; }

export interface Objective { id: string;             // O-01…
  description: string;
  technique: "happy-path" | "boundary" | "required-field" | "invalid-input"
    | "cancel-midway" | "duplicate" | "state-transition";
  status: "planned" | "in-progress" | "passed" | "finding" | "blocked";
  note?: string; }

export interface SessionResult { status: string; startedAt: string;
  endedAt: string; charter: string; objectives: Objective[];
  findings: Finding[]; observations: { type: string; detail: string }[];
  usage: Record<Provider, { requests: number; inputTokens: number;
    outputTokens: number }>; stepCount: number; reportDir: string; }
```

Everything downstream imports from `types.ts`. Do not redefine shapes locally.

### 1.4 Tool contract (what the model can call)

| Tool | Params (zod) | Returns (string, fed back to model) | Failure text |
|---|---|---|---|
| `goto` | `{url}` | `"OK, now at <url>"` | `"BLOCKED by scope guard: <url> outside allowed scope"` |
| `click` | `{id}` | `"Clicked <name>. URL now <url>"` | `"REFUSED: '<name>' matches forbidden element 'logout'"` / `"Element e12 not found — take a new snapshot"` / timeout text |
| `fill` | `{id, text}` | `"Filled <name>"` | same classes as click |
| `select` | `{id, value}` | `"Selected <value> in <name>"` | ... |
| `press` | `{key}` | `"Pressed <key>"` | invalid key text |
| `wait` | `{ms ≤ 10000}` | `"Waited <ms>ms"` | — |
| `look` | `{}` | `"Screenshot attached to your next message"` | — |
| `report_finding` | `{title, severity, expected, actual}` | `"Recorded F-00X"` | — |
| `mark_objective` | `{status: "passed"\|"blocked", note}` | `"Objective O-XX marked"` | — |

Rules: element `id`s are only valid from the MOST RECENT snapshot (the harness
re-snapshots after every browser action and includes it in the next message).
A snapshot is never a tool — the harness always provides it.

### 1.5 Project-folder contract (output of `magpie init`)

```
<project>/
  magpie.config.yaml      # full default config, commented
  .env                    # KEY= lines, empty values
  .gitignore              # .env  .auth/  reports/
  .auth/                  # created empty
  reports/                # created empty
```

### 1.6 Report-folder contract (output of every run)

```
reports/2026-09-16_14-32-05/
  index.html          # self-contained; inline CSS; screenshots inlined base64
  steps.jsonl         # one StepRecord per line, append-as-you-go
  session.json        # final SessionResult
  checkpoint.json     # overwritten each step
  flows.draft.json    # Phase-2 seam (see T7)
  trace.zip           # Playwright trace (always, even on crash)
  shots/NNN_<slug>.png
```

---

## 2. Tasks

Each task lists: **Create** (files), **Spec** (behavior), **Verify** (commands +
expected result). Add small `vitest` tests where marked 🧪.

### P1-T1 — Scaffold
**Create:** `package.json` (bin: `magpie` → `dist/cli/index.js`; scripts: `build`,
`dev` via tsx, `test`, `demo`), `tsconfig.json` (strict, ES2022, node module
resolution), folder tree from CLAUDE.md §5, `src/cli/index.ts` with commander
declaring `init`, `login`, `run`, `--version`.
**Deps:** `playwright ai@^5 @ai-sdk/google @ai-sdk/groq @ai-sdk/mistral zod yaml
dotenv commander`; dev: `tsx vitest @types/node`. Then `npx playwright install chromium`.
**Verify:** `npm run dev -- --help` lists the three commands. `npm run build` clean.

### P1-T2 — Config + `magpie init`
**Create:** `src/config/schema.ts` (zod schema mirroring `MagpieConfig`, with the
defaults from CLAUDE.md and below), `src/config/load.ts`
(`loadConfig(dir): MagpieConfig` — reads yaml, applies defaults, validates,
throws typed `ConfigError` with human message), `src/cli/init.ts`.
**Defaults:** budget 80 steps / 60 LLM requests / 20 min; model primary gemini,
fallback [groq, mistral], min_delay_ms 7000; forbidden_elements
["logout","log out","sign out","delete","remove account","billing","payment",
"purchase","subscribe"]; scope.include [`<base_url host>/*`].
**init behavior:** prompts for name + base_url (or flags `--name --url`);
refuses to overwrite an existing config; writes all files of §1.5; prints next
steps ("add keys to .env, then run `magpie login`").
**🧪** schema: valid minimal yaml passes; bad URL fails with clear message.
**Verify:** `magpie init --name demo --url https://www.saucedemo.com` in an empty
dir creates the §1.5 tree; run again → error "config already exists".

### P1-T3 — Model adapter
**Create:** `src/model/providers.ts` — ONE constants file:
```ts
export const DEFAULT_MODEL_IDS: Record<Provider,string> = {
  gemini:  "gemini-2.5-flash",     // free-tier IDs drift; overridable via config.model.ids
  groq:    "<pick current best free tool-calling model at build time>",
  mistral: "<pick current free-tier model at build time>",
};
```
Kimi: at build time, check the providers' docs for current free-tier,
tool-calling-capable model IDs, set them here, and record the choice in
CLAUDE.md → Decision log.
**Create:** `src/model/redact.ts` — `redact(text: string, secrets: string[]): string`.
Masks (a) exact occurrences of every string in `secrets` (collected at runtime:
all `.env` values + every value typed into `type=password` inputs), replaced by
`"«redacted»"`; (b) values following keys matching
`/(cookie|token|authorization|password|secret|session)[":= ]/i` on the same line.
**Create:** `src/model/ask.ts` —
```ts
askModel(req: { system: string; messages: CoreMessage[]; tools: ToolSet },
         cfg: MagpieConfig, usage: UsageTracker): Promise<AskResult>
```
Behavior: sleep so ≥ `min_delay_ms` since this provider's last call → redact all
text parts → `generateText({model, system, messages, tools, toolChoice:"auto"})`
→ on 429/quota/503: wait 10 s, retry once; still failing → next provider in
[primary, ...fallback]; if request contains image parts and next provider lacks
vision, strip images and append text `"[screenshot omitted: provider has no
vision]"`; all providers failed → throw `ModelExhaustedError`. Track
requests+tokens per provider in `usage`.
**🧪** redactor: password value, `Authorization: Bearer x`, cookie line → masked;
normal text untouched. Failover: fake provider fn that 429s → second called.
**Verify (live, needs your key):** `npx tsx scripts/smoke-model.ts` (write this
tiny script: asks Gemini "reply PONG" via askModel) → prints PONG and usage
`{gemini:{requests:1,...}}`.

### P1-T4 — Browser layer
**Create:** `src/browser/session.ts` (launch/teardown), `src/browser/snapshot.ts`,
`src/browser/actions.ts`, `src/browser/guard.ts`, `src/browser/collect.ts`.
**session.ts:** `openBrowser(cfg, authName="default"): Promise<B>` — chromium,
`headless: !cfg.run.headed`, context with `storageState` if `.auth/<name>.json`
exists; `context.tracing.start({screenshots:true, snapshots:true})` immediately;
`closeBrowser(b, traceOutPath)` stops tracing into `trace.zip` inside
`try/finally` so a crash still saves the trace.
**collect.ts:** attach listeners once: `page.on("console")` (type error →
buffer), `page.on("response")` (status ≥ 500 always; ≥ 400 if request was
user-triggered navigation/XHR), `page.on("pageerror")`, `page.on("crash")`.
API: `drain(): {console: string[], network: string[], crashed: boolean}` —
returns entries added since last drain (the harness drains after every action).
**snapshot.ts:** `takeSnapshot(page): Promise<{snap: Snapshot, locators: Map<string, Locator>}>`
— collect interactive elements (`a, button, input, select, textarea,
[role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem],
[onclick]`), visible ones first (sort by distance to viewport top), cap 120;
accessible name precedence: aria-label → associated <label> → innerText (trim,
60 chars) → placeholder → name attr; ids `e1…eN` mapped to Locators valid until
next action. `pageText` = `document.body.innerText` truncated to 2000 chars.
**guard.ts:** `checkGoto(url, cfg)` — URL must match an include glob (use
`minimatch` on host+path) and no exclude glob; `checkClick(el, cfg)` —
`forbidden_elements` case-insensitive substring against accessible name.
Both return `{allowed: boolean, reason?: string}`.
**actions.ts:** each action: run guard → execute with 10 s action timeout / 30 s
nav timeout → `Promise` result `{ok, detail, newUrl}` → caller records step.
`fill` on `input[type=password]` registers the value into the redaction secrets
set BEFORE typing.
**🧪** guard: forbidden "Logout" blocked; scope: other host blocked; snapshot on a
small local HTML fixture returns stable ids/names (use `page.setContent`).
**Verify:** `npx tsx scripts/smoke-browser.ts` → opens saucedemo, prints a
snapshot with ~6 elements incl. `role:textbox name:Username`.

### P1-T5 — Harness
**Create:** `src/harness/budgets.ts`, `src/harness/loopdetect.ts`,
`src/harness/envmon.ts`, `src/harness/session.ts` (the orchestrating while-loop,
wired fully in T6).
**budgets.ts:** `class Budget { hit(): "steps"|"llm"|"time"|null }` reading step
count, usage tracker, wall clock.
**loopdetect.ts:** keep last 6 fingerprints (`sha1(url + ids+names joined)`).
`onFingerprint(fp): "ok" | "stuck"` → "stuck" when same fp 3× in window, or 5
consecutive identical. Track per-objective stuck count; expose
`shouldForceBlock(objectiveId)` when count ≥ 2.
**envmon.ts:** classify action/nav errors:
`net::ERR_*`, DNS, `ECONNREFUSED`, timeout on previously-OK origin, ≥3
consecutive 5xx on distinct URLs → suspected outage. `waitForRecovery(page,
baseUrl)`: retry GET base_url at 30/60/120 s; recovered → return true; else
false (session finalizes ENVIRONMENT_DOWN, attaching the failed-request list).
Also expose `slowGrace(action)` wrapper: on first timeout retry once with
`cfg.run.slow_network_grace_ms`; if that succeeds record observation
`{type:"slow_page", ...}`.
**🧪** loopdetect with synthetic fingerprints; envmon classification table.

### P1-T6 — Agent loop + planning
**Create:** `src/agent/prompts.ts`, `src/agent/plan.ts`, `src/agent/tools.ts`,
wire `src/harness/session.ts`, `src/cli/run.ts`.
**Auth check:** goto base_url; heuristic logged-out = final URL contains
`/login|/signin` OR a password input is present on landing. If logged out:
`form-login` → fill user/pass from env vars named in config, submit, verify
heuristic clears, re-save storageState; `manual` → finalize AUTH_REQUIRED (exit 3,
message "run `magpie login`").
**plan.ts:** one askModel call. System: planner persona. User: charter + landing
snapshot JSON. Demand STRICT JSON array of `{id, description, technique}`
(5–15 items). Parse+zod-validate; on failure, retry once appending the parse
error; second failure → PLAN_FAILED.
**prompts.ts — use exactly this executor system prompt (≤ 60 lines, keep verbatim
apart from interpolations):**
```
You are Magpie, a meticulous senior QA engineer executing ONE test objective
against a live web application. You control the browser only through the
provided tools.

Context you receive each turn: the current objective, the latest page snapshot
(url, title, interactive elements with ids, page text), results of your
previous tool calls, and occasionally a screenshot you requested via `look`.

Rules:
1. Work ONLY on the current objective: {objective}. When it is demonstrably
   complete, call mark_objective(status:"passed"). If you cannot proceed after
   trying reasonable alternatives, call mark_objective(status:"blocked", note).
2. Interact only with element ids from the LATEST snapshot.
3. One tool call per turn. Prefer snapshot text over `look`; use `look` only
   when layout/visual state matters.
4. Call report_finding when observed behavior contradicts expected behavior a
   reasonable user would assume, or contradicts the objective's expectation.
   Be precise in expected vs actual. Do not report styling nitpicks.
5. Never attempt: logout, deletion of accounts/data, payments, or navigation
   outside the allowed scope. Such calls will be refused by the system.
6. If a tool result says you are stuck or an element is missing, change
   strategy: navigate elsewhere, or block the objective with a clear note.
7. Budget remaining: {stepsLeft} steps, {llmLeft} model calls. Be economical.
```
**tools.ts:** zod tool definitions per §1.4; browser tools close over the
current page/locator map; `report_finding` and `mark_objective` mutate session
state. After EVERY browser tool: harness drains collectors → any new console
error / 5xx / crash → auto-`Finding` with the matching hard oracle,
confidence high, screenshots (previous step's shot + fresh one) → also injected
into the next model message as `SYSTEM ORACLE NOTE: <summary>`.
**run.ts:** parse flags `--charter <string>` (required), `--as <name>`,
`--headed`; assemble everything; live narration format:
`[12/80] click "Add to cart" → OK (url /inventory.html)`; on finish print the
summary table + report path.
**Verify:** full live run (see §4 scenario 1) reaches DONE with exit 0.

### P1-T7 — Evidence
**Create:** `src/evidence/steps.ts` (append-only JSONL writer, flush per line),
`src/evidence/shots.ts` (numbered screenshot files, slugged),
`src/evidence/findings.ts` (builder assembling Finding from tracker state,
step slice for its objective, drained console/network, screenshot pair),
`src/evidence/flows.ts` — the Phase-2 seam: on each objective → passed, append
`{objectiveId, description, actions: [{action, target:{role,name}, value?, url}]}`
to `flows.draft.json` (redacted values; element targets by role+name, NOT ids).
**🧪** findings builder produces valid Finding; flows writer emits parseable JSON.
**Verify:** after a live run, `wc -l steps.jsonl` > 10; every finding in
session.json references existing screenshot files; `flows.draft.json` parses.

### P1-T8 — Report
**Create:** `src/report/html.ts`, `src/report/terminal.ts`,
`templates/report.html` (placeholder-based; NO external assets, inline CSS,
screenshots as base64 data URIs).
**index.html sections, in order:** header (name, charter, status badge, started/
duration, budgets used e.g. "34/80 steps · 29/60 LLM calls · gemini 25 / groq 4");
plan table (objective, technique, status icon, note); findings — one card each:
severity color, title, oracle + confidence chips, expected vs actual, repro
steps (numbered, from step slice), before/after screenshots, console/network
excerpts in <pre>; observations (slow pages etc.); collapsible full step
timeline (<details>); footer (trace.zip link, magpie version).
**terminal.ts:** compact equivalent + absolute report path last line.
**Verify:** open index.html with network disabled (file://) → fully rendered.

### P1-T9 — `magpie login`
**Create:** `src/cli/login.ts`. Headed chromium → `auth.login_url ?? base_url` →
print "Log in in the opened browser, then press Enter here…" → wait stdin →
`context.storageState({path: .auth/<name>.json})` (`--as <name>`, default
"default") → confirm + hint to add `.auth/` to gitignore if project not
git-initialized. Handle window-closed-before-Enter with a clear error.
**Verify:** run against saucedemo, log in manually, Enter → `.auth/default.json`
exists and contains cookies; then `magpie run` starts already authenticated.

### P1-T10 — README + demo
**Create:** README.md (install, quickstart with saucedemo, config reference table,
report screenshot, security model paragraph: what never leaves the machine,
what is sent to LLM providers, free-tier notice), `scripts/demo.ts` → `npm run
demo`: inits a temp project against https://www.saucedemo.com, auto form-login
with the PUBLIC demo creds (`standard_user` / `secret_sauce` — public, may be
hardcoded in the demo script only), charter: "Log in, add the cheapest item to
the cart, verify cart badge shows 1, remove it, verify badge clears." Runs
headed. Update CLAUDE.md status + decision log.

---

## 3. Cross-cutting implementation notes

- **Message assembly per turn (executor):** system prompt (interpolated) + a
  rolling window: the objective, the LAST snapshot only (never accumulate old
  snapshots — this is the context-explosion killer), last 6 tool-call/result
  pairs summarized to one line each, any pending ORACLE NOTE, any pending image
  from `look`. Hard cap ≈ 8k tokens; truncate pageText first, then element list
  tail.
- **Fingerprint after, not before:** compute on the fresh snapshot following an
  action, so loop detection sees the action's effect.
- **Steps vs LLM calls:** a "step" = one browser action or harness event; plan
  call and each executor call count against `max_llm_requests`, not steps.
- **Slug function** shared by shots/report: lowercase, non-alnum → `-`, max 40.
- **All timestamps ISO-8601 with timezone.**
- **Windows-safe paths everywhere (`path.join`), no shelling out.**
- **Model plain-text stall:** if a model reply has no tool call, harness replies
  "Respond with exactly one tool call." Second consecutive → counts as stuck.

## 4. Manual acceptance plan (run after T10, in order)

| # | Scenario | Expected |
|---|---|---|
| 1 | `npm run demo` (valid Gemini key) | status COMPLETED, ≥4 objectives, all passed, 0–1 findings, exit 0; report renders offline; narration visible live |
| 2 | Charter on saucedemo: "set item quantity to -1 in cart" | ≥1 finding or blocked objective, evidence attached |
| 3 | Disable Wi-Fi ~40 s mid-run, re-enable | session pauses with retry log lines, resumes, finishes; observations note the outage |
| 4 | Disable Wi-Fi until retries exhausted | status ENVIRONMENT_DOWN, exit 2, no application-bug findings from the outage window |
| 5 | Invalid Gemini key, valid Groq key | session completes via failover; report shows `look` degradation note if any |
| 6 | Charter with impossible objective ("buy with PayPal" on saucedemo) | that objective BLOCKED with note; session continues to next objective |
| 7 | `grep -ri secret_sauce reports/ && grep -ri secret_sauce *.log` | zero hits outside .env/demo script (redaction works) |
| 8 | Delete `.auth/default.json`, `auth.strategy: manual`, run | exit 3, message tells you to run `magpie login` |

## 5. Done = 

All Verify blocks pass + all 8 acceptance scenarios pass + CLAUDE.md status
updated + decision log filled (model IDs, any deviations). Then STOP — do not
start Phase 2.