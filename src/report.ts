import { DROP_REASONS, type DropReason } from "./parse.ts";
import { totalSkipped, type PollCounts } from "./poll.ts";
import { POLL_SKIP_REASONS } from "./poll-mapping.ts";

export type Counts = {
  read: number;
  imported: number;
  duplicate: number;
  dropped: Record<DropReason, number>;
};

export function emptyCounts(): Counts {
  return {
    read: 0,
    imported: 0,
    duplicate: 0,
    dropped: Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>,
  };
}

function totalDropped(counts: Counts): number {
  return DROP_REASONS.reduce((sum, reason) => sum + counts.dropped[reason], 0);
}

/** Rows read that no other count holds. It is 0 after a full run, and more after a failure. */
export function notAttempted(counts: Counts): number {
  return counts.read - counts.imported - counts.duplicate - totalDropped(counts);
}

/**
 * Counts only. No row content ever goes in this text.
 * `read` always equals imported + duplicate + dropped + not_attempted.
 * A partial report, from a run that failed, ends with `partial: true`.
 */
export function formatReport(counts: Counts, options: { partial?: boolean } = {}): string {
  const dropped = totalDropped(counts);
  return [
    `read: ${counts.read}`,
    `imported: ${counts.imported}`,
    `duplicate: ${counts.duplicate}`,
    `dropped: ${dropped}`,
    ...DROP_REASONS.map((reason) => `  ${reason}: ${counts.dropped[reason]}`),
    `not_attempted: ${notAttempted(counts)}`,
    ...(options.partial ? ["partial: true"] : []),
    "",
  ].join("\n");
}

/**
 * Counts only, for the poll. No track, artist or album name ever goes in this text.
 * `fetched` always equals stored + duplicate + skipped, and `duplicate` equals its two parts.
 * `possible_gap: true` is printed only when the poll stopped short of older plays.
 */
export function formatPollReport(counts: PollCounts): string {
  return [
    `fetched: ${counts.fetched}`,
    `stored: ${counts.stored}`,
    `duplicate: ${counts.duplicateExport + counts.duplicateExact}`,
    `  duplicate_export: ${counts.duplicateExport}`,
    `  duplicate_exact: ${counts.duplicateExact}`,
    `skipped: ${totalSkipped(counts)}`,
    ...POLL_SKIP_REASONS.map((reason) => `  ${reason}: ${counts.skipped[reason]}`),
    ...(counts.gap === null ? [] : ["possible_gap: true"]),
    "",
  ].join("\n");
}
