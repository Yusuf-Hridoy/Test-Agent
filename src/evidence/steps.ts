import fs from "node:fs";
import path from "node:path";
import type { StepRecord } from "../types.js";
import { isoNow } from "../util.js";
import type { SecretStore } from "../model/redact.js";

/**
 * Hard Rule 5: every step is appended as it happens, so a crash still leaves a
 * readable trail. One JSON object per line, flushed immediately.
 */
export class StepLog {
  private n = 0;
  private readonly fd: number;
  readonly steps: StepRecord[] = [];

  constructor(
    private readonly file: string,
    private readonly secrets: SecretStore,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "a");
  }

  append(step: Omit<StepRecord, "n" | "t">): StepRecord {
    const record: StepRecord = {
      n: ++this.n,
      t: isoNow(),
      ...step,
      args: this.scrub(step.args),
      result: {
        ok: step.result.ok,
        ...(step.result.detail ? { detail: this.secrets.redact(step.result.detail) } : {}),
      },
    };
    this.steps.push(record);
    fs.writeSync(this.fd, `${JSON.stringify(record)}\n`);
    return record;
  }

  /** Redact string leaves of the arg object before it touches the disk. */
  private scrub(args: unknown): unknown {
    if (typeof args === "string") return this.secrets.redact(args);
    if (Array.isArray(args)) return args.map((a) => this.scrub(a));
    if (args && typeof args === "object") {
      return Object.fromEntries(
        Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, this.scrub(v)]),
      );
    }
    return args;
  }

  get count(): number {
    return this.n;
  }

  /** The most recent step numbers, as a fallback repro trail. */
  recent(n: number): number[] {
    return this.steps.slice(-n).map((s) => s.n);
  }

  /** Steps recorded for one objective, for a finding's repro block. */
  sliceFor(stepNumbers: number[]): StepRecord[] {
    return this.steps.filter((s) => stepNumbers.includes(s.n));
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  get path(): string {
    return this.file;
  }
}
