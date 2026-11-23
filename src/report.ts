import { DROP_REASONS, type DropReason } from "./parse.ts";

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
    dropped: { podcast: 0, private_session: 0, malformed: 0 },
  };
}

/** Counts only. No row content ever goes in this text. */
export function formatReport(counts: Counts): string {
  const dropped = DROP_REASONS.reduce((sum, reason) => sum + counts.dropped[reason], 0);
  return [
    `read: ${counts.read}`,
    `imported: ${counts.imported}`,
    `duplicate: ${counts.duplicate}`,
    `dropped: ${dropped}`,
    ...DROP_REASONS.map((reason) => `  ${reason}: ${counts.dropped[reason]}`),
    "",
  ].join("\n");
}
