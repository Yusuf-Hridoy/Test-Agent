import { z } from "zod";
import type { MagpieConfig } from "../types.js";

/** Default forbidden element names (CLAUDE.md Hard Rule 4). */
export const DEFAULT_FORBIDDEN_ELEMENTS = [
  "logout",
  "log out",
  "sign out",
  "delete",
  "remove account",
  "billing",
  "payment",
  "purchase",
  "subscribe",
];

export const DEFAULT_BUDGET = { max_steps: 80, max_llm_requests: 60, max_minutes: 20 };

/** Healing is opt-in and bounded (PHASE-3-BRIEF §1.6). */
export const DEFAULT_REGRESS = { heal: false, max_heal_calls: 10 };

export const providerSchema = z.enum(["gemini", "groq", "mistral"]);

export const configSchema = z
  .object({
    name: z.string().min(1, "name must not be empty"),
    base_url: z
      .string()
      .url("base_url must be an absolute URL, e.g. https://example.com")
      .refine((u) => {
        try {
          return /^https?:$/.test(new URL(u).protocol);
        } catch {
          return false; // the .url() check above already reported this
        }
      }, { message: "base_url must use http or https" }),
    auth: z
      .object({
        strategy: z.enum(["manual", "form-login"]).default("manual"),
        login_url: z.string().url().optional(),
        user_env: z.string().default("APP_USER"),
        pass_env: z.string().default("APP_PASS"),
      })
      .default({}),
    scope: z
      .object({
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      })
      .default({}),
    forbidden_elements: z.array(z.string()).default(DEFAULT_FORBIDDEN_ELEMENTS),
    budget: z
      .object({
        max_steps: z.number().int().positive().default(DEFAULT_BUDGET.max_steps),
        max_llm_requests: z.number().int().positive().default(DEFAULT_BUDGET.max_llm_requests),
        max_minutes: z.number().positive().default(DEFAULT_BUDGET.max_minutes),
      })
      .default({}),
    model: z
      .object({
        primary: providerSchema.default("gemini"),
        fallback: z.array(providerSchema).default(["groq", "mistral"]),
        min_delay_ms: z.number().int().nonnegative().default(7000),
        ids: z.record(providerSchema, z.string()).optional(),
      })
      .default({}),
    run: z
      .object({
        headed: z.boolean().default(false),
        slow_network_grace_ms: z.number().int().nonnegative().default(15000),
      })
      .default({}),
    regress: z
      .object({
        heal: z.boolean().default(DEFAULT_REGRESS.heal),
        max_heal_calls: z.number().int().nonnegative().default(DEFAULT_REGRESS.max_heal_calls),
      })
      .default({}),
  })
  .strict();

export type RawConfig = z.input<typeof configSchema>;

/** Default scope: everything on the base URL's host. */
export function defaultInclude(baseUrl: string): string[] {
  return [`${new URL(baseUrl).host}/**`];
}

/** Apply the derived defaults zod cannot express (they depend on base_url). */
export function withDerivedDefaults(cfg: MagpieConfig): MagpieConfig {
  if (cfg.scope.include.length === 0) {
    return { ...cfg, scope: { ...cfg.scope, include: defaultInclude(cfg.base_url) } };
  }
  return cfg;
}
