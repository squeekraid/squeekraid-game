// Input log v3 and the replay driver. A log holds three ordered streams:
//   inputs: [frame, mask]                        control mask (L, R, FIRE) from the step that starts at `frame`
//   gear:   [frame, slot, seq]                   committed Gear activation applied on the step that starts at `frame`
//   spawns: [frame, spawnId, kind, xPx, row]     injected reward spawn, before the step that starts at `frame`
// `frame` is the number of steps already taken, as in v2. Replays take explicit bounds: there is no
// default frame cap, so segment jobs decide how far each run goes.
import { create, inject, step, causeName, distanceRows, type FlightParamsV3, type RouteV3, type SimEvent, type StateV3 } from './sim.ts';

export interface FlightLogV3 {
  readonly inputs: readonly (readonly [number, number])[];
  readonly gear: readonly (readonly [number, number, number])[];
  readonly spawns: readonly (readonly [number, number, number, number, number])[];
}
export const EMPTY_LOG: FlightLogV3 = { inputs: [], gear: [], spawns: [] };

export class LogError extends Error {}

/** Structural checks: ordered frames, valid masks and slots, one activation per seq. */
export function validateLog(log: FlightLogV3): void {
  let f = -1;
  for (const [fr, m] of log.inputs) {
    if (!Number.isInteger(fr) || fr < f || fr < 0) throw new LogError('inputs: frames must be non-decreasing integers');
    if (!Number.isInteger(m) || m < 0 || m > 7) throw new LogError('inputs: mask must be 0..7');
    f = fr;
  }
  f = -1;
  const seqs = new Set<number>();
  for (const [fr, slot, seq] of log.gear) {
    if (!Number.isInteger(fr) || fr < f || fr < 0) throw new LogError('gear: frames must be non-decreasing integers');
    if (slot !== 0 && slot !== 1 && slot !== 2) throw new LogError('gear: slot must be 0, 1 or 2');
    if (seqs.has(seq)) throw new LogError('gear: an activation seq appears twice');
    seqs.add(seq);
    f = fr;
  }
  f = -1;
  for (const sp of log.spawns) {
    if (!Number.isInteger(sp[0]) || sp[0] < f || sp[0] < 0) throw new LogError('spawns: frames must be non-decreasing integers');
    f = sp[0];
  }
}

export interface RunResult {
  readonly frame: number;
  readonly dead: boolean;
  readonly cause: string;
  readonly distanceRows: number;
  readonly camY: number;
  readonly hash: number;
}

/**
 * Run `s` forward with the log until it dies or reaches `toFrame` (exclusive of steps at `toFrame`).
 * Cursor positions are derived from s.frame, so a run can start from any restored state.
 */
export function runTo(s: StateV3, log: FlightLogV3, toFrame: number, onEvents?: (ev: SimEvent[], s: StateV3) => void): RunResult {
  const ins = log.inputs, gear = log.gear, sp = log.spawns;
  let ip = 0, mask = 0;
  while (ip < ins.length && ins[ip]![0] <= s.frame) { mask = ins[ip]![1]; ip++; }
  let ig = 0; while (ig < gear.length && gear[ig]![0] < s.frame) ig++;
  let is = 0; while (is < sp.length && sp[is]![0] < s.frame) is++;
  while (!s.dead && s.frame < toFrame) {
    while (ip < ins.length && ins[ip]![0] <= s.frame) { mask = ins[ip]![1]; ip++; }
    while (is < sp.length && sp[is]![0] === s.frame) { const x = sp[is]!; inject(s, x[1], x[2], x[3], x[4]); is++; }
    let slots = 0;
    while (ig < gear.length && gear[ig]![0] === s.frame) { slots |= 1 << gear[ig]![1]; ig++; }
    const ev = step(s, mask, slots);
    if (onEvents && ev) onEvents(ev, s);
  }
  return { frame: s.frame, dead: s.dead === 1, cause: causeName(s), distanceRows: distanceRows(s), camY: s.camY, hash: s.hash };
}

/** Replay a whole flight from frame 0 up to `maxFrames` (required: no hidden cap). */
export function replay(route: RouteV3, params: FlightParamsV3, log: FlightLogV3, maxFrames: number): RunResult {
  validateLog(log);
  const s = create(route, params);
  return runTo(s, log, maxFrames);
}

/** Records a live flight's log as the client plays (the client sends it in chunks). */
export class LogRecorder {
  readonly inputs: [number, number][] = [];
  readonly gear: [number, number, number][] = [];
  readonly spawns: [number, number, number, number, number][] = [];
  private last = -1;
  /** Call before stepping the frame that starts at `frame`. */
  mask(frame: number, mask: number): void { if (mask !== this.last) { this.inputs.push([frame, mask]); this.last = mask; } }
  gearEdge(frame: number, slot: number, seq: number): void { this.gear.push([frame, slot, seq]); }
  spawn(frame: number, spawnId: number, kind: number, x: number, row: number): void { this.spawns.push([frame, spawnId, kind, x, row]); }
  log(): FlightLogV3 { return { inputs: this.inputs, gear: this.gear, spawns: this.spawns }; }
}
