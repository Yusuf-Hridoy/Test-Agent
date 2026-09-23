import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "../model/redact.js";

/**
 * Phase-2 seam. Nothing in Phase 1 reads this file; it exists so a passed
 * objective already records a replayable action sequence. Targets are role+name,
 * never snapshot ids, because ids are only valid within one session.
 */
export interface FlowAction {
  action: string;
  target?: { role: string; name: string };
  value?: string;
  url: string;
}

export interface DraftFlow {
  objectiveId: string;
  description: string;
  actions: FlowAction[];
}

export class FlowDrafter {
  private readonly flows: DraftFlow[] = [];
  private current: FlowAction[] = [];

  constructor(
    private readonly file: string,
    private readonly secrets: SecretStore,
  ) {}

  /** Record a successful browser action against the objective in progress. */
  record(action: FlowAction): void {
    this.current.push({
      ...action,
      ...(action.value !== undefined ? { value: this.secrets.redact(action.value) } : {}),
    });
  }

  /** Called when an objective passes; anything else discards the buffer. */
  commit(objectiveId: string, description: string): void {
    if (this.current.length) {
      this.flows.push({ objectiveId, description, actions: this.current });
      this.write();
    }
    this.current = [];
  }

  discard(): void {
    this.current = [];
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.flows, null, 2)}\n`);
  }

  /** Always leave a parseable file behind, even with no passed objectives. */
  finish(): void {
    this.write();
  }

  all(): DraftFlow[] {
    return this.flows;
  }
}
