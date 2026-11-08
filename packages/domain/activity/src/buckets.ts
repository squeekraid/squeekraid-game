// Wheel data -> route input. The Daily route for game date G is built from the Squeekchain day that
// ran G-2 12:00 UTC to G-1 12:00 UTC (days are named by their starting noon): its 48 half-hour
// buckets of wheel work, from /v1/measurement/stats.
import type { StatsV1 } from './api.ts';

/** Share of the 48 buckets that must be observed (complete or partial) before a day becomes a route. */
export const MIN_COVERAGE = 0.75;

/**
 * 48 buckets in clock order (index i = startMinuteUtc 30 i) of the Squeekchain day `sourceDate`.
 * Complete and partial buckets carry their work; missing and future ones are null.
 */
export function bucketsOf(stats: StatsV1, sourceDate: string): { buckets: (number | null)[]; coverage: number } | null {
  const day = stats.activity.days.find((d) => d.date === sourceDate);
  if (!day) return null;
  const buckets: (number | null)[] = new Array(48).fill(null);
  for (const b of day.buckets) {
    const i = Math.floor(b.startMinuteUtc / 30);
    if (i < 0 || i > 47) continue;
    if ((b.coverage === 'complete' || b.coverage === 'partial') && b.workUnits !== null && b.workUnits !== undefined) buckets[i] = Number(b.workUnits);
  }
  return { buckets, coverage: buckets.filter((v) => v !== null).length / 48 };
}

