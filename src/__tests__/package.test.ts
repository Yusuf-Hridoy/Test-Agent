import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAGPIE_VERSION } from "../version.js";

/**
 * What ships, and what it calls itself.
 *
 * `magpie --version` is the first thing a bug report quotes, so a version that
 * drifts from package.json makes every report slightly wrong. The `files`
 * whitelist is the other half: a published package must carry the runtime and
 * nothing else — fixtures, the fake app and the test suite stay at home.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
};

describe("package metadata (P5-T2)", () => {
  it("reports the version it was published as", () => {
    expect(MAGPIE_VERSION).toBe(pkg.version);
  });

  it("ships the runtime and nothing else", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("templates");
    // Source maps point at src/, which does not ship: they would only ever
    // resolve to nothing on a user's machine.
    expect(pkg.files).toContain("!dist/**/*.map");
    for (const unwanted of ["src", "scripts", "test-projects", "docs"]) {
      expect(pkg.files).not.toContain(unwanted);
    }
  });

  it("points `magpie` at a built entrypoint that carries a shebang", () => {
    const bin = pkg.bin["magpie"];
    expect(bin).toBe("dist/cli/index.js");
    // The CLI is built from this source, so the shebang has to be in the source.
    const src = fs.readFileSync(path.join(ROOT, "src", "cli", "index.ts"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("builds and tests before it can be published", () => {
    expect(pkg.scripts["prepublishOnly"]).toContain("build");
    expect(pkg.scripts["prepublishOnly"]).toContain("test");
    expect(pkg.engines.node).toBe(">=20");
  });

  it("does not install browsers on npm install", () => {
    // Playwright's browsers are a 300MB side effect; `npx playwright install
    // chromium` is a documented manual step instead (README).
    for (const hook of ["postinstall", "preinstall", "install"]) {
      expect(pkg.scripts[hook]).toBeUndefined();
    }
  });
});
