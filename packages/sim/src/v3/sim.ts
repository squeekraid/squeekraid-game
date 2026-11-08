// ---------------------------------------------------------------------------------------------
// SqueekSim rules v3. Deterministic, integer-only, fixed 60 Hz step. The public route RNG
// (mulberry32) is used only by the generator; enemy behaviour reads only sim state, so the same
// route + params + input log give the same flight on every engine.
//
// Changes from v2 (packages/sim/src/v2, frozen):
//   - fixed cruise speed (45 sub-units/frame = 16.9 m/s); no throttle bits
//   - pressure P(x) replaces the saturating difficulty knobs and never flattens
//   - a threat director spends a per-100 m budget on behaviours that unlock with pressure
//   - deterministic enemy behaviours: tracker drones, pincer pairs, mine layers, strafing jets
//     with edge warnings, depot screens and combined waves
//   - seed depots are never more than 337.5 m apart (80% of the full-tank range) and a clean pass
//     refills almost the whole tank, so there is no fuel wall
//   - a reserved lane: no static obstacle is placed on it, so a reachable line always exists
//   - Gear effects (shield, spread, seed tank, long barrel) applied from logged activations
//   - injected reward spawns (pickup-only) from the input log
//   - entity ids from a monotonic counter; canonical state encoding in ./encode.ts
// ---------------------------------------------------------------------------------------------
import { DEFAULT_PRESSURE, pressureAt, validatePressure, type PressurePoints } from './pressure.ts';

export const RULES = 3;
export const W = 240, H = 400;
export const U = 16;
export const ROW_PX = 5, ROW_U = ROW_PX * U;
export const PX_PER_M = 10;
export const SEG_ROWS = 320, SEG_COUNT = 48;
export const STAGE_ROWS = 2000;
export const GATE_ROWS = 1000;
export const START_ROWS = 130;
export const PLAYER_SY = 80;
export const PLAYER_HW = 5, PLAYER_HH = 7;
export const SPEED = 45;
export const FUEL_MAX = 6000, FUEL_DRAIN = 4, FUEL_FILL = 450;
/** 80% of the cruise range on a full tank: 6000 / 4 frames x 45 su = 4218.75 px = 421.9 m. */
export const DEPOT_MAX_GAP_ROWS = 675;
export const STEER_MAX = 50, STEER_ACC = 12;
export const BULLET_REL = 120, FIRE_CD = 9;
export const BULLET_LIFE = 24, BULLET_LIFE_LONG = 34;
export const RING = 1024;
export const AHEAD_ROWS = 110;
export const WINDOW_ROWS = 200; // 100 m threat-budget window
export const LANE_HW = 14; // half-width of the reserved lane, px
export const HIST = 64; // plane-x history for reaction delays
export const JET_WARN_FRAMES = 36; // edge marker before a strafing jet enters (rule: >= 30)
export const MIN_REACTION_FRAMES = 18;
export const PINCER_MIN_GAP_PX = 28;

export const K = { BOAT: 1, DRONE: 2, JET: 3, ROCK: 4, MINE: 5, FUEL: 6, GATE: 7, CRATE: 8, PICKUP: 9 } as const;
export const KIND_NAME = ['', 'boat', 'drone', 'jet', 'rock', 'mine', 'fuel', 'gate', 'crate', 'pickup'] as const;
/** Behaviours. */
export const B = { NONE: 0, PATROL: 1, TRACKER: 2, PINCER: 3, LAYER: 4, STRAFE: 5, SCREEN: 6 } as const;
export const BEHAVIOUR_NAME = ['none', 'patrol', 'tracker', 'pincer', 'layer', 'strafe', 'screen'] as const;
const SIZE: readonly (readonly [number, number])[] = [[0, 0], [10, 4], [7, 5], [9, 4], [8, 5], [5, 5], [8, 13], [0, 5], [7, 7], [7, 7]];
export const IN = { L: 1, R: 2, FIRE: 4 } as const;
export const STAGES = ['Meadow Run', 'Dune Canyon', 'Frost Valley', 'Night Marsh', 'Ember Gorge'] as const;
export const CAUSES = ['', 'bank', 'boat', 'drone', 'jet', 'rock', 'mine', 'gate', 'fuel'] as const;
export type Cause = (typeof CAUSES)[number];

export type GearKind = 'shield' | 'spread' | 'seed' | 'long';
export const GEAR_KINDS: readonly GearKind[] = ['shield', 'spread', 'seed', 'long'];
export interface GearEffects {
  /** Hits a Bubble Shield absorbs. */
  readonly shieldCharges: number;
  /** Frames of invulnerability after the shield pops (to steer back to water). */
  readonly graceFrames: number;
  readonly spreadFrames: number;
  readonly seedFuel: number;
  readonly longFrames: number;
}
/** Provisional magnitudes (config gear.effects, pinned per flight). Playtests decide the numbers. */
export const DEFAULT_GEAR_EFFECTS: GearEffects = { shieldCharges: 1, graceFrames: 60, spreadFrames: 600, seedFuel: 3000, longFrames: 900 };

export interface RouteV3 {
  readonly id: string;
  readonly seed: number;
  /** 48 half-hour wheel buckets, 0..1000, or -1 for no data. */
  readonly w: ArrayLike<number>;
  readonly crates: boolean;
}
export interface FlightParamsV3 {
  /** Gear type in each of the three slots, or null. */
  readonly loadout: readonly (GearKind | null)[];
  readonly effects: GearEffects;
  readonly pressure: PressurePoints;
  /** Enemy AI tuning (config enemy.threats, pinned per flight); absent means DEFAULT_THREATS. */
  readonly threats?: ThreatTuning;
}
/** Pressure at which each threat kind (index 1..9: boat, drone, rock, mine, tracker, jet, pincer,
 *  layer, wave) joins the director's choices, and the per-window threat budget in percent. */
export interface ThreatTuning { readonly unlock: readonly number[]; readonly budgetPct: number }
export const DEFAULT_THREATS: ThreatTuning = { unlock: [0, 0, 0, 100, 300, 150, 250, 350, 420, 700], budgetPct: 100 };
/** Throws unless the tuning has an integer unlock for each of the 9 kinds (boat and drone at 0) and a budget of 50–200%. */
export function validateThreats(t: ThreatTuning): void {
  if (t.unlock.length !== 10 || t.unlock[0] !== 0 || t.unlock[1] !== 0 || t.unlock[2] !== 0) throw new Error('threats: 10 unlock entries, boats and drones unlocked from the start');
  for (const u of t.unlock) if (!Number.isInteger(u) || u < 0 || u > 5000) throw new Error('threats: unlocks are integers 0..5000');
  if (!Number.isInteger(t.budgetPct) || t.budgetPct < 50 || t.budgetPct > 200) throw new Error('threats: budget 50..200%');
}
export const DEFAULT_PARAMS: FlightParamsV3 = { loadout: [null, null, null], effects: DEFAULT_GEAR_EFFECTS, pressure: DEFAULT_PRESSURE };

export interface Ent {
  id: number; k: number; b: number;
  x: number; y: number; hw: number; hh: number;
  vx: number; vy: number;
  awake: number; moving: number; hp: number; maxHp: number; big: number;
  t: number; a: number; c: number; minX: number; maxX: number; gx: number; drops: number;
}
export interface Bullet { x: number; y: number; vx: number; life: number }
export interface Planned { row: number; kind: number; a: number; c: number; d: number }
export interface Zone { r0: number; r1: number; x0: number; x1: number }
export interface Gen {
  rng: number;
  r0: number; r1: number; c0: number; c1: number; h0: number; h1: number;
  islStart: number; islLen: number; islMax: number;
  lane: number;
  nextFuel: number; lastFuel: number; nextCrate: number; quietUntil: number;
  winRow: number;
  plan: Planned[];
  zones: Zone[];
}
export interface GearState { shield: number; grace: number; spread: number; long: number; uses: number }
export interface StateV3 {
  readonly rules: 3;
  readonly route: RouteV3;
  readonly params: FlightParamsV3;
  /** Gear slot codes 0 (empty) or 1 + index into GEAR_KINDS. */
  readonly slotCodes: Int32Array;
  frame: number; camY: number; px: number; vx: number;
  fuel: number; fireCd: number;
  dead: number; cause: number; deathX: number; deathY: number;
  rows: Int16Array; genRow: number;
  gen: Gen;
  ents: Ent[]; bullets: Bullet[]; nextId: number;
  hist: Int32Array;
  gear: GearState;
  hash: number; stage: number; seg: number;
  kills: number; shots: number; refuelFrames: number; gates: number; blocks: number; pickups: number; depotsLost: number;
}

export type SimEvent =
  | { t: 'shot' } | { t: 'kill'; kind: number; b: number; x: number; y: number } | { t: 'fuelLost'; x: number; y: number }
  | { t: 'clink'; x: number; y: number } | { t: 'gate'; x: number; y: number; broken: number; big: number }
  | { t: 'crate'; x: number; y: number } | { t: 'pickup'; spawnId: number; x: number; y: number }
  | { t: 'refuel' } | { t: 'stage'; n: number } | { t: 'seg'; seg: number; prev: number }
  | { t: 'gear'; slot: number; kind: GearKind } | { t: 'shieldPop'; x: number; y: number } | { t: 'drop'; x: number; y: number }
  | { t: 'warn'; id: number; side: number } | { t: 'death'; cause: Cause };

// ------------------------------------------------------------------ helpers
function next(g: Gen): number { // mulberry32
  let t = (g.rng = (g.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
function rint(g: Gen, n: number): number { return n <= 1 ? 0 : next(g) % n; }
function fnv(h: number, v: number): number { return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0; }
export function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); return h >>> 0; }
function ri(r: number): number { return (((r % RING) + RING) % RING) * 5; }
/** Saturating growth: span * P / (P + k), integer. */
function sat(span: number, P: number, k: number): number { return ((span * P) / (P + k)) | 0; }
/** Decay from span towards 0: span * k / (k + P), integer. */
function decay(span: number, P: number, k: number): number { return ((span * k) / (k + P)) | 0; }

export function stageAtRow(r: number): number { return 1 + ((r / STAGE_ROWS) | 0); }
export function segAtRow(r: number): number { return ((r / SEG_ROWS) | 0) % SEG_COUNT; }
export function wAtRow(route: RouteV3, r: number): number { const v = route.w[segAtRow(r)] ?? -1; return v < 0 ? 0 : v; }
export function pAtRow(s: StateV3, r: number): number { return pressureAt(s.params.pressure, (r / 2) | 0); }
export function baseHalfWidth(P: number): number { return 30 + decay(65, P, 400); }
/** Mean depot spacing in rows; reaches the 675-row bound only asymptotically. */
export function depotSpacingRows(P: number): number { return 600 - decay(320, P, 1200); }
/** Threat budget for one 100 m window, before the river-style factor. */
export function windowBudget(P: number): number { return 10 + ((P * 4) / 100 | 0); }
function nextGateRow(r: number): number { return (((r / GATE_ROWS) | 0) + 1) * GATE_ROWS; }
function nearGate(r: number, margin: number): boolean { const k = r % GATE_ROWS; return k <= margin || GATE_ROWS - k <= margin; }

// Threat catalogue: cost, unlock pressure, rows kept clear after the group.
const T = { BOAT: 1, DRONE: 2, ROCK: 3, MINE: 4, TRACKER: 5, JET: 6, PINCER: 7, LAYER: 8, WAVE: 9 } as const;
const T_COST = [0, 2, 3, 2, 2, 5, 5, 8, 7, 0];
const T_GAP = [0, 10, 10, 10, 10, 14, 18, 26, 26, 40];
export const BEHAVIOUR_UNLOCKS = { tracker: 150, strafingJet: 250, pincer: 350, mineLayer: 420, depotScreen: 550, wave: 700 } as const;

const unlocksOf = (s: StateV3): readonly number[] => (s.params.threats ?? DEFAULT_THREATS).unlock;
function threatWeight(kind: number, P: number, w: number, un: readonly number[]): number {
  if (P < (un[kind] ?? 0)) return 0;
  const q = P - (un[kind] ?? 0);
  switch (kind) {
    case T.BOAT: return 15 + decay(45, P, 500);
    case T.DRONE: return 15 + decay(25, P, 500);
    case T.ROCK: { const v = 14 + sat(6, q, 400); return w > 600 ? (v / 2) | 0 : v; }
    case T.MINE: return 12 + sat(8, q, 500);
    case T.TRACKER: return 10 + sat(20, q, 400);
    case T.JET: return 10 + sat(15, q, 500);
    case T.PINCER: return 8 + sat(17, q, 500);
    case T.LAYER: return 6 + sat(14, q, 500);
    case T.WAVE: return 8 + sat(22, q, 600);
    default: return 0;
  }
}

// ------------------------------------------------------------------ creation
function makeEnt(s: StateV3, k: number, b: number, xPx: number, r: number): Ent {
  const size = SIZE[k]!;
  const e: Ent = { id: s.nextId++, k, b, x: xPx * U, y: r * ROW_U, hw: size[0], hh: size[1], vx: 0, vy: 0, awake: 0, moving: 0, hp: 1, maxHp: 1, big: 0, t: 0, a: 0, c: 0, minX: 0, maxX: 0, gx: 0, drops: 0 };
  s.ents.push(e);
  return e;
}

export function slotCodesOf(loadout: readonly (GearKind | null)[]): Int32Array {
  const out = new Int32Array(3);
  for (let i = 0; i < 3; i++) { const g = loadout[i] ?? null; out[i] = g === null ? 0 : 1 + GEAR_KINDS.indexOf(g); }
  return out;
}

export function create(route: RouteV3, params: FlightParamsV3 = DEFAULT_PARAMS): StateV3 {
  validatePressure(params.pressure);
  if (params.threats) validateThreats(params.threats);
  const s: StateV3 = {
    rules: 3, route, params, slotCodes: slotCodesOf(params.loadout),
    frame: 0, camY: 0, px: (W / 2) * U, vx: 0, fuel: FUEL_MAX, fireCd: 0,
    dead: 0, cause: 0, deathX: 0, deathY: 0,
    rows: new Int16Array(RING * 5), genRow: 0,
    gen: {
      rng: route.seed >>> 0, r0: 0, r1: START_ROWS, c0: W / 2, c1: W / 2, h0: 95, h1: 95,
      islStart: 0, islLen: 0, islMax: 0, lane: W / 2,
      nextFuel: 180, lastFuel: 0, nextCrate: 0, quietUntil: 0, winRow: START_ROWS + 20, plan: [], zones: [],
    },
    ents: [], bullets: [], nextId: 1,
    hist: new Int32Array(HIST).fill((W / 2) * U),
    gear: { shield: 0, grace: 0, spread: 0, long: 0, uses: 0 },
    hash: 2166136261, stage: 1, seg: -1,
    kills: 0, shots: 0, refuelFrames: 0, gates: 0, blocks: 0, pickups: 0, depotsLost: 0,
  };
  ensureRows(s);
  return s;
}

// ------------------------------------------------------------------ terrain
export function rowData(s: StateV3, r: number): [number, number, number, number, number] {
  const i = ri(r), a = s.rows;
  return [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!, a[i + 4]!];
}
function waterAt(s: StateV3, r: number, x0: number, x1: number): boolean {
  const i = ri(r), a = s.rows;
  if (x0 < a[i]! || x1 > a[i + 1]!) return false;
  if (a[i + 3]! > a[i + 2]! && x1 > a[i + 2]! && x0 < a[i + 3]!) return false;
  return true;
}
export function laneAt(s: StateV3, r: number): number { return s.rows[ri(r) + 4]!; }

function ensureRows(s: StateV3): void {
  const need = ((s.camY / ROW_U) | 0) + AHEAD_ROWS;
  while (s.genRow <= need) genRow(s);
}
export function generateTo(s: StateV3, r: number): void { while (s.genRow <= r) genRow(s); }

function genRow(s: StateV3): void {
  const g = s.gen, r = s.genRow, route = s.route;
  const P = pAtRow(s, r), w = wAtRow(route, r), stage = stageAtRow(r);

  if (r >= g.r1) {
    g.r0 = g.r1; g.c0 = g.c1; g.h0 = g.h1;
    let interval = (((48 - ((w * 24) / 1000 | 0)) * (650 + decay(350, P, 400))) / 1000) | 0;
    if (interval < 20) interval = 20;
    g.r1 = g.r0 + interval;
    let h = (baseHalfWidth(P) * (1000 - ((w * 300) / 1000 | 0))) / 1000 | 0;
    h += rint(g, 15) - 7;
    const maxDh = (interval * 5 / 8) | 0;
    if (h > g.h0 + maxDh) h = g.h0 + maxDh;
    if (h < g.h0 - maxDh) h = g.h0 - maxDh;
    if (h < 30) h = 30;
    if (h > 100) h = 100;
    const amp = 17 + ((w * 42) / 1000 | 0) + sat(24, P, 600);
    let c = W / 2 + rint(g, amp * 2 + 1) - amp;
    const maxDc = (interval * 5 / 4) | 0;
    if (c > g.c0 + maxDc) c = g.c0 + maxDc;
    if (c < g.c0 - maxDc) c = g.c0 - maxDc;
    if (c - h < 10) c = 10 + h;
    if (c + h > W - 10) c = W - 10 - h;
    g.c1 = c; g.h1 = h;
  }
  const t = (((r - g.r0) * 256) / (g.r1 - g.r0)) | 0;
  const sm = (t * t * (768 - 2 * t)) >> 16;
  const c = g.c0 + (((g.c1 - g.c0) * sm) >> 8);
  const h = g.h0 + (((g.h1 - g.h0) * sm) >> 8);
  let l = c - h, rr = c + h;
  if (l < 8) l = 8;
  if (rr > W - 8) rr = W - 8;

  // islands: only on calm, wide stretches (as v2)
  let il = 0, ir = 0;
  if (g.islLen === 0 && r > 220 && w < 400 && h >= 62 && rint(g, 1000) < 6) {
    const len = 70 + rint(g, 90);
    if (r + len + 40 < nextGateRow(r) && (r % GATE_ROWS) > 40) { g.islStart = r; g.islLen = len; g.islMax = 12 + rint(g, 18); }
  }
  if (g.islLen > 0) {
    const k = r - g.islStart, ramp = 24;
    if (k >= g.islLen) { g.islLen = 0; g.islStart = 0; g.islMax = 0; }
    else {
      let env = k < ramp ? ((k * 256) / ramp) | 0 : (k > g.islLen - ramp ? (((g.islLen - k) * 256) / ramp) | 0 : 256);
      env = (env * env * (768 - 2 * env)) >> 16;
      let ih = (g.islMax * env) >> 8;
      if (ih > h - 30) ih = h - 30;
      if (ih >= 4) { il = c - ih; ir = c + ih; }
    }
  }

  // reserved lane: moves at most 3 px per row (0.6 px per px forward; the plane manages 1.1)
  let target = c;
  if (g.islLen > 0) {
    const islandHalf = g.islMax;
    const leftRoom = (c - islandHalf) - l, rightRoom = rr - (c + islandHalf);
    target = leftRoom >= rightRoom ? ((l + c - islandHalf) / 2) | 0 : ((c + islandHalf + rr) / 2) | 0;
  }
  let lane = g.lane;
  if (lane < target - 3) lane += 3; else if (lane > target + 3) lane -= 3; else lane = target;
  if (ir > il) {
    if (lane > il - LANE_HW && lane < ir + LANE_HW) lane = (lane - il) < (ir - lane) ? il - LANE_HW : ir + LANE_HW;
  }
  if (lane < l + LANE_HW) lane = l + LANE_HW;
  if (lane > rr - LANE_HW) lane = rr - LANE_HW;
  g.lane = lane;

  const i = ri(r);
  s.rows[i] = l; s.rows[i + 1] = rr; s.rows[i + 2] = il; s.rows[i + 3] = ir; s.rows[i + 4] = lane;

  if (r >= g.winRow) planWindow(s, r);
  spawnAt(s, r, P, w, stage);
  s.genRow++;
}

// ------------------------------------------------------------------ placement
type Iv = [number, number];
function cut(ivs: Iv[], a: number, b: number): Iv[] {
  const out: Iv[] = [];
  for (const iv of ivs) {
    if (b < iv[0] || a > iv[1]) { out.push(iv); continue; }
    if (a > iv[0]) out.push([iv[0], a - 1]);
    if (b < iv[1]) out.push([b + 1, iv[1]]);
  }
  return out;
}
function isStatic(e: Ent): boolean {
  return e.k === K.ROCK || e.k === K.MINE || (e.k === K.BOAT && e.moving === 0);
}
/** Pick an x (px) in open water at row r for a half-width hw. Static obstacles keep off the lane and clear zones. */
function placeX(s: StateV3, r: number, hw: number, isStaticObstacle: boolean, avoidStaticBelow: number): number {
  const g = s.gen, [l, rr, il, ir, lane] = rowData(s, r);
  let ivs: Iv[] = ir > il ? [[l + hw + 3, il - hw - 3], [ir + hw + 3, rr - hw - 3]] : [[l + hw + 3, rr - hw - 3]];
  if (isStaticObstacle) {
    ivs = cut(ivs, lane - LANE_HW - hw, lane + LANE_HW + hw);
    for (const z of g.zones) if (r >= z.r0 && r <= z.r1) ivs = cut(ivs, z.x0 - hw, z.x1 + hw);
  }
  if (avoidStaticBelow > 0) {
    for (const e of s.ents) {
      if (!isStatic(e)) continue;
      const er = (e.y / ROW_U) | 0;
      if (er < r - avoidStaticBelow || er > r) continue;
      const ex = (e.x / U) | 0;
      ivs = cut(ivs, ex - e.hw - hw - 24, ex + e.hw + hw + 24);
    }
  }
  const ok = ivs.filter((iv) => iv[1] >= iv[0]);
  if (!ok.length) return -1;
  const iv = ok[rint(g, ok.length)]!;
  return iv[0] + rint(g, iv[1] - iv[0] + 1);
}

// ------------------------------------------------------------------ director
function planWindow(s: StateV3, r: number): void {
  const g = s.gen;
  g.winRow = r + WINDOW_ROWS;
  const P = pAtRow(s, r + (WINDOW_ROWS >> 1));
  const w = wAtRow(s.route, r + (WINDOW_ROWS >> 1));
  const un = unlocksOf(s), pct = (s.params.threats ?? DEFAULT_THREATS).budgetPct;
  let budget = (((windowBudget(P) * pct) / 100 | 0) * (1200 - ((w * 4) / 10 | 0))) / 1000 | 0;
  const total = budget;
  let cursor = r + rint(g, 12);
  const kinds = [T.BOAT, T.DRONE, T.ROCK, T.MINE, T.TRACKER, T.JET, T.PINCER, T.LAYER, T.WAVE];
  for (let guard = 0; guard < 40 && budget >= 2; guard++) {
    let tot = 0;
    const ws: number[] = [];
    for (const k of kinds) { const wt = (T_COST[k] ?? 0) > budget && k !== T.WAVE ? 0 : threatWeight(k, P, w, un); ws.push(wt); tot += wt; }
    if (tot <= 0) break;
    let pick = rint(g, tot), kind: number = T.BOAT;
    for (let i = 0; i < kinds.length; i++) { pick -= ws[i]!; if (pick < 0) { kind = kinds[i]!; break; } }
    let row = cursor;
    if (nearGate(row, 24)) row = nextGateRow(row - 30) + 25;
    if (row >= r + WINDOW_ROWS) break;
    if (kind === T.WAVE) {
      const pool = [T.TRACKER, T.PINCER, T.LAYER, T.JET, T.DRONE].filter((k) => P >= (un[k] ?? 0));
      const n = 2 + (P >= 1100 ? rint(g, 2) : 0);
      let cost = 0, off = 0;
      for (let j = 0; j < n; j++) {
        const m = pool[rint(g, pool.length)]!;
        if (nearGate(row + off, 24)) break;
        g.plan.push({ row: row + off, kind: m, a: 0, c: 0, d: 0 });
        cost += T_COST[m] ?? 0;
        off += 12 + rint(g, 8);
      }
      budget -= cost > 2 ? cost - 2 : cost;
      cursor = row + off + (T_GAP[T.WAVE] ?? 40);
      continue;
    }
    const cost = T_COST[kind] ?? 2;
    g.plan.push({ row, kind, a: 0, c: 0, d: 0 });
    budget -= cost;
    // spread the budget over the window; the per-kind gap is the floor
    let gap = ((WINDOW_ROWS * cost) / (total > 0 ? total : 1)) | 0;
    const floor = T_GAP[kind] ?? 10;
    if (gap < floor) gap = floor;
    cursor = row + gap + rint(g, ((gap / 2) | 0) + 1) - ((gap / 4) | 0);
    if (cursor <= row + floor) cursor = row + floor;
  }
  g.plan.sort((a, b) => a.row - b.row || a.kind - b.kind);
}

function spawnPlanned(s: StateV3, p: Planned, r: number, P: number): void {
  const g = s.gen;
  switch (p.kind) {
    case T.BOAT: case T.ROCK: case T.MINE: {
      const kind: number = p.kind === T.BOAT ? K.BOAT : p.kind === T.ROCK ? K.ROCK : K.MINE;
      let moving = 0;
      if (kind === K.BOAT) moving = rint(g, 1000) < 350 + sat(450, P, 600) ? 1 : 0;
      const staticOne = kind !== K.BOAT || moving === 0;
      const x = placeX(s, r, SIZE[kind]![0], staticOne, 0);
      if (x < 0) return;
      const e = makeEnt(s, kind, kind === K.BOAT ? B.PATROL : B.NONE, x, r);
      if (kind === K.BOAT) { const sp = 12 + sat(36, P, 700); e.moving = moving; e.vx = rint(g, 2) ? sp : -sp; }
      if (kind === K.MINE) e.t = rint(g, 60);
      return;
    }
    case T.DRONE: {
      const x = placeX(s, r, SIZE[K.DRONE]![0], false, 0);
      if (x < 0) return;
      const e = makeEnt(s, K.DRONE, B.PATROL, x, r);
      const sp = 22 + sat(40, P, 700);
      e.moving = 1; e.vx = rint(g, 2) ? sp : -sp;
      return;
    }
    case T.TRACKER: {
      const x = placeX(s, r, SIZE[K.DRONE]![0], false, 0);
      if (x < 0) return;
      const e = makeEnt(s, K.DRONE, B.TRACKER, x, r);
      e.moving = 1;
      e.a = MIN_REACTION_FRAMES + decay(14, P, 400); // reaction delay, frames (>= 18)
      e.c = 16 + sat(18, P, 800); // lateral speed cap, su/frame (plane: 50)
      return;
    }
    case T.PINCER: {
      const [l, rr, il, ir, lane] = rowData(s, r);
      if (ir > il) return; // never across an island
      const gapPx = PINCER_MIN_GAP_PX + decay(24, P, 300);
      const hw = SIZE[K.DRONE]![0];
      const sp = 18 + sat(14, P, 800);
      for (let side = 0; side < 2; side++) {
        const e = makeEnt(s, K.DRONE, B.PINCER, side === 0 ? l + hw + 2 : rr - hw - 2, r);
        e.moving = 1; e.gx = lane * U; e.a = (gapPx >> 1) * U; e.c = sp; e.t = side === 0 ? -1 : 1;
      }
      return;
    }
    case T.LAYER: {
      const x = placeX(s, r, SIZE[K.BOAT]![0], false, 0);
      if (x < 0) return;
      const e = makeEnt(s, K.BOAT, B.LAYER, x, r);
      const sp = 14 + sat(30, P, 700);
      e.moving = 1; e.vx = rint(g, 2) ? sp : -sp;
      e.a = 44 - sat(16, P, 800); // frames between drops
      e.t = e.a >> 1;
      return;
    }
    case T.JET: {
      const side = rint(g, 2);
      const e = makeEnt(s, K.JET, B.STRAFE, side ? W + 20 : -20, r);
      const sp = 50 + sat(60, P, 1000);
      e.moving = 1; e.vx = side ? -sp : sp; e.vy = -(sat(16, P, 1000)); e.a = JET_WARN_FRAMES; e.t = 0; e.c = side;
      return;
    }
    case K.BOAT + 100: { // depot screen boat (kind code 101): bounds in a/c (px)
      const minX = p.a, maxX = p.c;
      if (maxX - minX < 4) return;
      const e = makeEnt(s, K.BOAT, B.SCREEN, minX + rint(g, maxX - minX + 1), r);
      const sp = 14 + sat(30, P, 700);
      e.moving = 1; e.vx = rint(g, 2) ? sp : -sp; e.minX = minX * U; e.maxX = maxX * U;
      return;
    }
    default: return;
  }
}

function spawnAt(s: StateV3, r: number, P: number, w: number, stage: number): void {
  const g = s.gen;
  // prune clear zones and keep the plan ordered
  if (g.zones.length && (r & 63) === 0) g.zones = g.zones.filter((z) => z.r1 >= r - 64);
  if (r < START_ROWS + 20) return;

  if (r % GATE_ROWS === 0) {
    const big = r % STAGE_ROWS === 0;
    let hp = big ? 2 + ((stage / 3) | 0) : 1;
    if (hp > 6) hp = 6;
    const e = makeEnt(s, K.GATE, B.NONE, W / 2, r);
    e.hp = hp; e.maxHp = hp; e.big = big ? 1 : 0;
    g.quietUntil = r + 24;
    return;
  }

  // seed depots: hard bound on spacing, they also ignore quiet zones
  if (r >= g.nextFuel && !nearGate(r, 3)) {
    // Normally keep static obstacles out of the approach; close to the bound, place regardless.
    const urgent = r >= g.lastFuel + DEPOT_MAX_GAP_ROWS - 20;
    const x = placeX(s, r, 9, false, urgent ? 0 : 30);
    if (x >= 0) {
      makeEnt(s, K.FUEL, B.NONE, x, r);
      const sp = depotSpacingRows(P);
      let nf = r + sp + rint(g, (sp / 4) | 0) - ((sp / 8) | 0);
      if (nf > r + DEPOT_MAX_GAP_ROWS - 60) nf = r + DEPOT_MAX_GAP_ROWS - 60;
      g.lastFuel = r; g.nextFuel = nf;
      g.zones.push({ r0: r - 30, r1: r + 4, x0: x - 16, x1: x + 16 });
      if (P >= BEHAVIOUR_UNLOCKS.depotScreen && rint(g, 1000) < 250 + sat(450, P - BEHAVIOUR_UNLOCKS.depotScreen, 800)) {
        const [l, rr] = rowData(s, r);
        const hw = SIZE[K.BOAT]![0];
        const sr = r + 14 + rint(g, 8);
        if (!nearGate(sr, 4)) {
          g.plan.push({ row: sr, kind: K.BOAT + 100, a: l + hw + 3, c: x - 16 - hw, d: 0 });
          g.plan.push({ row: sr, kind: K.BOAT + 100, a: x + 16 + hw, c: rr - hw - 3, d: 0 });
          g.zones.push({ r0: r, r1: sr + 10, x0: x - 16, x1: x + 16 });
          g.plan.sort((a, b) => a.row - b.row || a.kind - b.kind);
        }
      }
    }
  }

  if (r >= g.quietUntil && nextGateRow(r) - r >= 24) {
    while (g.plan.length && g.plan[0]!.row <= r) {
      const p = g.plan.shift()!;
      if (p.row === r) spawnPlanned(s, p, r, P);
    }
  } else {
    while (g.plan.length && g.plan[0]!.row <= r) g.plan.shift();
  }

  // Block Crates: only on stretches where Squeektoshi was really running (as v2)
  if (s.route.crates && w > 0 && r >= g.nextCrate && !nearGate(r, 24)) {
    const x = placeX(s, r, 8, false, 0);
    if (x >= 0) {
      makeEnt(s, K.CRATE, B.NONE, x, r);
      g.nextCrate = r + 150 - ((w * 70) / 1000 | 0) + rint(g, 40);
    }
  }
}

// ------------------------------------------------------------------ Gear and injected spawns
/** Inject a reward spawn (pickup-only). Called by the replay driver from the input log. */
export function inject(s: StateV3, spawnId: number, kindCode: number, xPx: number, row: number): void {
  const e = makeEnt(s, K.PICKUP, B.NONE, xPx, row);
  e.a = spawnId; e.c = kindCode;
}

function applyGear(s: StateV3, slot: number, ev: SimEvent[]): void {
  const code = s.slotCodes[slot] ?? 0;
  if (code === 0) return;
  const kind = GEAR_KINDS[code - 1]!;
  const fx = s.params.effects;
  if (kind === 'shield') { s.gear.shield += fx.shieldCharges; if (s.gear.shield > 3) s.gear.shield = 3; }
  else if (kind === 'spread') { if (s.gear.spread < fx.spreadFrames) s.gear.spread = fx.spreadFrames; }
  else if (kind === 'seed') { s.fuel += fx.seedFuel; if (s.fuel > FUEL_MAX) s.fuel = FUEL_MAX; }
  else if (kind === 'long') { if (s.gear.long < fx.longFrames) s.gear.long = fx.longFrames; }
  s.gear.uses++;
  ev.push({ t: 'gear', slot, kind });
}

// ------------------------------------------------------------------ step
/**
 * Advance one frame. mask: IN bits. gearSlots: bit n set = a committed Gear activation for slot n
 * is applied on this frame (the rising edge recorded in the input log with its seq).
 */
export function step(s: StateV3, mask: number, gearSlots = 0): SimEvent[] | null {
  if (s.dead) return null;
  const ev: SimEvent[] = [];
  s.frame++;
  s.camY += SPEED;

  const want = ((mask & IN.R) ? STEER_MAX : 0) - ((mask & IN.L) ? STEER_MAX : 0);
  if (s.vx < want) s.vx = Math.min(want, s.vx + STEER_ACC);
  else if (s.vx > want) s.vx = Math.max(want, s.vx - STEER_ACC);
  s.px += s.vx;
  if (s.px < 0) s.px = 0;
  if (s.px > W * U) s.px = W * U;
  s.hist[s.frame & (HIST - 1)] = s.px;

  ensureRows(s);
  const py = s.camY + PLAYER_SY * U;

  if (gearSlots) for (let n = 0; n < 3; n++) if (gearSlots & (1 << n)) applyGear(s, n, ev);

  // fire
  if (s.fireCd > 0) s.fireCd--;
  const spread = s.gear.spread > 0, long = s.gear.long > 0;
  const maxB = spread ? 9 : long ? 4 : 3;
  if ((mask & IN.FIRE) && s.fireCd === 0 && s.bullets.length < maxB) {
    const life = long ? BULLET_LIFE_LONG : BULLET_LIFE;
    s.bullets.push({ x: s.px, y: py + 8 * U, vx: 0, life });
    if (spread) { s.bullets.push({ x: s.px - 3 * U, y: py + 6 * U, vx: -22, life }); s.bullets.push({ x: s.px + 3 * U, y: py + 6 * U, vx: 22, life }); }
    s.fireCd = FIRE_CD; s.shots++;
    ev.push({ t: 'shot' });
  }

  // bullets
  const top = s.camY + (H + 10) * U;
  for (let bi = s.bullets.length - 1; bi >= 0; bi--) {
    const b = s.bullets[bi]!;
    b.y += SPEED + BULLET_REL; b.x += b.vx; b.life--;
    if (b.y > top || b.life <= 0 || b.x < 0 || b.x > W * U) { s.bullets.splice(bi, 1); continue; }
    let hit = false;
    for (let ei = 0; ei < s.ents.length; ei++) {
      const e = s.ents[ei]!;
      if (e.y > top || e.k === K.CRATE || e.k === K.PICKUP) continue;
      if (Math.abs(b.y - e.y) >= (e.hh + 4) * U) continue;
      if (e.k === K.GATE) {
        const [l, rr] = rowData(s, (e.y / ROW_U) | 0);
        if (b.x < l * U || b.x > rr * U) continue;
        e.hp--;
        if (e.hp <= 0) { ev.push({ t: 'gate', x: e.x, y: e.y, broken: 1, big: e.big }); s.ents.splice(ei, 1); s.gates++; }
        else ev.push({ t: 'gate', x: b.x, y: e.y, broken: 0, big: e.big });
        hit = true; break;
      }
      if (e.k === K.JET && (e.x < 0 || e.x > W * U)) continue;
      if (Math.abs(b.x - e.x) >= (e.hw + 1) * U) continue;
      if (e.k === K.ROCK) { ev.push({ t: 'clink', x: b.x, y: b.y }); hit = true; break; }
      if (e.k === K.FUEL) { ev.push({ t: 'fuelLost', x: e.x, y: e.y }); s.depotsLost++; }
      else { ev.push({ t: 'kill', kind: e.k, b: e.b, x: e.x, y: e.y }); s.kills++; }
      s.ents.splice(ei, 1);
      hit = true; break;
    }
    if (hit) s.bullets.splice(bi, 1);
  }

  // entities
  const bottom = s.camY - 50 * U;
  for (let ei = s.ents.length - 1; ei >= 0; ei--) {
    const e = s.ents[ei]!;
    if (e.y < bottom) { s.ents.splice(ei, 1); continue; }
    if (e.y > s.camY + (H + 50) * U) continue;
    const ahead = e.y - py;
    if (!e.awake && ahead < (e.k === K.JET ? 330 : 212) * U) {
      e.awake = 1;
      if (e.b === B.STRAFE) ev.push({ t: 'warn', id: e.id, side: e.c });
    }
    if (!e.awake || !e.moving) continue;
    switch (e.b) {
      case B.STRAFE: {
        if (e.t < e.a) { e.t++; break; } // edge marker phase: the jet waits off screen
        e.x += e.vx; e.y += e.vy;
        if (e.x < -40 * U || e.x > (W + 40) * U) s.ents.splice(ei, 1);
        break;
      }
      case B.TRACKER: {
        if (ahead > 40 * U) {
          const target = s.hist[(s.frame - e.a) & (HIST - 1)]!;
          let want2 = ((target - e.x) / 8) | 0;
          if (want2 > e.c) want2 = e.c;
          if (want2 < -e.c) want2 = -e.c;
          if (e.vx < want2) e.vx = Math.min(want2, e.vx + 2);
          else if (e.vx > want2) e.vx = Math.max(want2, e.vx - 2);
        }
        moveInWater(s, e);
        break;
      }
      case B.PINCER: {
        const tx = e.t < 0 ? e.gx - e.a - e.hw * U : e.gx + e.a + e.hw * U;
        if (e.t < 0 ? e.x < tx : e.x > tx) {
          let nx = e.x + (e.t < 0 ? e.c : -e.c);
          if (e.t < 0 ? nx > tx : nx < tx) nx = tx;
          const r = (e.y / ROW_U) | 0;
          if (waterAt(s, r, ((nx / U) | 0) - e.hw, ((nx / U) | 0) + e.hw)) e.x = nx;
        }
        break;
      }
      case B.LAYER: {
        moveInWater(s, e);
        if (ahead > 80 * U && e.drops < 3 && --e.t <= 0) {
          e.t = e.a;
          const r = (e.y / ROW_U) | 0, xpx = (e.x / U) | 0;
          if (Math.abs(xpx - laneAt(s, r)) > LANE_HW + 6 && rowStaysOpen(s, r, xpx, 5)) {
            const m = makeEnt(s, K.MINE, B.NONE, xpx, r);
            m.t = s.frame & 63; e.drops++;
            ev.push({ t: 'drop', x: m.x, y: m.y });
          }
        }
        break;
      }
      default: moveInWater(s, e); // PATROL, SCREEN
    }
  }

  // fuel and Gear timers
  s.fuel -= FUEL_DRAIN;
  if (s.gear.spread > 0) s.gear.spread--;
  if (s.gear.long > 0) s.gear.long--;
  if (s.gear.grace > 0) s.gear.grace--;

  // player collisions
  const x0 = s.px - PLAYER_HW * U, x1 = s.px + PLAYER_HW * U;
  const r0 = ((py - PLAYER_HH * U) / ROW_U) | 0, r1 = ((py + PLAYER_HH * U) / ROW_U) | 0;
  let crash = 0, crashEnt = -1;
  const grace = s.gear.grace > 0;
  if (!grace) {
    for (let r = r0; r <= r1 && !crash; r++) {
      const [l, rr, il, ir] = rowData(s, r);
      if (x0 < l * U || x1 > rr * U) crash = 1;
      else if (ir > il && x1 > il * U && x0 < ir * U) crash = 1;
    }
  }
  let refuel = false;
  for (let ei = 0; ei < s.ents.length && !crash; ei++) {
    const e = s.ents[ei]!;
    if (Math.abs(e.y - py) >= (e.hh + PLAYER_HH - 1) * U) continue;
    if (e.k === K.GATE) { if (!grace) { crash = 7; crashEnt = ei; } continue; }
    if (Math.abs(e.x - s.px) >= (e.hw + PLAYER_HW - 1) * U) continue;
    if (e.k === K.FUEL) { refuel = true; continue; }
    if (e.k === K.CRATE) { s.blocks++; ev.push({ t: 'crate', x: e.x, y: e.y }); s.ents.splice(ei, 1); ei--; continue; }
    if (e.k === K.PICKUP) { s.pickups++; ev.push({ t: 'pickup', spawnId: e.a, x: e.x, y: e.y }); s.ents.splice(ei, 1); ei--; continue; }
    if (grace) continue;
    crash = e.k === K.BOAT ? 2 : e.k === K.DRONE ? 3 : e.k === K.JET ? 4 : e.k === K.ROCK ? 5 : 6;
    crashEnt = ei;
  }
  if (crash && s.gear.shield > 0) {
    s.gear.shield--; s.gear.grace = s.params.effects.graceFrames;
    ev.push({ t: 'shieldPop', x: s.px, y: py });
    if (crashEnt >= 0) {
      const e = s.ents[crashEnt]!;
      if (e.k !== K.ROCK && e.k !== K.GATE) { ev.push({ t: 'kill', kind: e.k, b: e.b, x: e.x, y: e.y }); s.kills++; s.ents.splice(crashEnt, 1); }
    }
    crash = 0;
  }
  if (refuel && !crash) {
    s.fuel = Math.min(FUEL_MAX, s.fuel + FUEL_FILL);
    s.refuelFrames++;
    ev.push({ t: 'refuel' });
  }
  if (!crash && s.fuel <= 0) { s.fuel = 0; crash = 8; }

  const prow = (py / ROW_U) | 0;
  const seg = segAtRow(prow), st = stageAtRow(prow);
  if (seg !== s.seg) { ev.push({ t: 'seg', seg, prev: s.seg }); s.seg = seg; }
  if (st !== s.stage) { ev.push({ t: 'stage', n: st }); s.stage = st; }

  if (crash) {
    s.dead = 1; s.cause = crash; s.deathX = s.px; s.deathY = py;
    ev.push({ t: 'death', cause: CAUSES[crash]! });
  }

  let h = s.hash;
  h = fnv(h, s.camY); h = fnv(h, s.px); h = fnv(h, s.fuel); h = fnv(h, s.ents.length); h = fnv(h, s.bullets.length);
  h = fnv(h, s.blocks); h = fnv(h, s.nextId); h = fnv(h, s.kills); h = fnv(h, s.gear.shield * 4096 + s.gear.grace);
  h = fnv(h, s.gear.spread * 4096 + s.gear.long); h = fnv(h, s.pickups);
  if (s.dead) h = fnv(fnv(h, s.gen.rng), crash);
  s.hash = h;
  return ev;
}

function moveInWater(s: StateV3, e: Ent): void {
  const nx = e.x + e.vx, r = (e.y / ROW_U) | 0;
  const outOfBounds = e.maxX > 0 && (nx < e.minX || nx > e.maxX);
  if (outOfBounds || !waterAt(s, r, ((nx / U) | 0) - e.hw, ((nx / U) | 0) + e.hw)) e.vx = -e.vx;
  else e.x = nx;
}

/** After adding an obstacle of half-width hw at xpx, does row r still have a free gap of >= 40 px? */
function rowStaysOpen(s: StateV3, r: number, xpx: number, hw: number): boolean {
  const [l, rr, il, ir] = rowData(s, r);
  let ivs: Iv[] = ir > il ? [[l, il - 1], [ir + 1, rr]] : [[l, rr]];
  ivs = cut(ivs, xpx - hw, xpx + hw);
  for (const e of s.ents) {
    if (!isStatic(e) || ((e.y / ROW_U) | 0) !== r) continue;
    const ex = (e.x / U) | 0;
    ivs = cut(ivs, ex - e.hw, ex + e.hw);
  }
  for (const iv of ivs) if (iv[1] - iv[0] + 1 >= 40) return true;
  return false;
}

// ------------------------------------------------------------------ info
export function distanceM(s: StateV3): number { return s.camY / (U * PX_PER_M); }
export function distanceRows(s: StateV3): number { return ((s.camY + PLAYER_SY * U) / ROW_U) | 0; }
export function causeName(s: StateV3): Cause { return CAUSES[s.cause] ?? ''; }
export interface InfoV3 {
  m: number; P: number; budget: number; w: number; seg: number; stage: number;
  fuelPct: number; channelPx: number; depotSpacingM: number; nextDepotM: number;
  unlocked: string[]; onScreen: Record<string, number>;
}
export function info(s: StateV3): InfoV3 {
  const r = distanceRows(s), P = pAtRow(s, r), w = wAtRow(s.route, r);
  const [l, rr] = rowData(s, r);
  const unlocked: string[] = [];
  const un = unlocksOf(s);
  const at: Record<keyof typeof BEHAVIOUR_UNLOCKS, number> = { tracker: un[T.TRACKER]!, strafingJet: un[T.JET]!, pincer: un[T.PINCER]!, mineLayer: un[T.LAYER]!, depotScreen: BEHAVIOUR_UNLOCKS.depotScreen, wave: un[T.WAVE]! };
  for (const n of Object.keys(at) as (keyof typeof at)[]) if (P >= at[n]) unlocked.push(n);
  const onScreen: Record<string, number> = {};
  const topY = s.camY + H * U;
  let nextDepot = -1;
  for (const e of s.ents) {
    if (e.k === K.FUEL && e.y > s.camY + PLAYER_SY * U && (nextDepot < 0 || e.y < nextDepot)) nextDepot = e.y;
    if (e.y < s.camY || e.y > topY) continue;
    const n = e.b > B.NONE ? BEHAVIOUR_NAME[e.b]! : KIND_NAME[e.k]!;
    onScreen[n] = (onScreen[n] ?? 0) + 1;
  }
  return {
    m: distanceM(s), P, budget: (windowBudget(P) * (s.params.threats ?? DEFAULT_THREATS).budgetPct) / 100 | 0, w, seg: segAtRow(r), stage: stageAtRow(r),
    fuelPct: s.fuel / FUEL_MAX, channelPx: rr - l, depotSpacingM: depotSpacingRows(P) / 2,
    nextDepotM: nextDepot < 0 ? -1 : (nextDepot - (s.camY + PLAYER_SY * U)) / (U * PX_PER_M),
    unlocked, onScreen,
  };
}

export { DEFAULT_PRESSURE, pressureAt, validatePressure };
export type { PressurePoints };

/**
 * A fair start at an arbitrary row, for the fairness prover: generates the route up to the row (no
 * stepping), drops what is behind, clears a 20 m runway of threats, and puts the plane on the lane
 * with a full tank. The generator state at the row is exactly what a flight from 0 would see.
 */
export function createAt(route: RouteV3, params: FlightParamsV3, row: number): StateV3 {
  const s = create(route, params);
  const startRow = row < 16 ? 16 : row;
  s.camY = (startRow - 16) * ROW_U;
  s.frame = (s.camY / SPEED) | 0;
  ensureRows(s);
  const keepFrom = (startRow - 8) * ROW_U, runwayTo = (startRow + 40) * ROW_U;
  s.ents = s.ents.filter((e) => e.y >= keepFrom && (e.y > runwayTo || e.k === K.FUEL || e.k === K.CRATE));
  s.px = laneAt(s, startRow) * U;
  s.hist.fill(s.px);
  s.stage = stageAtRow(startRow); s.seg = segAtRow(startRow);
  return s;
}
