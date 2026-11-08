// Pressure model for rules v3. Pressure P(x) is a non-decreasing function of distance x (metres),
// given as config control points, linear between points and extrapolated past the last one with the
// last segment's slope, so it never flattens. Everything here is integer arithmetic.

export type PressurePoints = readonly (readonly [number, number])[];

/** Provisional control points (config sim.pressure, pinned per flight). */
export const DEFAULT_PRESSURE: PressurePoints = [
  [0, 0],
  [1000, 100],
  [2000, 200],
  [4000, 360],
  [7000, 540],
  [12000, 760],
  [20000, 1000],
  [35000, 1300],
  [60000, 1700],
];

/** Throws unless the points start at 0 m, increase in distance and never decrease in pressure. */
export function validatePressure(points: PressurePoints): void {
  if (points.length < 2) throw new Error('pressure: need at least two control points');
  const first = points[0]!;
  if (first[0] !== 0) throw new Error('pressure: first point must be at 0 m');
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (!(b[0] > a[0])) throw new Error('pressure: distances must increase');
    if (b[1] < a[1]) throw new Error('pressure: pressure must not decrease');
    if (!Number.isInteger(b[0]) || !Number.isInteger(b[1])) throw new Error('pressure: integers only');
  }
  const last = points[points.length - 1]!, prev = points[points.length - 2]!;
  if (last[1] <= prev[1]) throw new Error('pressure: the last segment must rise, so pressure never flattens');
}

/** P at a distance in whole metres. */
export function pressureAt(points: PressurePoints, metres: number): number {
  const m = metres < 0 ? 0 : metres;
  let i = 1;
  while (i < points.length - 1 && points[i]![0] <= m) i++;
  const a = points[i - 1]!, b = points[i]!;
  return a[1] + (((m - a[0]) * (b[1] - a[1])) / (b[0] - a[0]) | 0);
}
