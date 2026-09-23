import { describe, expect, it } from "vitest";
import { plannerUserMessage, PLANNER_SYSTEM_PROMPT } from "../../agent/prompts.js";
import { REDACTED } from "../../model/redact.js";
import type { Snapshot } from "../../types.js";
import { openEphemeralDb, type MemoryDb } from "../db.js";
import { buildMemoryContext, MEMORY_CONTEXT_MAX_CHARS, MEMORY_HEADING, rankByCharter } from "../context.js";
import { SECRET_PLACEHOLDER, type FlowRow } from "../types.js";

const snap: Snapshot = {
  url: "https://app.test/",
  title: "App",
  elements: [{ id: "e1", role: "button", name: "Login", tag: "button" }],
  pageText: "hello",
};

const now = "2026-09-23T10:00:00+02:00";

function populate(db: MemoryDb, pages = 3, flows = 3): void {
  const session = db
    .prepare("INSERT INTO sessions (started_at, status, report_dir) VALUES (?,?,?)")
    .run(now, "COMPLETED", "reports/x").lastInsertRowid;
  for (let i = 0; i < pages; i++) {
    db.prepare(
      "INSERT INTO pages (page_key, sample_url, title, first_seen, last_seen, visit_count) VALUES (?,?,?,?,?,?)",
    ).run(`shop.test/page-${i}`, `https://shop.test/page-${i}`, `Page ${i}`, now, now, pages - i);
  }
  for (let i = 0; i < flows; i++) {
    db.prepare(
      `INSERT INTO flows (slug, name, description, status, start_page_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`flow-${i}`, `Flow number ${i}`, "a charter", i === 0 ? "draft" : "verified", "shop.test/", now, now);
  }
  db.prepare(
    "INSERT INTO findings (session_id, fid, title, severity, oracle, confidence, page_key, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(session, "F-001", "Server error: /api/cart", "high", "http_5xx", "high", "shop.test/page-1", now);
}

describe("buildMemoryContext", () => {
  it("says nothing about an application it has never seen", () => {
    const db = openEphemeralDb();
    expect(buildMemoryContext(db, "any charter")).toBeUndefined();
    db.close();
  });

  it("leaves the planner message byte-identical when there is no memory", () => {
    const db = openEphemeralDb();
    const memory = buildMemoryContext(db, "Log in and add an item");
    // Phase 1 sent exactly this; a first run against a new app must still.
    expect(plannerUserMessage("Log in and add an item", snap, memory)).toBe(
      plannerUserMessage("Log in and add an item", snap),
    );
    db.close();
  });

  it("briefs the planner on pages, verified flows and known high-severity findings", () => {
    const db = openEphemeralDb();
    populate(db);
    const memory = buildMemoryContext(db, "add an item to the cart")!;
    expect(memory).toContain(MEMORY_HEADING);
    expect(memory).toContain("shop.test/page-0");
    expect(memory).toContain("flow-1");
    expect(memory).toContain("Server error: /api/cart");
    // Drafts are not verified ground and must not be offered as such.
    expect(memory).not.toContain("flow-0");
    expect(memory.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    db.close();
  });

  it("appends the briefing to the planner message, after the snapshot", () => {
    const db = openEphemeralDb();
    populate(db);
    const memory = buildMemoryContext(db, "add an item")!;
    const message = plannerUserMessage("add an item", snap, memory);
    expect(message.indexOf(MEMORY_HEADING)).toBeGreaterThan(message.indexOf("LANDING PAGE SNAPSHOT"));
    expect(message).toContain("CHARTER: add an item");
    db.close();
  });

  it("stays inside its character budget on a large app", () => {
    const db = openEphemeralDb();
    populate(db, 60, 40);
    const memory = buildMemoryContext(db, "charter")!;
    expect(memory.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    // The cap drops whole lines, never half a page key.
    expect(memory.endsWith("\n")).toBe(false);
    db.close();
  });

  it("carries no secret material beyond the placeholder itself", () => {
    const db = openEphemeralDb();
    populate(db);
    db.prepare("UPDATE pages SET title = ? WHERE page_key = ?").run(
      "Signed in as user",
      "shop.test/page-0",
    );
    const memory = buildMemoryContext(db, "charter")!;
    expect(memory).not.toContain(REDACTED);
    expect(memory).not.toContain(SECRET_PLACEHOLDER);
    db.close();
  });

  it("orders flows by how much the charter talks about them", () => {
    const flows = [
      { slug: "reset-password", name: "Reset the password", description: null },
      { slug: "add-item-to-cart", name: "Add an item to the cart", description: null },
    ] as FlowRow[];
    const ranked = rankByCharter(flows, "Add the cheapest item to the cart and check the badge");
    expect(ranked[0]!.slug).toBe("add-item-to-cart");
    // No usable charter words → the original order stands.
    expect(rankByCharter(flows, "x y z")[0]!.slug).toBe("reset-password");
  });

  it("tells the planner to extend known ground rather than re-test it", () => {
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/EXTEND\s+or VARY it rather than re-testing identical ground/);
  });
});
