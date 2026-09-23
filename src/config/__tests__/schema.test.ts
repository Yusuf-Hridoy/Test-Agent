import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../load.js";

const minimal = `name: demo\nbase_url: https://www.saucedemo.com\n`;

describe("config schema", () => {
  it("accepts a minimal config and fills defaults", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.name).toBe("demo");
    expect(cfg.budget).toEqual({ max_steps: 80, max_llm_requests: 60, max_minutes: 20 });
    expect(cfg.model.primary).toBe("gemini");
    expect(cfg.model.fallback).toEqual(["groq", "mistral"]);
    expect(cfg.model.min_delay_ms).toBe(7000);
    expect(cfg.auth.strategy).toBe("manual");
    expect(cfg.run.headed).toBe(false);
    expect(cfg.forbidden_elements).toContain("logout");
  });

  it("derives scope.include from base_url when absent", () => {
    expect(parseConfig(minimal).scope.include).toEqual(["www.saucedemo.com/**"]);
  });

  it("keeps an explicit scope.include", () => {
    const cfg = parseConfig(`${minimal}scope:\n  include: ["example.com/app/**"]\n`);
    expect(cfg.scope.include).toEqual(["example.com/app/**"]);
  });

  it("rejects a bad URL with a human message", () => {
    expect(() => parseConfig(`name: demo\nbase_url: not-a-url\n`)).toThrow(ConfigError);
    try {
      parseConfig(`name: demo\nbase_url: not-a-url\n`);
    } catch (err) {
      expect((err as Error).message).toContain("base_url");
      expect((err as Error).message).toContain("absolute URL");
    }
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseConfig(`${minimal}colour: blue\n`)).toThrow(/invalid/i);
  });

  it("rejects a non-positive budget", () => {
    expect(() => parseConfig(`${minimal}budget:\n  max_steps: 0\n`)).toThrow(ConfigError);
  });

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("name: [unclosed\n")).toThrow(/not valid YAML/);
  });
});
