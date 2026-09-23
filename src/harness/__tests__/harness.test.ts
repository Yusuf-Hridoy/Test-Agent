import { describe, expect, it, vi } from "vitest";
import { Budget } from "../budgets.js";
import { fingerprint, LoopDetector } from "../loopdetect.js";
import { classifyActionResult, slowGrace, waitForRecovery } from "../envmon.js";
import { findErrorMessage } from "../auth.js";
import { UsageTracker } from "../../model/usage.js";
import { parseConfig } from "../../config/load.js";
import type { Snapshot } from "../../types.js";

const cfg = parseConfig(
  `name: t\nbase_url: https://e.com\nbudget:\n  max_steps: 3\n  max_llm_requests: 2\n  max_minutes: 1\n`,
);

describe("Budget", () => {
  it("reports no hit until a limit is reached", () => {
    const usage = new UsageTracker();
    const b = new Budget(cfg, usage);
    expect(b.hit()).toBeNull();
    b.countStep();
    b.countStep();
    expect(b.hit()).toBeNull();
    expect(b.stepsLeft()).toBe(1);
    b.countStep();
    expect(b.hit()).toBe("steps");
  });

  it("hits the LLM limit from the usage tracker", () => {
    const usage = new UsageTracker();
    const b = new Budget(cfg, usage);
    usage.record("gemini");
    expect(b.hit()).toBeNull();
    usage.record("groq");
    expect(b.hit()).toBe("llm");
    expect(b.llmLeft()).toBe(0);
  });

  it("hits the time limit on the wall clock", () => {
    const b = new Budget(cfg, new UsageTracker(), Date.now() - 61_000);
    expect(b.hit()).toBe("time");
    expect(b.minutesLeft()).toBe(0);
  });

  it("summarises usage for the report header", () => {
    const b = new Budget(cfg, new UsageTracker());
    b.countStep();
    expect(b.summary()).toMatch(/^1\/3 steps · 0\/2 LLM calls · /);
  });
});

const snap = (url: string, names: string[], values: string[] = []): Snapshot => ({
  url,
  title: "t",
  elements: names.map((n, i) => ({
    id: `e${i + 1}`,
    role: "button",
    name: n,
    tag: "button",
    ...(values[i] ? { value: values[i] } : {}),
  })),
  pageText: "",
});

describe("fingerprint", () => {
  it("is stable for the same page shape and differs when it changes", () => {
    expect(fingerprint(snap("/a", ["X"]))).toBe(fingerprint(snap("/a", ["X"])));
    expect(fingerprint(snap("/a", ["X"]))).not.toBe(fingerprint(snap("/b", ["X"])));
    expect(fingerprint(snap("/a", ["X"]))).not.toBe(fingerprint(snap("/a", ["Y"])));
  });

  it("changes when a form field is filled (S6: filling a form is progress)", () => {
    const empty = snap("/checkout", ["First Name", "Last Name"]);
    const oneFilled = snap("/checkout", ["First Name", "Last Name"], ["Magpie"]);
    const twoFilled = snap("/checkout", ["First Name", "Last Name"], ["Magpie", "QA"]);
    expect(fingerprint(empty)).not.toBe(fingerprint(oneFilled));
    expect(fingerprint(oneFilled)).not.toBe(fingerprint(twoFilled));
  });
});

describe("LoopDetector", () => {
  it("passes distinct fingerprints", () => {
    const d = new LoopDetector();
    expect(["a", "b", "c", "d"].map((f) => d.onFingerprint(f, "O-01"))).toEqual([
      "ok", "ok", "ok", "ok",
    ]);
  });

  it("flags the same fingerprint three times inside the window", () => {
    const d = new LoopDetector();
    expect(d.onFingerprint("a", "O-01")).toBe("ok");
    expect(d.onFingerprint("b", "O-01")).toBe("ok");
    expect(d.onFingerprint("a", "O-01")).toBe("ok");
    expect(d.onFingerprint("a", "O-01")).toBe("stuck");
  });

  it("does not flag a repeat that falls outside the window", () => {
    const d = new LoopDetector();
    d.onFingerprint("a", "O-01");
    for (const f of ["b", "c", "d", "e", "f"]) d.onFingerprint(f, "O-01");
    expect(d.onFingerprint("a", "O-01")).toBe("ok");
  });

  it("forces a block after two stuck verdicts on one objective", () => {
    const d = new LoopDetector();
    const spin = () => ["a", "a", "a"].forEach((f) => d.onFingerprint(f, "O-01"));
    spin();
    expect(d.shouldForceBlock("O-01")).toBe(false);
    spin();
    expect(d.stuckCount("O-01")).toBe(2);
    expect(d.shouldForceBlock("O-01")).toBe(true);
    expect(d.shouldForceBlock("O-02")).toBe(false);
  });

  it("counts non-fingerprint stalls too", () => {
    const d = new LoopDetector();
    d.noteStuck("O-03");
    d.noteStuck("O-03");
    expect(d.shouldForceBlock("O-03")).toBe(true);
  });
});

describe("environment classification", () => {
  const cases: [string, Parameters<typeof classifyActionResult>[0], Parameters<typeof classifyActionResult>[1], string][] = [
    ["connection refused", { ok: false, detail: "", navError: "net::ERR_CONNECTION_REFUSED" }, { originWasReachable: true }, "suspect_outage"],
    ["dns failure", { ok: false, detail: "", navError: "net::ERR_NAME_NOT_RESOLVED" }, { originWasReachable: true }, "suspect_outage"],
    ["offline", { ok: false, detail: "", navError: "net::ERR_INTERNET_DISCONNECTED" }, { originWasReachable: true }, "suspect_outage"],
    ["browser error page after a dead server (S3)", { ok: false, detail: "", navError: "net::ERR_FAILED (browser error page)" }, { originWasReachable: true }, "suspect_outage"],
    ["node-level ECONNREFUSED", { ok: false, detail: "", navError: "ECONNREFUSED" }, { originWasReachable: true }, "suspect_outage"],
    ["navigation timeout on a reachable origin", { ok: false, detail: "", timedOut: true }, { originWasReachable: true, isNavigation: true }, "suspect_outage"],
    ["navigation timeout before anything loaded", { ok: false, detail: "", timedOut: true }, { originWasReachable: false, isNavigation: true }, "ok"],
    ["click timeout (S2: element problem, not an outage)", { ok: false, detail: "locator.click: Timeout 15000ms exceeded", timedOut: true }, { originWasReachable: true }, "ok"],
    ["three distinct 5xx", { ok: false, detail: "" }, { originWasReachable: true, serverErrorUrls: ["/a", "/b", "/c"] }, "suspect_outage"],
    ["two distinct 5xx", { ok: false, detail: "" }, { originWasReachable: true, serverErrorUrls: ["/a", "/b"] }, "ok"],
    ["same 5xx three times", { ok: false, detail: "" }, { originWasReachable: true, serverErrorUrls: ["/a", "/a", "/a"] }, "ok"],
    ["a normal failed click", { ok: false, detail: "element not visible" }, { originWasReachable: true }, "ok"],
    ["a 404 page", { ok: true, detail: "OK" }, { originWasReachable: true }, "ok"],
  ];

  for (const [label, result, opts, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyActionResult(result, opts).verdict).toBe(expected);
    });
  }
});

describe("waitForRecovery", () => {
  it("returns true as soon as the base URL answers", async () => {
    const page = { goto: vi.fn().mockResolvedValue({ status: () => 200 }) };
    const lines: string[] = [];
    const ok = await waitForRecovery(page as never, "https://e.com", (l) => lines.push(l), [1, 1, 1]);
    expect(ok).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("recovered");
  });

  it("returns false after every retry fails", async () => {
    const page = { goto: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")) };
    const ok = await waitForRecovery(page as never, "https://e.com", () => {}, [1, 1, 1]);
    expect(ok).toBe(false);
    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  it("treats a 5xx as still failing", async () => {
    const page = { goto: vi.fn().mockResolvedValue({ status: () => 503 }) };
    expect(await waitForRecovery(page as never, "https://e.com", () => {}, [1])).toBe(false);
  });
});

describe("slowGrace", () => {
  it("does not retry a successful action", async () => {
    const attempt = vi.fn().mockResolvedValue({ ok: true, detail: "OK" });
    const out = await slowGrace(attempt, 5000, "goto");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.observation).toBeUndefined();
  });

  it("retries a timeout with extra grace and records an observation", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, timedOut: true, detail: "timeout" })
      .mockResolvedValueOnce({ ok: true, detail: "OK" });
    const out = await slowGrace(attempt, 15_000, "goto /inventory");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenLastCalledWith(15_000);
    expect(out.result.ok).toBe(true);
    expect(out.observation).toEqual({
      type: "slow_page",
      detail: "goto /inventory needed an extra 15000ms to complete (first attempt timed out)",
    });
  });

  it("does not retry a non-timeout failure", async () => {
    const attempt = vi.fn().mockResolvedValue({ ok: false, detail: "refused" });
    const out = await slowGrace(attempt, 15_000, "click");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.observation).toBeUndefined();
  });
});

describe("login failure messages", () => {
  it("ignores a page that merely lists a username containing 'error'", () => {
    const saucedemoLoginPage =
      "Swag Labs\nAccepted usernames are:\nstandard_user\nlocked_out_user\nerror_user\n\nPassword for all users:\nsecret_sauce";
    expect(findErrorMessage(saucedemoLoginPage)).toBeUndefined();
  });

  it("finds a real failure message", () => {
    expect(
      findErrorMessage("Epic sadface: Username and password do not match any user in this service"),
    ).toContain("do not match");
    expect(findErrorMessage("Error: Password is required")).toBe("Error: Password is required");
  });
});
