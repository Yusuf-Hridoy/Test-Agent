import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { slug } from "../util.js";

/** Numbered, slugged screenshots: shots/007_add-to-cart.png */
export class ShotTaker {
  private n = 0;

  constructor(private readonly reportDir: string) {
    fs.mkdirSync(path.join(reportDir, "shots"), { recursive: true });
  }

  /** Returns the path relative to the report dir, or undefined if it failed. */
  async capture(page: Page, label: string): Promise<string | undefined> {
    const name = `${String(++this.n).padStart(3, "0")}_${slug(label)}.png`;
    const rel = path.join("shots", name);
    try {
      await page.screenshot({ path: path.join(this.reportDir, rel), timeout: 10_000 });
      return rel;
    } catch {
      // A crashed or navigating page cannot be photographed; evidence goes on.
      return undefined;
    }
  }

  /** Base64 PNG for the model's `look` tool — never written to disk twice. */
  async captureBase64(page: Page): Promise<string | undefined> {
    try {
      const buf = await page.screenshot({ timeout: 10_000 });
      return buf.toString("base64");
    } catch {
      return undefined;
    }
  }

  absolute(relPath: string): string {
    return path.join(this.reportDir, relPath);
  }
}
