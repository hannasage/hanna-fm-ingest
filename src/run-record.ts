import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError, type FailureKind } from "./files.ts";
import type { PollCounts } from "./poll.ts";
import { CLOCK_SKEW_TOLERANCE_MS, POLLER_RUNS_KEEP_DAYS, RECORD_TIMEOUT_MS } from "./settings.ts";

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

/**
 * A failure that stopped the poll. A UserError names its kind, or `other` when it names none (a last resort).
 * Anything that is not a UserError is a `bug`: the poller did not plan for it. Its text is never read.
 */
export function failureKindOf(error: unknown): FailureKind {
  if (!(error instanceof UserError)) return "bug";
  return error.kind ?? "other";
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
    if (!(await pruneOldRuns(client, Date.now()))) warn(PRUNE_WARNING);
  } catch {
    warn(PRUNE_WARNING);
  }
}

/** One id and finish time read from poller_runs. */
type RunMark = { id: number; finished_at: string };

function isRunMark(value: unknown): value is RunMark {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "finished_at" in value &&
    typeof value.finished_at === "string"
  );
}

/** The newest row by finish time (then by id), optionally of one outcome. Null when there is none. Throws on a database error. */
async function newestRun(client: SupabaseClient, outcome: "ok" | "failed" | null): Promise<RunMark | null> {
  let query = client.from("poller_runs").select("id, finished_at");
  if (outcome !== null) query = query.eq("outcome", outcome);
  const { data, error } = await query
    .order("finished_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .abortSignal(AbortSignal.timeout(RECORD_TIMEOUT_MS));
  if (error) throw new Error("read refused");
  const rows: unknown[] = data ?? [];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isRunMark(row)) throw new Error("unreadable row");
  return row;
}

/**
 * Deletes the records older than POLLER_RUNS_KEEP_DAYS, with two exceptions.
 * - The newest ok row and the newest failed row stay however old they are, so a long outage
 *   still leaves the site its last success and last failure.
 * - When `nowMs` is more than CLOCK_SKEW_TOLERANCE_MS behind the newest row's finish time, nothing is deleted:
 *   the runner's clock is suspect, and a cutoff from it could be wrong.
 * Returns false when a database call failed, so the caller can warn.
 */
export async function pruneOldRuns(client: SupabaseClient, nowMs: number): Promise<boolean> {
  try {
    const newest = await newestRun(client, null);
    if (newest === null) return true;
    if (nowMs < Date.parse(newest.finished_at) - CLOCK_SKEW_TOLERANCE_MS) return true;

    const keep: number[] = [];
    for (const outcome of ["ok", "failed"] as const) {
      const row = await newestRun(client, outcome);
      if (row !== null) keep.push(row.id);
    }

    const cutoff = new Date(nowMs - POLLER_RUNS_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let query = client.from("poller_runs").delete().lt("finished_at", cutoff);
    if (keep.length > 0) query = query.not("id", "in", `(${keep.join(",")})`);
    const { error } = await query.abortSignal(AbortSignal.timeout(RECORD_TIMEOUT_MS));
    return !error;
  } catch {
    return false;
  }
}
