// Route catalogue. A route is the river's shape: a seed for the public route RNG plus 48 half-hour
// wheel buckets. Rules decide the difficulty; the wheel data only shapes the river (busy half-hours
// become tight canyons with fewer enemies and Block Crates). Same construction as the prototype.
import data from './wheel-days.json' with { type: 'json' };
import { hashStr, type RouteV3 } from '@sqk/sim/v3';

export type RouteKind = 'genesis' | 'daily' | 'lab';
export interface RouteInfo {
  readonly id: string;
  readonly kind: RouteKind;
  readonly date: string | null;
  readonly label: string;
  readonly route: RouteV3;
  /** Raw wheel work per bucket in flight order (null = no observation), for HUD and sparklines. */
  readonly raw: readonly (number | null)[];
  /** UTC clock label of each bucket in flight order. */
  readonly clock: readonly string[];
  /** Scheduled Dailies: the Squeekchain day the wheel data comes from, and whether it is a fallback clone. */
  readonly sourceDate?: string | null;
  readonly fallback?: boolean;
}

export const GENESIS_DATE = '2026-10-26';
const DAYS = (data as { days: Record<string, (number | null)[]> }).days;

/** Flight order: a 24-hour wheel cycle starting at 20:00 UTC, so the evening run comes early. */
export const ORDER: readonly number[] = [...Array.from({ length: 8 }, (_, i) => 40 + i), ...Array.from({ length: 40 }, (_, i) => i)];
const clockOf = (ci: number) => { const m = ci * 30; return String((m / 60) | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

function build(id: string, kind: RouteKind, date: string | null, label: string, seed: number, buckets: readonly (number | null)[] | null): RouteInfo {
  const w: number[] = [], raw: (number | null)[] = [], clock: string[] = [];
  for (let i = 0; i < 48; i++) {
    const ci = ORDER[i]!;
    clock.push(clockOf(ci));
    if (!buckets) { w.push(500); raw.push(null); continue; }
    const v = buckets[ci] ?? null;
    raw.push(v);
    w.push(v === null ? -1 : Math.min(1000, Math.round((v * 1000) / 1600)));
  }
  return { id, kind, date, label, route: { id, seed: seed >>> 0, w, crates: kind !== 'lab' }, raw, clock };
}

export function genesis(): RouteInfo { return build('genesis', 'genesis', GENESIS_DATE, 'Genesis Route', 0x26102026, DAYS[GENESIS_DATE] ?? null); }
export function neutral(): RouteInfo { return build('neutral', 'lab', null, 'Neutral River', 0x5eed0001, null); }
export function daily(date: string): RouteInfo | null {
  const b = DAYS[date];
  if (!b || date === GENESIS_DATE) return null;
  return build('d' + date, 'daily', date, 'Daily · ' + date, hashStr('daily:' + date), b);
}
export function wheelDays(): string[] { return Object.keys(DAYS).sort(); }
export function allRoutes(): RouteInfo[] {
  const out = [genesis()];
  for (const d of wheelDays().reverse()) { const r = daily(d); if (r) out.push(r); }
  out.push(neutral());
  return out;
}
export function routeById(id: string): RouteInfo | null { return allRoutes().find((r) => r.id === id) ?? null; }

/**
 * The current Daily: the newest published Daily route dated on or before `now` (UTC). Box streams
 * run only on it. A new day's route is published once that day's wheel data is in.
 */
export function currentDaily(now: Date): RouteInfo | null {
  const today = now.toISOString().slice(0, 10);
  const d = wheelDays().filter((x) => x <= today && x !== GENESIS_DATE).pop();
  return d ? daily(d) : null;
}

/** A Daily route from the schedule (telemetry or a fallback clone); buckets in clock order of its source day. */
export function dailyFromSchedule(s: { gameDate: string; routeId: string; seed: number; buckets: readonly (number | null)[]; sourceDate: string; kind: 'telemetry' | 'fallback' }): RouteInfo {
  return { ...build(s.routeId, 'daily', s.gameDate, `Daily · ${s.gameDate}`, s.seed, s.buckets), sourceDate: s.sourceDate, fallback: s.kind === 'fallback' };
}

/** The newest real wheel day shipped with the code: the pipeline's last resort before any route is scheduled. */
export function latestRecordedDay(): { date: string; buckets: readonly (number | null)[]; source: string } {
  const d = wheelDays().filter((x) => x !== GENESIS_DATE).pop()!;
  return { date: d, buckets: DAYS[d]!, source: (data as { source: string }).source };
}
