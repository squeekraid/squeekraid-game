// ---------------------------------------------------------------------------
// SqueekSim: deterministic flight simulation (rules v2: art-scale world).
// Integer math only, fixed 60 Hz step, one seeded PRNG used only by the route
// generator. Same route + same input log => same run, on any machine.
// No DOM, no Math.random, no floating point in game state.
// One world pixel = one art pixel. 1 metre = 2 rows = 10 px.
// ---------------------------------------------------------------------------
(function (root) {
  'use strict';

  const RULES = 2;
  const W = 240, H = 400;          // logical screen, px
  const U = 16;                    // sub-units per px
  const ROW_PX = 5, ROW_U = ROW_PX * U;
  const PX_PER_M = 10;
  const SEG_ROWS = 320;            // one half-hour of wheel data = 160 m of river
  const SEG_COUNT = 48;
  const STAGE_ROWS = 2000;         // a new stage every 1000 m
  const GATE_ROWS = 1000;          // a gate every 500 m
  const START_ROWS = 130;          // calm straight start
  const PLAYER_SY = 80;            // player sits 80 px above the bottom edge
  const PLAYER_HW = 5, PLAYER_HH = 7;   // 10 x 14 hitbox
  const FUEL_MAX = 6000, FUEL_DRAIN = 4, FUEL_FILL = 150;
  const SPD_MIN = 30, SPD_CRUISE = 45, SPD_MAX = 80, SPD_ACC = 3;
  const STEER_MAX = 50, STEER_ACC = 12;
  const BULLET_REL = 120, BULLET_MAX = 3, FIRE_CD = 9;
  const RING = 1024;
  const AHEAD_ROWS = 110;

  const K = { BOAT: 1, DRONE: 2, JET: 3, ROCK: 4, MINE: 5, FUEL: 6, GATE: 7, CRATE: 8 };
  const KIND_NAME = ['', 'boat', 'drone', 'jet', 'rock', 'mine', 'fuel', 'gate', 'crate'];
  const SIZE = { 1: [10, 4], 2: [7, 5], 3: [9, 4], 4: [8, 5], 5: [5, 5], 6: [8, 13], 7: [0, 5], 8: [7, 7] }; // half w/h px
  const IN = { L: 1, R: 2, UP: 4, DN: 8, FIRE: 16 };

  const STAGES = ['Meadow Run', 'Dune Canyon', 'Frost Valley', 'Night Marsh', 'Ember Gorge'];

  // ---------- helpers ----------
  function next(g) { // mulberry32
    let t = (g.rng = (g.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  function rint(g, n) { return n <= 1 ? 0 : next(g) % n; }
  function fnv(h, v) { return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0; }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); return h >>> 0; }

  // Difficulty, per-mille. Depends on distance only, identical on every route, never flattens.
  function dAtRow(r) { return 1000 + ((r / 3) | 0); }         // +1.0 every 1.5 km
  function stageAtRow(r) { return 1 + ((r / STAGE_ROWS) | 0); }
  function segAtRow(r) { return ((r / SEG_ROWS) | 0) % SEG_COUNT; }
  function wAtRow(route, r) { const v = route.w[segAtRow(r)]; return v < 0 ? 0 : v; }

  function fuelSpacingRows(d) { return 2 * (120 + (((d - 1000) * 9 / 100) | 0)); }   // metres*2
  function enemyGapRows(d, w) {
    let base = (80000 / d) | 0; if (base < 16) base = 16;
    return (base * (800 + ((w * 6 / 10) | 0)) / 1000) | 0;                       // calm river: denser enemies; canyon: fewer
  }
  function baseHalfWidth(d) { let b = 95 - (((d - 1000) / 48) | 0); return b < 45 ? 45 : b; }

  // ---------- creation ----------
  function create(route) {
    const s = {
      route,
      frame: 0, camY: 0, speed: SPD_CRUISE,
      px: (W / 2) * U, vx: 0,
      fuel: FUEL_MAX, fireCd: 0,
      dead: false, cause: '', deathX: 0, deathY: 0,
      rows: new Int16Array(RING * 4), genRow: 0,
      gen: {
        rng: route.seed >>> 0,
        r0: 0, r1: START_ROWS, c0: W / 2, c1: W / 2, h0: 95, h1: 95,
        isl: null, nextFuel: 180, nextEnemy: 170, nextJet: 0, nextCrate: 0, quietUntil: 0
      },
      ents: [], bullets: [],
      inputs: [], lastMask: -1,
      hash: 2166136261, stage: 1, seg: -1,
      kills: 0, shots: 0, refuelFrames: 0, gates: 0, blocks: 0
    };
    ensureRows(s);
    return s;
  }

  // ---------- terrain ----------
  function rowData(s, r) {
    const i = (((r % RING) + RING) % RING) * 4, a = s.rows;
    return [a[i], a[i + 1], a[i + 2], a[i + 3]];
  }
  function waterAt(s, r, x0, x1) { // px range inside water?
    const i = (((r % RING) + RING) % RING) * 4, a = s.rows;
    if (x0 < a[i] || x1 > a[i + 1]) return false;
    if (a[i + 3] > a[i + 2] && x1 > a[i + 2] && x0 < a[i + 3]) return false;
    return true;
  }

  function ensureRows(s) {
    const need = ((s.camY / ROW_U) | 0) + AHEAD_ROWS;
    while (s.genRow <= need) genRow(s);
  }

  function nextGateRow(r) { return (((r / GATE_ROWS) | 0) + 1) * GATE_ROWS; }

  function genRow(s) {
    const g = s.gen, r = s.genRow, route = s.route;
    const d = dAtRow(r), w = wAtRow(route, r), stage = stageAtRow(r);

    if (r >= g.r1) {
      g.r0 = g.r1; g.c0 = g.c1; g.h0 = g.h1;
      const interval = 48 - ((w * 24 / 1000) | 0);           // canyon bends come faster
      g.r1 = g.r0 + interval;
      const base = baseHalfWidth(d);
      let h = (base * (1000 - ((w * 300 / 1000) | 0)) / 1000) | 0;
      h += rint(g, 15) - 7;
      const maxDh = (interval * 5 / 8) | 0;                   // width changes stay followable
      if (h > g.h0 + maxDh) h = g.h0 + maxDh;
      if (h < g.h0 - maxDh) h = g.h0 - maxDh;
      if (h < 30) h = 30; if (h > 100) h = 100;
      const amp = 17 + ((w * 42 / 1000) | 0);
      let c = W / 2 + rint(g, amp * 2 + 1) - amp;
      const maxDc = (interval * 5 / 4) | 0;                   // bends average <= 0.25 px sideways per px forward
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
    if (l < 8) l = 8; if (rr > W - 8) rr = W - 8;

    // islands: only on calm (sleeping) stretches of wide river
    let il = 0, ir = 0;
    if (!g.isl && r > 220 && w < 400 && h >= 65 && rint(g, 1000) < 6) {
      const len = 70 + rint(g, 90);
      if (r + len + 40 < nextGateRow(r) && (r % GATE_ROWS) > 40) g.isl = { start: r, len, max: 12 + rint(g, 18) };
    }
    if (g.isl) {
      const k = r - g.isl.start, ramp = 24;
      if (k >= g.isl.len) g.isl = null;
      else {
        let env = k < ramp ? ((k * 256) / ramp) | 0 : (k > g.isl.len - ramp ? (((g.isl.len - k) * 256) / ramp) | 0 : 256);
        env = (env * env * (768 - 2 * env)) >> 16;
        let ih = (g.isl.max * env) >> 8;
        if (ih > h - 30) ih = h - 30;
        if (ih >= 4) { il = c - ih; ir = c + ih; }
      }
    }
    const i = (r % RING) * 4;
    s.rows[i] = l; s.rows[i + 1] = rr; s.rows[i + 2] = il; s.rows[i + 3] = ir;

    spawnAt(s, r, d, w, stage);
    s.genRow++;
  }

  function placeX(s, r, hw) { // pick an x (px) in open water for an object of half-width hw
    const g = s.gen, [l, rr, il, ir] = rowData(s, r);
    const ch = [];
    if (ir > il) { ch.push([l + hw + 3, il - hw - 3]); ch.push([ir + hw + 3, rr - hw - 3]); }
    else ch.push([l + hw + 3, rr - hw - 3]);
    const ok = ch.filter(c => c[1] >= c[0]);
    if (!ok.length) return -1;
    const c = ok[rint(g, ok.length)];
    return c[0] + rint(g, c[1] - c[0] + 1);
  }

  function addEnt(s, kind, x, r, extra) {
    const e = { k: kind, x: x * U, y: r * ROW_U, hw: SIZE[kind][0], hh: SIZE[kind][1], vx: 0, moving: 0, awake: 0, hp: 1, maxHp: 1, id: s.ents.length + s.genRow * 8 };
    if (extra) Object.assign(e, extra);
    s.ents.push(e);
    return e;
  }

  function spawnAt(s, r, d, w, stage) {
    const g = s.gen;
    if (r < START_ROWS + 20) return;

    if (r % GATE_ROWS === 0) {
      const big = r % STAGE_ROWS === 0;
      const hp = big ? 2 + ((stage / 3) | 0) : 1;
      addEnt(s, K.GATE, W / 2, r, { hp, maxHp: hp, big: big ? 1 : 0 });
      g.quietUntil = r + 24;
      return;
    }
    if (r < g.quietUntil || nextGateRow(r) - r < 24) return;

    let used = false;
    // Block Crates: only on stretches where Squeektoshi was really running
    if (s.route.crates && w > 0 && r >= g.nextCrate) {
      const x = placeX(s, r, 8);
      if (x >= 0) {
        addEnt(s, K.CRATE, x, r);
        g.nextCrate = r + 150 - ((w * 70 / 1000) | 0) + rint(g, 40);
        used = true;
      }
    }
    if (!used && r >= g.nextFuel) {
      const x = placeX(s, r, 9);
      if (x >= 0) {
        addEnt(s, K.FUEL, x, r);
        const sp = fuelSpacingRows(d);
        g.nextFuel = r + sp + rint(g, (sp / 4) | 0) - ((sp / 8) | 0);
        used = true;
      }
    }
    if (!used && r >= g.nextEnemy) {
      // weights by stage: boat, drone, rock, mine
      let wb = 60, wd = 40, wr = 0, wm = 0;
      if (stage >= 2) { wb = 45; wd = 35; wr = 20; }
      if (stage >= 3) { wb = 38; wd = 37; wr = 15; }
      if (stage >= 4) { wb = 30; wd = 30; wr = 15; wm = 25; }
      if (w > 600) wr = (wr / 2) | 0;                       // fewer rocks in tight canyon bends
      const tot = wb + wd + wr + wm;
      let pick = rint(g, tot), kind;
      if ((pick -= wb) < 0) kind = K.BOAT;
      else if ((pick -= wd) < 0) kind = K.DRONE;
      else if ((pick -= wr) < 0) kind = K.ROCK;
      else kind = K.MINE;

      const hw = SIZE[kind][0];
      let x = placeX(s, r, hw);
      if (x >= 0 && kind === K.ROCK) {
        const [l, rr, il, ir] = rowData(s, r);
        const leftGap = (ir > il && x > ir) ? (x - hw) - ir : (x - hw) - l;
        const rightGap = (ir > il && x < il) ? il - (x + hw) : rr - (x + hw);
        if (leftGap < 28 && rightGap < 28) kind = K.BOAT;     // never wall off the river
      }
      if (x >= 0) {
        let extra = null;
        if (kind === K.BOAT) {
          const moving = rint(g, 1000) < 350 + Math.min(400, ((d - 1000) / 5) | 0) ? 1 : 0;
          const sp = Math.min(60, (25 * d / 2000) | 0);
          extra = { moving, vx: rint(g, 2) ? sp : -sp };
        } else if (kind === K.DRONE) {
          const sp = Math.min(80, (45 * d / 2000) | 0);
          extra = { moving: 1, vx: rint(g, 2) ? sp : -sp };
        } else if (kind === K.MINE) {
          extra = { phase: rint(g, 60) };
        }
        addEnt(s, kind, x, r, extra);
        const gap = enemyGapRows(d, w);
        g.nextEnemy = r + gap + rint(g, ((gap / 2) | 0) + 1) - ((gap / 4) | 0);
        if (g.nextEnemy <= r + 8) g.nextEnemy = r + 8;
      }
    }
    if (stage >= 3 && r >= g.nextJet) {
      if (g.nextJet === 0) g.nextJet = r + 60;
      else {
        const side = rint(g, 2);
        const sp = Math.min(140, 50 + (((d - 1000) / 40) | 0));
        addEnt(s, K.JET, side ? W + 15 : -15, r, { moving: 1, vx: side ? -sp : sp });
        let gap = (400000 / d) | 0; if (gap < 120) gap = 120;
        g.nextJet = r + gap + rint(g, (gap / 2) | 0);
      }
    }
  }

  // ---------- step ----------
  function step(s, mask) {
    if (s.dead) return null;
    const ev = [];
    if (mask !== s.lastMask) { s.inputs.push([s.frame, mask]); s.lastMask = mask; }
    s.frame++;

    // throttle
    const target = (mask & IN.UP) ? SPD_MAX : (mask & IN.DN) ? SPD_MIN : SPD_CRUISE;
    if (s.speed < target) s.speed = Math.min(target, s.speed + SPD_ACC);
    else if (s.speed > target) s.speed = Math.max(target, s.speed - SPD_ACC);
    s.camY += s.speed;

    // steering
    const want = ((mask & IN.R) ? STEER_MAX : 0) - ((mask & IN.L) ? STEER_MAX : 0);
    if (s.vx < want) s.vx = Math.min(want, s.vx + STEER_ACC);
    else if (s.vx > want) s.vx = Math.max(want, s.vx - STEER_ACC);
    s.px += s.vx;
    if (s.px < 0) s.px = 0; if (s.px > W * U) s.px = W * U;

    ensureRows(s);
    const py = s.camY + PLAYER_SY * U;

    // fire
    if (s.fireCd > 0) s.fireCd--;
    if ((mask & IN.FIRE) && s.fireCd === 0 && s.bullets.length < BULLET_MAX) {
      s.bullets.push({ x: s.px, y: py + 8 * U });
      s.fireCd = FIRE_CD; s.shots++;
      ev.push({ t: 'shot' });
    }

    // bullets
    const top = s.camY + (H + 10) * U;
    for (let bi = s.bullets.length - 1; bi >= 0; bi--) {
      const b = s.bullets[bi];
      b.y += s.speed + BULLET_REL;
      let hit = false;
      if (b.y > top) { s.bullets.splice(bi, 1); continue; }
      for (let ei = 0; ei < s.ents.length; ei++) {
        const e = s.ents[ei];
        if (e.y > top || e.k === K.CRATE) continue;
        if (Math.abs(b.y - e.y) >= (e.hh + 4) * U) continue;
        if (e.k === K.GATE) {
          const [l, rr] = rowData(s, (e.y / ROW_U) | 0);
          if (b.x < l * U || b.x > rr * U) continue;
          e.hp--;
          if (e.hp <= 0) { ev.push({ t: 'gate', x: e.x, y: e.y, broken: 1, big: e.big }); s.ents.splice(ei, 1); s.gates++; }
          else ev.push({ t: 'gate', x: b.x, y: e.y, broken: 0 });
          hit = true; break;
        }
        if (Math.abs(b.x - e.x) >= (e.hw + 1) * U) continue;
        if (e.k === K.ROCK) { ev.push({ t: 'clink', x: b.x, y: b.y }); hit = true; break; }
        ev.push({ t: e.k === K.FUEL ? 'fuelLost' : 'kill', kind: e.k, x: e.x, y: e.y });
        if (e.k !== K.FUEL) s.kills++;
        s.ents.splice(ei, 1);
        hit = true; break;
      }
      if (hit) s.bullets.splice(bi, 1);
    }

    // entities
    const bottom = s.camY - 50 * U;
    for (let ei = s.ents.length - 1; ei >= 0; ei--) {
      const e = s.ents[ei];
      if (e.y < bottom) { s.ents.splice(ei, 1); continue; }
      if (e.y > s.camY + (H + 50) * U) continue;
      const ahead = e.y - py;
      if (!e.awake && ahead < (e.k === K.JET ? 250 : 212) * U) e.awake = 1;
      if (!e.awake || !e.moving) continue;
      if (e.k === K.JET) {
        e.x += e.vx;
        if (e.x < -30 * U || e.x > (W + 30) * U) s.ents.splice(ei, 1);
        continue;
      }
      const nx = e.x + e.vx, r = (e.y / ROW_U) | 0;
      if (!waterAt(s, r, ((nx / U) | 0) - e.hw, ((nx / U) | 0) + e.hw)) e.vx = -e.vx;
      else e.x = nx;
    }

    // fuel
    s.fuel -= FUEL_DRAIN;

    // player collisions
    const x0 = s.px - PLAYER_HW * U, x1 = s.px + PLAYER_HW * U;
    const r0 = ((py - PLAYER_HH * U) / ROW_U) | 0, r1 = ((py + PLAYER_HH * U) / ROW_U) | 0;
    let crash = '';
    for (let r = r0; r <= r1 && !crash; r++) {
      const [l, rr, il, ir] = rowData(s, r);
      if (x0 < l * U || x1 > rr * U) crash = 'bank';
      else if (ir > il && x1 > il * U && x0 < ir * U) crash = 'bank';
    }
    let refuel = false;
    for (let ei = 0; ei < s.ents.length && !crash; ei++) {
      const e = s.ents[ei];
      if (Math.abs(e.y - py) >= (e.hh + PLAYER_HH - 1) * U) continue;
      if (e.k === K.GATE) { crash = 'gate'; break; }
      if (Math.abs(e.x - s.px) >= (e.hw + PLAYER_HW - 1) * U) continue;
      if (e.k === K.FUEL) { refuel = true; continue; }
      if (e.k === K.CRATE) {
        s.blocks++;
        ev.push({ t: 'crate', x: e.x, y: e.y });
        s.ents.splice(ei, 1); ei--;
        continue;
      }
      crash = KIND_NAME[e.k];
    }
    if (refuel && !crash) {
      s.fuel = Math.min(FUEL_MAX, s.fuel + FUEL_FILL);
      s.refuelFrames++;
      ev.push({ t: 'refuel' });
    }
    if (!crash && s.fuel <= 0) { s.fuel = 0; crash = 'fuel'; }

    // progress events
    const prow = (py / ROW_U) | 0;
    const seg = segAtRow(prow), st = stageAtRow(prow);
    if (seg !== s.seg) { ev.push({ t: 'seg', seg, prev: s.seg }); s.seg = seg; }
    if (st !== s.stage) { ev.push({ t: 'stage', n: st }); s.stage = st; }

    if (crash) {
      s.dead = true; s.cause = crash; s.deathX = s.px; s.deathY = py;
      ev.push({ t: 'death', cause: crash });
    }

    let h = s.hash;
    h = fnv(h, s.camY); h = fnv(h, s.px); h = fnv(h, s.fuel); h = fnv(h, s.ents.length); h = fnv(h, s.bullets.length); h = fnv(h, s.blocks);
    if (s.dead) h = fnv(fnv(h, s.gen.rng), crash.length * 131 + crash.charCodeAt(0));
    s.hash = h;
    return ev;
  }

  // ---------- info ----------
  function distanceM(s) { return s.camY / (U * PX_PER_M); }   // float only for display
  function info(s) {
    const py = s.camY + PLAYER_SY * U, r = (py / ROW_U) | 0, d = dAtRow(r), w = wAtRow(s.route, r);
    return {
      m: distanceM(s), d, w, seg: segAtRow(r), stage: stageAtRow(r),
      fuelPct: s.fuel / FUEL_MAX, speedMs: s.speed * 60 / (U * PX_PER_M),
      fuelSpacingM: fuelSpacingRows(d) / 2, enemyGapM: enemyGapRows(d, w) / 2, halfWidth: baseHalfWidth(d)
    };
  }

  // Re-simulate a run from its input log; this is what a server would do.
  function replay(route, inputs, maxFrames) {
    const s = create(route);
    let p = 0, mask = 0;
    const limit = maxFrames || 60 * 60 * 60 * 6;
    while (!s.dead && s.frame < limit) {
      while (p < inputs.length && inputs[p][0] <= s.frame) { mask = inputs[p][1]; p++; }
      step(s, mask);
    }
    return { frames: s.frame, camY: s.camY, hash: s.hash, cause: s.cause, dead: s.dead, blocks: s.blocks };
  }

  function generateTo(s, r) { while (s.genRow <= r) genRow(s); }

  const api = {
    RULES, W, H, U, ROW_PX, ROW_U, PX_PER_M, SEG_ROWS, SEG_COUNT, STAGE_ROWS, GATE_ROWS, PLAYER_SY, FUEL_MAX,
    K, KIND_NAME, IN, STAGES,
    create, step, replay, rowData, info, distanceM, hashStr, dAtRow, stageAtRow, segAtRow, wAtRow, generateTo
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SqueekSim = api;
})(this);
