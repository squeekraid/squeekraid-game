// Canonical byte encoding of a rules-v3 state, and restore from it. The encoding covers the full
// state (scalars, generator, plan, terrain ring, entity table in array order, bullets, history,
// Gear state), in a fixed field order, little-endian. Checkpoint hashes are SHA-256 over these
// bytes; segment verification restarts from them. The route and pinned params are not encoded:
// a flight pins them separately.
import { RING, type Bullet, type Ent, type FlightParamsV3, type Gen, type Planned, type RouteV3, type StateV3, type Zone, slotCodesOf, HIST } from './sim.ts';

const MAGIC = 0x53513303; // "SQ3", format 3
const ENT_FIELDS = 21;

class Writer {
  private buf = new ArrayBuffer(16384);
  private dv = new DataView(this.buf);
  private n = 0;
  private room(k: number): void {
    if (this.n + k <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.n));
    this.buf = nb; this.dv = new DataView(nb);
  }
  i32(v: number): void { this.room(4); this.dv.setInt32(this.n, v | 0, true); this.n += 4; }
  u32(v: number): void { this.room(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; }
  /** Integers that can exceed 32 bits (positions over long flights). */
  f64(v: number): void { this.room(8); this.dv.setFloat64(this.n, v, true); this.n += 8; }
  i16s(a: Int16Array): void { this.room(a.length * 2); for (let i = 0; i < a.length; i++) { this.dv.setInt16(this.n, a[i]!, true); this.n += 2; } }
  i32s(a: Int32Array): void { this.room(a.length * 4); for (let i = 0; i < a.length; i++) { this.dv.setInt32(this.n, a[i]!, true); this.n += 4; } }
  bytes(): Uint8Array { return new Uint8Array(this.buf.slice(0, this.n)); }
}

class Reader {
  private dv: DataView;
  private n = 0;
  constructor(b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  i32(): number { const v = this.dv.getInt32(this.n, true); this.n += 4; return v; }
  u32(): number { const v = this.dv.getUint32(this.n, true); this.n += 4; return v; }
  f64(): number { const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
  i16s(a: Int16Array): void { for (let i = 0; i < a.length; i++) { a[i] = this.dv.getInt16(this.n, true); this.n += 2; } }
  i32s(a: Int32Array): void { for (let i = 0; i < a.length; i++) { a[i] = this.dv.getInt32(this.n, true); this.n += 4; } }
  done(): boolean { return this.n === this.dv.byteLength; }
}

export function encodeState(s: StateV3): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC);
  w.i32(s.frame); w.f64(s.camY); w.i32(s.px); w.i32(s.vx); w.i32(s.fuel); w.i32(s.fireCd);
  w.i32(s.dead); w.i32(s.cause); w.i32(s.deathX); w.f64(s.deathY);
  w.i32(s.genRow); w.i32(s.nextId); w.u32(s.hash); w.i32(s.stage); w.i32(s.seg);
  w.i32(s.kills); w.i32(s.shots); w.i32(s.refuelFrames); w.i32(s.gates); w.i32(s.blocks); w.i32(s.pickups); w.i32(s.depotsLost);
  const gr = s.gear; w.i32(gr.shield); w.i32(gr.grace); w.i32(gr.spread); w.i32(gr.long); w.i32(gr.uses);
  const g = s.gen;
  w.u32(g.rng); w.i32(g.r0); w.i32(g.r1); w.i32(g.c0); w.i32(g.c1); w.i32(g.h0); w.i32(g.h1);
  w.i32(g.islStart); w.i32(g.islLen); w.i32(g.islMax); w.i32(g.lane);
  w.i32(g.nextFuel); w.i32(g.lastFuel); w.i32(g.nextCrate); w.i32(g.quietUntil); w.i32(g.winRow);
  w.i32(g.plan.length); for (const p of g.plan) { w.i32(p.row); w.i32(p.kind); w.i32(p.a); w.i32(p.c); w.i32(p.d); }
  w.i32(g.zones.length); for (const z of g.zones) { w.i32(z.r0); w.i32(z.r1); w.i32(z.x0); w.i32(z.x1); }
  w.i32s(s.slotCodes);
  w.i16s(s.rows);
  w.i32s(s.hist);
  w.i32(s.ents.length);
  for (const e of s.ents) {
    w.i32(e.id); w.i32(e.k); w.i32(e.b); w.i32(e.x); w.f64(e.y); w.i32(e.hw); w.i32(e.hh); w.i32(e.vx); w.i32(e.vy);
    w.i32(e.awake); w.i32(e.moving); w.i32(e.hp); w.i32(e.maxHp); w.i32(e.big); w.i32(e.t); w.i32(e.a); w.i32(e.c);
    w.i32(e.minX); w.i32(e.maxX); w.i32(e.gx); w.i32(e.drops);
  }
  w.i32(s.bullets.length); for (const b of s.bullets) { w.i32(b.x); w.f64(b.y); w.i32(b.vx); w.i32(b.life); }
  return w.bytes();
}

export function decodeState(route: RouteV3, params: FlightParamsV3, bytes: Uint8Array): StateV3 {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error('decodeState: not a rules-v3 state');
  const frame = r.i32(), camY = r.f64(), px = r.i32(), vx = r.i32(), fuel = r.i32(), fireCd = r.i32();
  const dead = r.i32(), cause = r.i32(), deathX = r.i32(), deathY = r.f64();
  const genRow = r.i32(), nextId = r.i32(), hash = r.u32(), stage = r.i32(), seg = r.i32();
  const kills = r.i32(), shots = r.i32(), refuelFrames = r.i32(), gates = r.i32(), blocks = r.i32(), pickups = r.i32(), depotsLost = r.i32();
  const gear = { shield: r.i32(), grace: r.i32(), spread: r.i32(), long: r.i32(), uses: r.i32() };
  const gen: Gen = {
    rng: r.u32(), r0: r.i32(), r1: r.i32(), c0: r.i32(), c1: r.i32(), h0: r.i32(), h1: r.i32(),
    islStart: r.i32(), islLen: r.i32(), islMax: r.i32(), lane: r.i32(),
    nextFuel: r.i32(), lastFuel: r.i32(), nextCrate: r.i32(), quietUntil: r.i32(), winRow: r.i32(), plan: [], zones: [],
  };
  const np = r.i32(); for (let i = 0; i < np; i++) gen.plan.push({ row: r.i32(), kind: r.i32(), a: r.i32(), c: r.i32(), d: r.i32() } satisfies Planned);
  const nz = r.i32(); for (let i = 0; i < nz; i++) gen.zones.push({ r0: r.i32(), r1: r.i32(), x0: r.i32(), x1: r.i32() } satisfies Zone);
  const slotCodes = new Int32Array(3); r.i32s(slotCodes);
  const expected = slotCodesOf(params.loadout);
  for (let i = 0; i < 3; i++) if (slotCodes[i] !== expected[i]) throw new Error('decodeState: loadout does not match the pinned params');
  const rows = new Int16Array(RING * 5); r.i16s(rows);
  const hist = new Int32Array(HIST); r.i32s(hist);
  const ents: Ent[] = [];
  const ne = r.i32();
  for (let i = 0; i < ne; i++) {
    ents.push({
      id: r.i32(), k: r.i32(), b: r.i32(), x: r.i32(), y: r.f64(), hw: r.i32(), hh: r.i32(), vx: r.i32(), vy: r.i32(),
      awake: r.i32(), moving: r.i32(), hp: r.i32(), maxHp: r.i32(), big: r.i32(), t: r.i32(), a: r.i32(), c: r.i32(),
      minX: r.i32(), maxX: r.i32(), gx: r.i32(), drops: r.i32(),
    });
  }
  const bullets: Bullet[] = [];
  const nb = r.i32(); for (let i = 0; i < nb; i++) bullets.push({ x: r.i32(), y: r.f64(), vx: r.i32(), life: r.i32() });
  if (!r.done()) throw new Error('decodeState: trailing bytes');
  return {
    rules: 3, route, params, slotCodes, frame, camY, px, vx, fuel, fireCd, dead, cause, deathX, deathY, rows, genRow, gen,
    ents, bullets, nextId, hist, gear, hash, stage, seg, kills, shots, refuelFrames, gates, blocks, pickups, depotsLost,
  };
}

/** Deep copy through the canonical encoding (used by search and snapshot round-trip tests). */
export function cloneState(s: StateV3): StateV3 { return decodeState(s.route, s.params, encodeState(s)); }

export const ENTITY_FIELD_COUNT = ENT_FIELDS;
