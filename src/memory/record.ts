import type { MagpieConfig, SessionResult, Snapshot } from "../types.js";
import type { SecretStore } from "../model/redact.js";
import { closeDb, openMemoryDb, type MemoryDb } from "./db.js";
import { ingestSession } from "./ingest.js";
import { buildMemoryContext } from "./context.js";

export interface RecordArgs {
  dir: string;
  result: SessionResult;
  reportDir: string;
  secrets: SecretStore;
  snapshots: Map<string, Snapshot>;
  /** Scope rules, so a linked page can be judged in or out of the app. */
  cfg?: MagpieConfig;
  narrate?: (line: string) => void;
  observe?: (type: string, detail: string) => void;
}

/**
 * Fold a finished session into project memory.
 *
 * Deliberately swallows every failure: a corrupt or locked database is a
 * memory problem, and a session that found real defects must still produce its
 * report. The failure is recorded as an observation so it shows up in the run
 * rather than disappearing.
 */
export function ingestIntoMemory(args: RecordArgs): void {
  let db: MemoryDb | undefined;
  try {
    db = openMemoryDb(args.dir);
    const summary = ingestSession(db, args.result, args.reportDir, {
      secrets: args.secrets,
      snapshots: args.snapshots,
      ...(args.cfg ? { cfg: args.cfg } : {}),
    });
    if (summary.alreadyIngested) return;
    args.result.coverage = summary.coverage;

    // Tell the report what memory knows: which of these defects are actually
    // new tonight, and which have been sitting there for a week.
    for (const verdict of summary.verdicts) {
      const finding = args.result.findings.find((f) => f.id === verdict.fid);
      if (!finding) continue;
      finding.memory = {
        status: verdict.status,
        seenCount: verdict.seenCount,
        ...(verdict.firstSeenAt ? { firstSeenAt: verdict.firstSeenAt } : {}),
      };
    }
    args.narrate?.(
      `memory: ${summary.pages} page(s), ${summary.transitions} transition(s), ` +
        `${summary.flowsCreated.length} new flow(s)` +
        (summary.flowsSkipped.length ? `, ${summary.flowsSkipped.length} already known` : "") +
        (summary.raised.length ? `, ${summary.raised.length} finding(s) raised from history` : ""),
    );
  } catch (err) {
    args.observe?.("memory_ingest_failed", `could not write project memory: ${(err as Error).message}`);
    args.narrate?.(`memory: not updated (${(err as Error).message})`);
  } finally {
    closeDb(db);
  }
}

/**
 * The app briefing handed to the planner, or undefined when this project has no
 * memory yet. Failures are silent by design: an unreadable database must cost a
 * session its memory, never its run.
 */
export function readMemoryContext(dir: string, charter: string): string | undefined {
  let db: MemoryDb | undefined;
  try {
    db = openMemoryDb(dir);
    return buildMemoryContext(db, charter);
  } catch {
    return undefined;
  } finally {
    closeDb(db);
  }
}
