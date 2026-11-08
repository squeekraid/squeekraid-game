// Types for the frozen rules-v2 simulation in sim.v2.cjs. The JavaScript file is the
// source of truth and must not change: its SHA-256 is pinned in test/frozen.test.ts.

/** A route as the v2 sim expects it: 48 half-hour wheel buckets scaled to 0..1000, -1 for missing. */
export interface RouteV2 {
  readonly id: string;
  /** Route RNG seed, unsigned 32-bit. */
  readonly seed: number;
  /** 48 bucket values, 0..1000, or -1 for a missing bucket. */
  readonly w: ArrayLike<number>;
  /** Whether the route places supply crates (prototype feature). */
  readonly crates: boolean;
}

/** One change of the control mask: [frame, mask]. Masks use the v2 bits L=1, R=2, UP=4, DN=8, FIRE=16. */
export type InputChangeV2 = readonly [frame: number, mask: number];

export interface ReplayResultV2 {
  readonly frames: number;
  readonly camY: number;
  readonly hash: number;
  readonly cause: string;
  readonly dead: boolean;
  readonly blocks: number;
}

/** Opaque mutable sim state. Only the fields the platform reads are typed. */
export interface StateV2 {
  readonly frame: number;
  readonly camY: number;
  readonly dead: boolean;
  readonly cause: string;
  readonly hash: number;
  readonly inputs: InputChangeV2[];
}

export interface SimV2 {
  readonly RULES: 2;
  readonly W: number;
  readonly H: number;
  readonly U: number;
  readonly PX_PER_M: number;
  readonly IN: { readonly L: 1; readonly R: 2; readonly UP: 4; readonly DN: 8; readonly FIRE: 16 };
  create(route: RouteV2): StateV2;
  step(state: StateV2, mask: number): unknown[];
  replay(route: RouteV2, inputs: readonly InputChangeV2[], maxFrames?: number): ReplayResultV2;
  hashStr(s: string): number;
  distanceM(state: StateV2): number;
}
