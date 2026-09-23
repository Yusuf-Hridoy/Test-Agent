import { createHash } from "node:crypto";
import type { Snapshot } from "../types.js";

const WINDOW = 6;
const SAME_IN_WINDOW = 3;
const CONSECUTIVE = 5;
const STUCK_BEFORE_FORCED_BLOCK = 2;

/**
 * sha1(url + element ids/names/values) — identity of "where the agent is
 * standing". Values are part of it because filling a form changes nothing about
 * the page's shape: without them, typing into three different fields looks like
 * standing still and the harness force-blocks a perfectly good objective.
 * Password values never reach the snapshot, so they cannot reach this either.
 */
export function fingerprint(snap: Snapshot): string {
  const shape = snap.elements.map((e) => `${e.id}:${e.name}:${e.value ?? ""}`).join("|");
  return createHash("sha1").update(`${snap.url}\n${shape}`).digest("hex").slice(0, 16);
}

export type LoopVerdict = "ok" | "stuck";

/**
 * Detects the agent going in circles. Fingerprints are computed AFTER an action
 * so the detector sees the action's effect (brief §3).
 */
export class LoopDetector {
  private recent: string[] = [];
  private readonly stuckByObjective = new Map<string, number>();

  onFingerprint(fp: string, objectiveId?: string): LoopVerdict {
    this.recent.push(fp);
    if (this.recent.length > WINDOW) this.recent.shift();

    const sameInWindow = this.recent.filter((f) => f === fp).length;
    let consecutive = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i] === fp; i--) consecutive++;

    if (sameInWindow >= SAME_IN_WINDOW || consecutive >= CONSECUTIVE) {
      this.noteStuck(objectiveId);
      this.recent = []; // start a fresh window, so one loop is reported once
      return "stuck";
    }
    return "ok";
  }

  /** Also called for non-fingerprint stalls, e.g. two plain-text replies in a row. */
  noteStuck(objectiveId?: string): void {
    if (!objectiveId) return;
    this.stuckByObjective.set(objectiveId, (this.stuckByObjective.get(objectiveId) ?? 0) + 1);
  }

  stuckCount(objectiveId: string): number {
    return this.stuckByObjective.get(objectiveId) ?? 0;
  }

  /** After repeated stuck verdicts the harness blocks the objective itself. */
  shouldForceBlock(objectiveId: string): boolean {
    return this.stuckCount(objectiveId) >= STUCK_BEFORE_FORCED_BLOCK;
  }

  /** Called when the agent moves on, so a new objective starts clean. */
  reset(): void {
    this.recent = [];
  }
}
