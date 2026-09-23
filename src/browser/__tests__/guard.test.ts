import { describe, expect, it } from "vitest";
import { checkClick, checkGoto, isUrlInScope, scopeTarget } from "../guard.js";
import { parseConfig } from "../../config/load.js";

const cfg = parseConfig(`name: demo\nbase_url: https://www.saucedemo.com\n`);
const excluding = parseConfig(
  `name: demo\nbase_url: https://shop.example.com\nscope:\n  include: ["shop.example.com/**"]\n  exclude: ["*/admin/**"]\n`,
);

describe("scope guard", () => {
  it("matches host+path without the scheme", () => {
    expect(scopeTarget("https://a.com/x/y?q=1#z")).toBe("a.com/x/y");
  });

  it("allows in-scope URLs, including nested paths", () => {
    expect(checkGoto("https://www.saucedemo.com/", cfg).allowed).toBe(true);
    expect(checkGoto("https://www.saucedemo.com/inventory.html", cfg).allowed).toBe(true);
    expect(checkGoto("https://www.saucedemo.com/a/b/c", cfg).allowed).toBe(true);
  });

  it("blocks another host with a readable reason", () => {
    const v = checkGoto("https://evil.example.com/x", cfg);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("BLOCKED by scope guard");
    expect(v.reason).toContain("outside allowed scope");
  });

  it("blocks excluded paths even when included", () => {
    expect(checkGoto("https://shop.example.com/catalog", excluding).allowed).toBe(true);
    const v = checkGoto("https://shop.example.com/admin/users", excluding);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("excluded from scope");
  });

  it("blocks non-http protocols", () => {
    expect(checkGoto("file:///etc/passwd", cfg).allowed).toBe(false);
    expect(checkGoto("javascript:alert(1)", cfg).allowed).toBe(false);
  });

  it("resolves relative URLs against the current page", () => {
    expect(checkGoto("/cart.html", cfg, "https://www.saucedemo.com/inventory.html").allowed).toBe(true);
    expect(checkGoto("//evil.example.com/x", cfg, "https://www.saucedemo.com/").allowed).toBe(false);
  });
});

describe("forbidden elements", () => {
  it("refuses a Logout control by accessible name, case-insensitively", () => {
    const v = checkClick({ name: "Logout" }, cfg);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("REFUSED: 'Logout' matches forbidden element 'logout'");
  });

  it("refuses substring matches like 'Delete account'", () => {
    expect(checkClick({ name: "Delete account" }, cfg).allowed).toBe(false);
    expect(checkClick({ name: "Proceed to payment" }, cfg).allowed).toBe(false);
  });

  it("allows ordinary controls", () => {
    expect(checkClick({ name: "Add to cart" }, cfg).allowed).toBe(true);
    expect(checkClick({ name: "" }, cfg).allowed).toBe(true);
  });
});

describe("isUrlInScope (S1: third-party request filtering)", () => {
  it("accepts requests to the app under test", () => {
    expect(isUrlInScope("https://www.saucedemo.com/api/cart", cfg)).toBe(true);
  });

  it("rejects requests to somebody else's server", () => {
    expect(isUrlInScope("https://events.backtrace.io/api/unique-events/submit?token=x", cfg)).toBe(false);
  });

  it("treats a different host spelling or port as out of scope", () => {
    const local = parseConfig(`name: t\nbase_url: http://127.0.0.1:8080\n`);
    expect(isUrlInScope("http://127.0.0.1:8080/x", local)).toBe(true);
    expect(isUrlInScope("http://localhost:8080/x", local)).toBe(false);
    expect(isUrlInScope("http://127.0.0.1:9999/x", local)).toBe(false);
  });

  it("honours scope.exclude", () => {
    expect(isUrlInScope("https://shop.example.com/admin/users", excluding)).toBe(false);
  });

  it("rejects an unparseable URL rather than guessing", () => {
    expect(isUrlInScope("not a url", cfg)).toBe(false);
  });
});
