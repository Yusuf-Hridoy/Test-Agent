import type { Page } from "playwright";
import { truncate } from "../util.js";

export interface Drained {
  console: string[];
  network: string[];
  crashed: boolean;
}

/**
 * Passive evidence collectors. Attached once per page; the harness drains after
 * every action, so each finding carries only what that action produced.
 */
export class Collectors {
  private consoleErrors: string[] = [];
  private networkErrors: string[] = [];
  private crashed = false;
  /** Every failed request seen this session — attached to ENVIRONMENT_DOWN reports. */
  readonly allNetworkErrors: string[] = [];
  private recentServerErrors: string[] = [];

  constructor(page: Page) {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.pushConsole(`console.error: ${truncate(msg.text(), 500)}`);
    });
    page.on("pageerror", (err) => {
      this.pushConsole(`uncaught ${err.name}: ${truncate(err.message, 500)}`);
    });
    page.on("crash", () => {
      this.crashed = true;
      this.pushConsole("page crashed");
    });
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "failed";
      // net::ERR_ABORTED is normal for cancelled navigations and prefetches.
      if (failure.includes("ERR_ABORTED")) return;
      this.pushNetwork(`${req.method()} ${req.url()} → ${failure}`);
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      const type = res.request().resourceType();
      const isUserTriggered = type === "document" || type === "xhr" || type === "fetch";
      if (status >= 500) {
        this.pushNetwork(`${res.request().method()} ${res.url()} → ${status}`);
        this.recentServerErrors.push(res.url());
      } else if (isUserTriggered) {
        this.pushNetwork(`${res.request().method()} ${res.url()} → ${status}`);
      }
    });
  }

  private pushConsole(entry: string): void {
    this.consoleErrors.push(entry);
  }

  private pushNetwork(entry: string): void {
    this.networkErrors.push(entry);
    this.allNetworkErrors.push(entry);
  }

  /** Entries added since the previous drain. */
  drain(): Drained {
    const out: Drained = {
      console: this.consoleErrors,
      network: this.networkErrors,
      crashed: this.crashed,
    };
    this.consoleErrors = [];
    this.networkErrors = [];
    this.crashed = false;
    return out;
  }

  /** Distinct URLs that returned 5xx recently — envmon's outage signal. */
  serverErrorUrls(): string[] {
    return [...new Set(this.recentServerErrors)];
  }

  clearServerErrors(): void {
    this.recentServerErrors = [];
  }
}

export function isEmpty(d: Drained): boolean {
  return d.console.length === 0 && d.network.length === 0 && !d.crashed;
}
