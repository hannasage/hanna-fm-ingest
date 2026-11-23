import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError, type FailureKind } from "./files.ts";
import type { PollCounts } from "./poll.ts";
import { POLLER_RUNS_KEEP_DAYS, RECORD_TIMEOUT_MS } from "./settings.ts";

/** The fixed lines for a record that could not be written. Neither holds a detail, so neither can hold a secret. */
export const RECORD_WARNING = "::warning::could not record the poll run";
export const PRUNE_WARNING = "::warning::could not delete old poll run records";

/** What one poll run leaves in the poller_runs table. Counts are null when the run never read a page. */
export type RunRecord = {
  startedAt: Date;
  finishedAt: Date;
  outcome: "ok" | "failed";
  fetched: number | null;
  stored: number | null;
  failureKind: FailureKind | null;
};

/** A failure that stopped the poll. A UserError names its kind. Anything else is `other`, and its text is never read. */
export function failureKindOf(error: unknown): FailureKind {
  return error instanceof UserError && error.kind !== undefined ? error.kind : "other";
}

/**
 * The record of a run that finished. `kind` is why it must still exit 1, or null when it is green.
 * The counts are the poll's own.
 */
export function finishedRecord(startedAt: Date, counts: PollCounts, kind: FailureKind | null): RunRecord {
  return {
    startedAt,
    finishedAt: finishTime(startedAt),
    outcome: kind === null ? "ok" : "failed",
    fetched: counts.fetched,
    stored: counts.stored,
    failureKind: kind,
  };
}

/**
 * The record of a run that stopped on an error. The counts are kept only when the poll had read its pages,
 * because `fetched` is set after the last page. Before that, "none fetched" and "not known" look the same, so it is null.
 */
export function stoppedRecord(startedAt: Date, counts: PollCounts, error: unknown): RunRecord {
  const read = counts.fetched > 0;
  return {
    startedAt,
    finishedAt: finishTime(startedAt),
    outcome: "failed",
    fetched: read ? counts.fetched : null,
    stored: read ? counts.stored : null,
    failureKind: failureKindOf(error),
  };
}

/** Now, but never before the start, so a clock that stepped back cannot break the table's check. */
function finishTime(startedAt: Date): Date {
  const now = new Date();
  return now.getTime() < startedAt.getTime() ? startedAt : now;
}

/**
 * Writes the run record, then deletes the records older than POLLER_RUNS_KEEP_DAYS.
 * It never throws and never changes the run's result. A failure prints one fixed warning line and nothing else:
 * the database's own message could quote a row or the address.
 * When the record could not be written the delete is skipped, because the database is not answering.
 */
export async function recordRun(client: SupabaseClient, record: RunRecord, warn: (line: string) => void): Promise<void> {
  try {
    const { error } = await client
      .from("poller_runs")
      .insert({
        started_at: record.startedAt.toISOString(),
        finished_at: record.finishedAt.toISOString(),
        outcome: record.outcome,
        fetched: record.fetched,
        stored: record.stored,
        failure_kind: record.failureKind,
      })
      .abortSignal(AbortSignal.timeout(RECORD_TIMEOUT_MS));
    if (error) {
      warn(RECORD_WARNING);
      return;
    }
  } catch {
    warn(RECORD_WARNING);
    return;
  }

  try {
    const cutoff = new Date(Date.now() - POLLER_RUNS_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await client
      .from("poller_runs")
      .delete()
      .lt("finished_at", cutoff)
      .abortSignal(AbortSignal.timeout(RECORD_TIMEOUT_MS));
    if (error) warn(PRUNE_WARNING);
  } catch {
    warn(PRUNE_WARNING);
  }
}
