import { DEFAULT_BUDGET, DEFAULT_FORBIDDEN_ELEMENTS, defaultInclude } from "./schema.js";

/** The commented magpie.config.yaml written by `magpie init`. */
export function configTemplate(name: string, baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  const include = defaultInclude(baseUrl)
    .map((g) => `  - "${g}"`)
    .join("\n");
  const forbidden = DEFAULT_FORBIDDEN_ELEMENTS.map((f) => `  - "${f}"`).join("\n");
  return `# Magpie project config — safe to commit. Secrets live in .env (gitignored).
name: "${name}"
# Where every session starts.
base_url: "${baseUrl}"

auth:
  # manual      → capture a session by hand with \`magpie login\`
  # form-login  → Magpie fills the login form itself using the env vars below
  strategy: manual
  # login_url: "${origin}/login"
  # Page Magpie opens to decide whether the saved session is still alive.
  # Defaults to base_url. Set it when your landing page shows the login form
  # whether or not you are logged in — that page cannot answer the question.
  # A path is resolved against base_url, e.g. on saucedemo:
  # probe_url: /inventory.html
  user_env: APP_USER
  pass_env: APP_PASS

# Scope guard. Globs are matched against "host/path" (no scheme).
# "**" crosses path segments; "*" does not.
scope:
  include:
${include}
  exclude: []
  #  - "*/admin/**"
  # \`magpie run --explore\` drives this app without being told what to test, so
  # these two lists are the only thing standing between it and a page you did
  # not want touched. Explore against staging, never production, and exclude
  # anything destructive before the first exploratory run.

# Elements the agent is never allowed to click (case-insensitive substring
# match against the element's accessible name).
forbidden_elements:
${forbidden}

# Hard limits enforced by the harness, not by prompting.
budget:
  max_steps: ${DEFAULT_BUDGET.max_steps}
  max_llm_requests: ${DEFAULT_BUDGET.max_llm_requests}
  max_minutes: ${DEFAULT_BUDGET.max_minutes}

model:
  primary: gemini
  fallback: [groq, mistral]
  # Minimum delay between calls to the same provider (Gemini free tier ≈ 7s).
  min_delay_ms: 7000
  # Override model IDs if a provider retires one:
  # ids:
  #   gemini: gemini-3.1-flash-lite

# Exploration (\`magpie run --explore\`).
explore:
  # How many never-visited pages one session may pick up from the frontier.
  max_new_pages: 8
  # Objectives generated per page — one model call produces them all.
  max_objectives_per_page: 3

run:
  headed: false
  # Extra grace given to a slow page before a timeout becomes a failure.
  slow_network_grace_ms: 15000

# Memory lives in memory/magpie.db (SQLite): the pages Magpie has seen, the
# flows it can replay, and past findings. Inspect it with \`magpie memory show\`.
# No secret is ever written there — a redacted value is stored as "{secret}"
# and refuses to replay. The generated .gitignore ignores memory/ by default;
# delete that line to commit it and share remembered flows with your team.
`;
}

/** The .env skeleton written by \`magpie init\` — keys only, never values. */
export function envTemplate(): string {
  return `# Magpie secrets — NEVER commit this file.
# LLM provider keys (you only need the ones you use; gemini is the default primary).
# (GEMINI_API_KEY is accepted too, so a key from gemini-cli works as-is.)
GOOGLE_GENERATIVE_AI_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=

# Application credentials, used when auth.strategy is "form-login".
APP_USER=
APP_PASS=
`;
}

export function gitignoreTemplate(): string {
  return (
    `.env\n.auth/\nreports/\n` +
    `# Remembered pages and flows. Delete the next line to commit them and\n` +
    `# share replayable flows with your team — it holds no secrets.\nmemory/\n`
  );
}
