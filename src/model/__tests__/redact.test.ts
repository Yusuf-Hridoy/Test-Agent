import { describe, expect, it } from "vitest";
import { redact, redactDeep, REDACTED, SecretStore } from "../redact.js";

describe("redact", () => {
  it("masks known secret values wherever they appear", () => {
    const out = redact("logged in as bob with secret_sauce now", ["secret_sauce"]);
    expect(out).toBe(`logged in as bob with ${REDACTED} now`);
  });

  it("masks values after sensitive keys", () => {
    expect(redact("Authorization: Bearer abc123xyz", [])).toBe(`Authorization: ${REDACTED}`);
    expect(redact("cookie=session_id=deadbeef", [])).toContain(REDACTED);
    expect(redact("cookie=session_id=deadbeef", [])).not.toContain("deadbeef");
    expect(redact('"password": "hunter2"', [])).not.toContain("hunter2");
    expect(redact("token: eyJhbGciOi", [])).not.toContain("eyJhbGciOi");
  });

  it("only masks the sensitive line, not the whole text", () => {
    const out = redact("url: /inventory\nAuthorization: Bearer abc\ntitle: Products", []);
    expect(out).toContain("url: /inventory");
    expect(out).toContain("title: Products");
    expect(out).not.toContain("Bearer abc");
  });

  it("leaves normal text untouched", () => {
    const text = 'Clicked "Add to cart". URL now /inventory.html';
    expect(redact(text, ["secret_sauce"])).toBe(text);
  });

  it("ignores secrets too short to mask safely", () => {
    expect(redact("a cat sat on the mat", ["cat"])).toBe("a cat sat on the mat");
  });
});

describe("SecretStore", () => {
  it("collects secrets at runtime and masks longest-first", () => {
    const store = new SecretStore(["hunter2pass"]);
    store.add("hunter2pass-extended");
    store.add("  ");
    const out = store.redact("try hunter2pass-extended and hunter2pass");
    expect(out).toBe(`try ${REDACTED} and ${REDACTED}`);
  });
});

describe("redactDeep", () => {
  it("masks string leaves without breaking structure", () => {
    const out = redactDeep(
      { a: "password: hunter2pass", b: [1, { c: "clean" }], d: null, e: 7, f: true },
      [],
    );
    expect(out.a).toBe(`password: ${REDACTED}`);
    expect(out.b).toEqual([1, { c: "clean" }]);
    expect(out.d).toBeNull();
    expect(out.e).toBe(7);
    expect(out.f).toBe(true);
  });

  it("keeps JSON parseable when a value contains a sensitive key (regression, S1)", () => {
    // redact() over serialized JSON ate the closing quote+comma of this string.
    const finding = {
      id: "F-001",
      title: "Unexpected 401: /api/submit?universe=U&token=abc123secret",
      severity: "medium",
    };
    const json = JSON.stringify(redactDeep({ findings: [finding], n: 1 }, []), null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.findings[0].severity).toBe("medium");
    expect(parsed.n).toBe(1);
    expect(parsed.findings[0].title).not.toContain("abc123secret");
    expect(parsed.findings[0].title).toContain(REDACTED);
  });
});
