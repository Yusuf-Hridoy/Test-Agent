import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEphemeralDb, type MemoryDb } from "../../memory/db.js";
import { EXPLORE_CHARTER } from "../../types.js";
import {
  DASHBOARD_FILENAME,
  renderDashboard,
  sessionMode,
  writeDashboard,
} from "../dashboard.js";

/**
 * The dashboard is the only page a reader opens without having run anything,
 * so it has to survive an empty database, and it has to be shareable — which
 * means no absolute paths out of the machine that generated it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-dash-"));
  dirs.push(dir);
  return dir;
}

const S1 = "2026-09-20_10-00-00";
const S2 = "2026-09-22_09-30-00";
const S3 = "2026-09-24_03-00-00";

/** Three runs, three flows and two defects — one of them a repeat offender. */
function fixture(dir: string): MemoryDb {
  const db = openEphemeralDb();
  const reports = (stamp: string) => {
    const p = path.join(dir, "reports", stamp);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const session = db.prepare(
    "INSERT INTO sessions (started_at, ended_at, status, charter, report_dir, llm_requests) VALUES (?,?,?,?,?,?)",
  );
  session.run("2026-09-20T10:00:00+02:00", "2026-09-20T10:08:00+02:00", "COMPLETED",
    "Log in and add the cheapest item to the cart", reports(S1), 25);
  session.run("2026-09-22T09:30:00+02:00", "2026-09-22T09:44:00+02:00", "COMPLETED",
    EXPLORE_CHARTER, reports(S2), 20);
  session.run("2026-09-24T03:00:00+02:00", "2026-09-24T03:00:12+02:00", "REGRESSION",
    "regression: all", reports(S3), 0);

  const page = db.prepare(
    "INSERT INTO pages (page_key, sample_url, title, first_seen, last_seen, visit_count) VALUES (?,?,?,?,?,?)",
  );
  page.run("shop.test/inventory.html", "https://shop.test/inventory.html", "Products",
    "2026-09-20T10:01:00+02:00", "2026-09-24T03:00:05+02:00", 6);
  page.run("shop.test/cart.html", "https://shop.test/cart.html", "Your Cart",
    "2026-09-20T10:03:00+02:00", "2026-09-22T09:40:00+02:00", 2);

  const el = db.prepare(
    "INSERT INTO element_seen (page_key, role, name, first_seen, last_seen, interactions) VALUES (?,?,?,?,?,?)",
  );
  el.run("shop.test/inventory.html", "button", "Add to cart", "x", "y", 3);
  el.run("shop.test/inventory.html", "combobox", "Sort", "x", "y", 1);
  el.run("shop.test/inventory.html", "link", "About", "x", "y", 0);
  el.run("shop.test/cart.html", "button", "Checkout", "x", "y", 0);

  db.prepare(
    "INSERT INTO frontier (page_key, sample_url, first_seen, seen_on_page, visited_at) VALUES (?,?,?,?,NULL)",
  ).run("shop.test/help.html", "https://shop.test/help.html", "2026-09-22T09:35:00+02:00",
    "shop.test/inventory.html");

  const flow = db.prepare(
    `INSERT INTO flows (slug, name, status, start_page_key, created_at, updated_at,
                        last_replay_at, last_replay_result, origin_session)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  flow.run("add-cheapest-item", "Add the cheapest item to the cart", "verified",
    "shop.test/inventory.html", "2026-09-20T10:08:00+02:00", "2026-09-24T03:00:08+02:00",
    "2026-09-24T03:00:08+02:00", "pass", 1);
  flow.run("sort-by-price", "Sort products by price", "draft", "shop.test/inventory.html",
    "2026-09-22T09:44:00+02:00", "2026-09-24T03:00:10+02:00",
    "2026-09-24T03:00:10+02:00", "healed@2", 2);
  flow.run("checkout-form", "Fill the checkout form", "broken", "shop.test/cart.html",
    "2026-09-20T10:08:00+02:00", "2026-09-24T03:00:12+02:00",
    "2026-09-24T03:00:12+02:00", "fail@3", 1);

  const step = db.prepare(
    "INSERT INTO flow_steps (flow_id, seq, action, target_role, target_name, url_after) VALUES (?,?,?,?,?,?)",
  );
  for (const [flowId, seq] of [[1, 1], [1, 2], [2, 1], [3, 1], [3, 2], [3, 3]] as const) {
    step.run(flowId, seq, "click", "button", `t${seq}`, "shop.test/inventory.html");
  }

  db.prepare(
    `INSERT INTO heal_events (flow_id, seq, old_target, new_target, model_note, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(2, 2, 'combobox "Sort"', 'combobox "Order by"', "renamed", "2026-09-24T03:00:10+02:00");

  const finding = db.prepare(
    `INSERT INTO findings (session_id, fid, title, severity, oracle, confidence, page_key,
                           created_at, fingerprint, first_seen_session)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  // Seen in the first run and again in tonight's suite — a known defect.
  finding.run(1, "F-001", "Cart badge does not update", "high", "http_5xx", "high",
    "shop.test/inventory.html", "2026-09-20T10:05:00+02:00", "fp-badge", 1);
  finding.run(3, "F-001", "Cart badge does not update", "high", "regression", "high",
    "shop.test/inventory.html", "2026-09-24T03:00:09+02:00", "fp-badge", 1);
  // First sighted tonight — new.
  finding.run(3, "F-002", "Checkout form accepts an empty postcode", "medium", "llm_judgment",
    "low", "shop.test/cart.html", "2026-09-24T03:00:11+02:00", "fp-postcode", 3);

  return db;
}

function render(dir: string, db: MemoryDb): string {
  return renderDashboard({
    db,
    dir,
    outDir: dir,
    projectName: "shop",
    baseUrl: "https://shop.test",
    now: "2026-10-04T12:00:00+02:00",
  });
}

describe("magpie dashboard (P5-T1)", () => {
  it("renders every section from a project's memory", () => {
    const dir = projectDir();
    const html = render(dir, fixture(dir));

    for (const needle of [
      "shop",
      "https://shop.test",
      "<h2>Coverage</h2>",
      // 2 visited + 1 on the frontier.
      "<strong>3</strong>",
      "<strong>2</strong> of 4 seen",
      "add-cheapest-item",
      'class="chip flow-verified">verified',
      'class="chip flow-broken">broken',
      "fail@3",
      "Cart badge does not update",
      "Checkout form accepts an empty postcode",
      "oracle-regression",
      '<span class="mode explore">explore</span>',
      '<span class="mode regress">regress</span>',
      '<span class="mode charter">charter</span>',
      "Magpie v",
    ]) {
      expect(html, needle).toContain(needle);
    }

    // The flow healed once says so; the two that never were say nothing.
    expect(html).toContain("1×");
    // New leads, known follows — a reader with thirty seconds sees tonight first.
    expect(html).toContain("New in the latest run (1)");
    expect(html).toContain("Known defects (1)");
    expect(html.indexOf("New in the latest run")).toBeLessThan(html.indexOf("Known defects"));
    // Two sightings of one defect are one card, not two.
    expect(html.match(/Cart badge does not update/g)).toHaveLength(1);
    expect(html).toContain("seen 2×");
  });

  it("links to report folders relatively, and never with an absolute path", () => {
    const dir = projectDir();
    const html = render(dir, fixture(dir));

    expect(html).toContain(`href="reports/${S1}/index.html"`);
    expect(html).toContain(`href="reports/${S3}/index.html"`);
    expect(html).not.toContain(dir);
    expect(html).not.toContain(os.tmpdir());
    expect(html).not.toMatch(/(href|src)="(\/|file:|[A-Za-z]:\\)/);
    // Offline and self-contained, exactly like a run report.
    expect(html).not.toMatch(/<(script|link)\b/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\//i);
  });

  it("shows a report folder outside the project as text rather than a broken link", () => {
    const dir = projectDir();
    const db = fixture(dir);
    db.prepare("UPDATE sessions SET report_dir = ? WHERE id = 2").run(
      path.join(os.tmpdir(), "somewhere-else", "2026-09-22_09-30-00"),
    );
    const html = render(dir, db);
    expect(html).toContain("2026-09-22_09-30-00</span>");
    expect(html).not.toContain(os.tmpdir());
  });

  it("greets an empty project instead of crashing", () => {
    const dir = projectDir();
    const db = openEphemeralDb();
    const html = render(dir, db);

    expect(html).toContain("Nothing remembered yet");
    expect(html).toContain("magpie run --explore");
    expect(html).not.toContain("<h2>Coverage</h2>");
    expect(html).toContain("<!doctype html>");
  });

  it("writes the file where it was asked to", () => {
    const dir = projectDir();
    const out = path.join(dir, DASHBOARD_FILENAME);
    const written = writeDashboard(
      { db: fixture(dir), dir, projectName: "shop", baseUrl: "https://shop.test" },
      out,
    );
    expect(written).toBe(out);
    expect(fs.readFileSync(out, "utf8")).toContain("<!doctype html>");
  });
});

describe("session mode", () => {
  it("reads the kind of run back out of what was stored", () => {
    expect(sessionMode({ status: "REGRESSION", charter: "regression: all" })).toBe("regress");
    expect(sessionMode({ status: "COMPLETED", charter: EXPLORE_CHARTER })).toBe("explore");
    expect(sessionMode({ status: "COMPLETED", charter: "Log in" })).toBe("charter");
    expect(sessionMode({ status: "BUDGET_EXHAUSTED", charter: null })).toBe("charter");
  });
});
