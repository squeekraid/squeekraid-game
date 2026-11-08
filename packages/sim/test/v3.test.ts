import { describe, expect, it } from 'vitest';
import * as S from '../src/v3/index.ts';

const W48 = Array.from({ length: 48 }, (_, i) => (i % 7 < 3 ? 600 : i % 11 === 0 ? -1 : 0));
const ROUTES: S.RouteV3[] = [
  { id: 'a', seed: 0x26102026, w: W48, crates: true },
  { id: 'b', seed: 12345, w: Array(48).fill(0), crates: true },
  { id: 'c', seed: 0x5eed0001, w: Array(48).fill(500), crates: false },
  { id: 'd', seed: 777, w: Array(48).fill(1000), crates: true },
];

/** A cheap deterministic pilot: follows the lane, seeks depots when low, fires unless a depot is in line. */
function pilot(s: S.StateV3): number {
  const py = s.camY + S.PLAYER_SY * S.U;
  let target = S.laneAt(s, S.distanceRows(s) + 8) * S.U;
  let m: number = S.IN.FIRE;
  for (const e of s.ents) {
    if (e.k !== S.K.FUEL || e.y < py) continue;
    if (e.y - py < 300 * S.U && s.fuel < 4500) target = e.x;
    if (e.y - py < 260 * S.U && Math.abs(e.x - s.px) < 16 * S.U) m = 0;
  }
  if (s.px < target - 20) m |= S.IN.R; else if (s.px > target + 20) m |= S.IN.L;
  return m;
}
function fly(route: S.RouteV3, params: S.FlightParamsV3, frames: number, gearAt: Record<number, number> = {}): { s: S.StateV3; log: S.FlightLogV3 } {
  const s = S.create(route, params);
  const rec = new S.LogRecorder();
  let seq = 0;
  while (!s.dead && s.frame < frames) {
    const m = pilot(s);
    const g = gearAt[s.frame];
    rec.mask(s.frame, m);
    if (g !== undefined) rec.gearEdge(s.frame, g, seq++);
    S.step(s, m, g === undefined ? 0 : 1 << g);
  }
  return { s, log: rec.log() };
}

describe('rules v3: determinism and replay', () => {
  it('replays a recorded flight to the same frame, hash and cause', () => {
    for (const r of ROUTES) {
      const { s, log } = fly(r, S.DEFAULT_PARAMS, 20_000);
      const res = S.replay(r, S.DEFAULT_PARAMS, log, 20_000);
      expect(res.frame).toBe(s.frame);
      expect(res.hash).toBe(s.hash);
      expect(res.cause).toBe(S.causeName(s));
    }
  });

  it('segments restored from canonical snapshots reach exactly the same state', () => {
    const params: S.FlightParamsV3 = { ...S.DEFAULT_PARAMS, loadout: ['shield', 'spread', 'seed'] };
    const { s, log } = fly(ROUTES[0]!, params, 15_000, { 400: 0, 900: 1, 1300: 2 });
    let cur = S.create(ROUTES[0]!, params);
    for (let to = 3600; ; to += 3600) {
      S.runTo(cur, log, Math.min(to, s.frame + 1));
      if (cur.dead || to > s.frame) break;
      const bytes = S.encodeState(cur);
      cur = S.decodeState(ROUTES[0]!, params, bytes);
      expect(S.encodeState(cur)).toEqual(bytes);
    }
    expect(cur.frame).toBe(s.frame);
    expect(cur.hash).toBe(s.hash);
    expect(S.encodeState(cur)).toEqual(S.encodeState(s));
  });

  it('refuses a snapshot whose loadout differs from the pinned params', () => {
    const a = S.create(ROUTES[0]!, { ...S.DEFAULT_PARAMS, loadout: ['shield', null, null] });
    expect(() => S.decodeState(ROUTES[0]!, S.DEFAULT_PARAMS, S.encodeState(a))).toThrow(/loadout/);
  });

  it('rejects malformed logs', () => {
    expect(() => S.validateLog({ inputs: [[5, 1], [4, 0]], gear: [], spawns: [] })).toThrow(S.LogError);
    expect(() => S.validateLog({ inputs: [[0, 9]], gear: [], spawns: [] })).toThrow(S.LogError);
    expect(() => S.validateLog({ inputs: [], gear: [[1, 3, 0]], spawns: [] })).toThrow(S.LogError);
    expect(() => S.validateLog({ inputs: [], gear: [[1, 0, 2], [5, 1, 2]], spawns: [] })).toThrow(/twice/);
  });
});

describe('rules v3: fairness rules that hold by construction (generator only, 200 km per route)', () => {
  const ROWS = 400_000; // 200 km
  for (const r of ROUTES) {
    it(`route ${r.id}: channel, edges, lane, depots, static obstacles, behaviour parameters`, () => {
      const s = S.create(r, S.DEFAULT_PARAMS);
      let prev: number[] | null = null;
      let minChannel = 999, minSide = 999, maxEdgeStep = 0, maxLaneStep = 0, laneViolations = 0;
      const depotRows: number[] = [];
      let staticOnLane = 0, jetWarnMin = 999, pincerGapMin = 999, trackerDelayMin = 999, trackerCapMax = 0, ents = 0;
      for (let row = 0; row < ROWS; row++) {
        const before = s.ents.length;
        S.generateTo(s, row);
        const [l, rr, il, ir, lane] = S.rowData(s, row);
        minChannel = Math.min(minChannel, rr - l);
        if (ir > il) minSide = Math.min(minSide, il - l, rr - ir);
        if (prev) {
          maxEdgeStep = Math.max(maxEdgeStep, Math.abs(l - prev[0]!), Math.abs(rr - prev[1]!));
          maxLaneStep = Math.max(maxLaneStep, Math.abs(lane - prev[4]!));
        }
        // the plane (half-width 5) fits on the lane with a pixel to spare
        const x0 = lane - 6, x1 = lane + 6;
        if (x0 < l || x1 > rr || (ir > il && x1 > il && x0 < ir)) laneViolations++;
        prev = [l, rr, il, ir, lane];
        for (let i = before; i < s.ents.length; i++) {
          const e = s.ents[i]!;
          ents++;
          const er = (e.y / S.ROW_U) | 0;
          if (e.k === S.K.FUEL) depotRows.push(er);
          const isStatic = e.k === S.K.ROCK || e.k === S.K.MINE || (e.k === S.K.BOAT && e.moving === 0);
          if (isStatic && Math.abs(((e.x / S.U) | 0) - S.laneAt(s, er)) < S.LANE_HW + e.hw) staticOnLane++;
          if (e.b === S.B.STRAFE) jetWarnMin = Math.min(jetWarnMin, e.a);
          if (e.b === S.B.PINCER) pincerGapMin = Math.min(pincerGapMin, ((2 * e.a) / S.U) | 0);
          if (e.b === S.B.TRACKER) { trackerDelayMin = Math.min(trackerDelayMin, e.a); trackerCapMax = Math.max(trackerCapMax, e.c); }
        }
        if ((row & 1023) === 0 && s.ents.length > 4000) s.ents.splice(0, s.ents.length - 400); // keep memory flat; ids stay monotonic
      }
      const gaps = depotRows.slice(1).map((v, i) => v - depotRows[i]!);
      expect(minChannel).toBeGreaterThanOrEqual(60);
      if (minSide < 999) expect(minSide).toBeGreaterThanOrEqual(30);
      expect(maxEdgeStep).toBeLessThanOrEqual(4); // px per 5 px row: 0.8 px/px at the steepest point; the plane steers 1.1 px/px
      expect(maxLaneStep).toBeLessThanOrEqual(5);
      expect(laneViolations).toBe(0);
      expect(depotRows[0]).toBeLessThanOrEqual(S.DEPOT_MAX_GAP_ROWS);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(S.DEPOT_MAX_GAP_ROWS);
      expect(staticOnLane).toBe(0);
      expect(jetWarnMin).toBeGreaterThanOrEqual(30);
      expect(pincerGapMin).toBeGreaterThanOrEqual(S.PINCER_MIN_GAP_PX);
      expect(trackerDelayMin).toBeGreaterThanOrEqual(S.MIN_REACTION_FRAMES);
      expect(trackerCapMax).toBeLessThan(S.STEER_MAX);
      expect(ents).toBeGreaterThan(10_000);
    }, 120_000);
  }
});

describe('rules v3: pressure keeps rising', () => {
  it('is non-decreasing, extrapolates past the last point, and every behaviour unlocks', () => {
    let last = -1;
    for (let m = 0; m <= 500_000; m += 250) {
      const p = S.pressureAt(S.DEFAULT_PRESSURE, m);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(S.pressureAt(S.DEFAULT_PRESSURE, 120_000)).toBeGreaterThan(S.pressureAt(S.DEFAULT_PRESSURE, 60_000));
    expect(S.windowBudget(S.pressureAt(S.DEFAULT_PRESSURE, 200_000))).toBeGreaterThan(S.windowBudget(S.pressureAt(S.DEFAULT_PRESSURE, 100_000)));
    for (const v of Object.values(S.BEHAVIOUR_UNLOCKS)) expect(S.pressureAt(S.DEFAULT_PRESSURE, 20_000)).toBeGreaterThanOrEqual(v);
    expect(() => S.validatePressure([[0, 0], [100, 50], [200, 50]])).toThrow(/never flattens/);
    expect(() => S.validatePressure([[0, 0], [100, 50], [200, 40]])).toThrow(/decrease/);
  });

  it('depot spacing approaches but never reaches the 337.5 m bound', () => {
    for (let P = 0; P < 100_000; P += 97) expect(S.depotSpacingRows(P)).toBeLessThan(S.DEPOT_MAX_GAP_ROWS - 60);
  });
});

describe('rules v3: Gear effects', () => {
  const route = ROUTES[1]!;
  it('seed tank adds fuel; spread fires three bullets; long barrel extends range', () => {
    const p: S.FlightParamsV3 = { ...S.DEFAULT_PARAMS, loadout: ['seed', 'spread', 'long'] };
    const s = S.create(route, p);
    for (let i = 0; i < 300; i++) S.step(s, 0);
    const f0 = s.fuel;
    S.step(s, 0, 1);
    expect(s.fuel).toBe(Math.min(S.FUEL_MAX, f0 + p.effects.seedFuel) - S.FUEL_DRAIN);
    S.step(s, S.IN.FIRE, 2);
    expect(s.bullets.length).toBe(3);
    S.step(s, 0, 4);
    expect(s.gear.long).toBe(p.effects.longFrames - 1); // the activation frame counts
    expect(s.gear.uses).toBe(3);
  });

  it('a shield absorbs one hit and grants grace; without it the same hit kills', () => {
    const run = (shield: boolean) => {
      const p: S.FlightParamsV3 = { ...S.DEFAULT_PARAMS, loadout: ['shield', null, null] };
      const s = S.create(route, p);
      for (let i = 0; i < 100; i++) S.step(s, 0);
      if (shield) S.step(s, 0, 1);
      // put a static boat right in the plane's path
      const py = s.camY + S.PLAYER_SY * S.U;
      s.ents.push({ id: s.nextId++, k: S.K.BOAT, b: S.B.PATROL, x: s.px, y: py + 30 * S.U, hw: 10, hh: 4, vx: 0, vy: 0, awake: 0, moving: 0, hp: 1, maxHp: 1, big: 0, t: 0, a: 0, c: 0, minX: 0, maxX: 0, gx: 0, drops: 0 });
      for (let i = 0; i < 40 && !s.dead; i++) S.step(s, 0);
      return s;
    };
    const without = run(false), withShield = run(true);
    expect(without.dead).toBe(1);
    expect(S.causeName(without)).toBe('boat');
    expect(withShield.dead).toBe(0);
    expect(withShield.gear.shield).toBe(0);
    expect(withShield.kills).toBeGreaterThanOrEqual(1);
  });

  it('a Gear edge for an empty slot does nothing', () => {
    const s = S.create(route, S.DEFAULT_PARAMS);
    S.step(s, 0, 7);
    expect(s.gear.uses).toBe(0);
  });
});

describe('rules v3: injected spawns are pickup-only', () => {
  it('bullets pass through, the plane collects it, and the event names the spawn', () => {
    const s = S.create(ROUTES[1]!, S.DEFAULT_PARAMS);
    for (let i = 0; i < 60; i++) S.step(s, 0);
    const row = S.distanceRows(s) + 20;
    S.inject(s, 4242, 1, (s.px / S.U) | 0, row);
    const seen: number[] = [];
    for (let i = 0; i < 80 && !s.dead; i++) { const ev = S.step(s, S.IN.FIRE) ?? []; for (const e of ev) if (e.t === 'pickup') seen.push(e.spawnId); }
    expect(seen).toEqual([4242]);
    expect(s.pickups).toBe(1);
  });
});
