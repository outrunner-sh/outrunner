import type { LineCounts, LineDelta } from "@/lib/review/line-kinds";

/** Unknown counts stay unknown; partial totals are labelled by the caller. */
export function totalLines(counts: LineCounts | null): LineDelta | null {
  if (!counts) return null;
  return Object.values(counts).reduce(
    (sum, delta) => ({
      additions: sum.additions + delta.additions,
      deletions: sum.deletions + delta.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

const COMPACT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const compactCount = (count: number): string => COMPACT.format(count);
