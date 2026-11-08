// Squeektoshi Airways client on sim rules v3. Ported from the prototype (apps/prototype, kept
// unchanged on rules v2): same art, river and feel, with fixed speed, Gear, the new enemy
// behaviours, the 20 s Pause budget and a catch-up loop that keeps game time real on slow devices.
import * as S from '@sqk/sim/v3';
import { allRoutes, type RouteInfo } from '@sqk/routes';
import { PracticeSession, type Session, type SlotView } from './session.ts';
import { ActiveFlightError, detectBackend, devGrant, invalidateFlight, liveStream, OnlineSession, player, type Backend, type DailyRouteView } from './net.ts';
import { Hangar, avatarImg } from './hangar.ts';
import { bankDetail, waterGlint, Weather, type Biome } from './scenery.ts';
import { keyMaps, keyName, loadLocal, renderSettings, saveLocal, type Settings } from './settings.ts';

declare const ART: {
  src: string;
  s: Record<string, [number, number, number, number]>;
  tiles: { bank: [number, number, number, number]; water: [number, number, number, number]; deep: [number, number, number, number] }[];
  biomes: Biome[];
};

const { W, H, U, ROW_PX } = S;
const STEP_MS = 1000 / 60;
const CATCH_UP_MS = 2000;
function $(id: string): HTMLElement { const el = document.getElementById(id); if (!el) throw new Error('missing #' + id); return el; }
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown): void { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const fmtInt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const km = (m: number) => (m / 1000).toFixed(2);
const ROUTES: RouteInfo[] = allRoutes();
const GEAR_LABEL: Record<S.GearKind, string> = { shield: 'Bubble Shield', spread: 'Spread Shot', seed: 'Seed Tank', long: 'Long Barrel' };
let GEAR_KEYS = ['Z', 'X', 'C'];
/** The public Builder Preview build: practice only, and it says so. */
const PREVIEW = !!(window as unknown as { SQK_PREVIEW?: boolean }).SQK_PREVIEW;
/** Set by the website build: the site's home link and the project's X profile (when configured). */
const HOME_URL = (window as unknown as { SQK_HOME?: string }).SQK_HOME ?? null;
const FOLLOW_X = (window as unknown as { SQK_FOLLOW_X?: string }).SQK_FOLLOW_X ?? null;
if (PREVIEW) document.body.classList.add('preview');
const GEAR_ICON: Record<S.GearKind, string> = {
  shield: '<circle cx="8" cy="8" r="6"/><path d="M5.5 6.5a3 3 0 0 1 3-2"/>',
  spread: '<path d="M8 14V3M8 14L3 5M8 14l5-9"/>',
  seed: '<path d="M8 2c3 4 4.5 6 4.5 8a4.5 4.5 0 0 1-9 0C3.5 8 5 6 8 2z"/>',
  long: '<path d="M8 15V1M5 4h6M6 11h4"/>',
};

// ======================= run log (this browser) =======================
interface RunEntry { r: string; m: number; st: number; c: string; f: number; k: number; b: number; t: number; mode: string }
const LOG_KEY = 'sqa.v3.runs';
const getLog = () => store.get<RunEntry[]>(LOG_KEY, []);
function logRun(e: RunEntry): void { const l = getLog(); l.push(e); while (l.length > 400) l.shift(); store.set(LOG_KEY, l); }
function bestFor(id: string): number { let b = 0; for (const e of getLog()) if (e.r === id && e.m > b) b = e.m; return b; }
function statsFor(id: string): { n: number; best: number; median: number } | null {
  const ms = getLog().filter((e) => e.r === id).map((e) => e.m).sort((a, b) => a - b);
  if (!ms.length) return null;
  const mid = ms.length >> 1;
  return { n: ms.length, best: ms[ms.length - 1]!, median: ms.length % 2 ? ms[mid]! : Math.round((ms[mid - 1]! + ms[mid]!) / 2) };
}

// ======================= art =======================
const cv = $('game') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
ctx.imageSmoothingEnabled = false;
const atlas = new Image();
let artReady = false;
interface Pat { bank: CanvasPattern; water: CanvasPattern; deep: CanvasPattern; shallow: CanvasPattern; b: (typeof ART.biomes)[number] }
const PAT: Pat[] = [];
let gatePat: CanvasPattern | null = null;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const stageName = (n: number) => S.STAGES[(n - 1) % 5]! + (n > 5 ? ' ' + (ROMAN[Math.min(10, Math.ceil(n / 5))] ?? '') : '');
const DECO = [['tree', 'tree', 'tree'], ['cactus', 'cactus', 'boulder'], ['pine', 'pine', 'pine'], ['reeds', 'reeds', 'reeds'], ['ember', 'ember', 'ember']];

function tilePattern(r: [number, number, number, number]): CanvasPattern {
  const c = document.createElement('canvas');
  c.width = r[2]; c.height = r[3];
  c.getContext('2d')!.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3]);
  return ctx.createPattern(c, 'repeat')!;
}
function buildPatterns(): void {
  ART.tiles.forEach((t, i) => {
    const b = ART.biomes[i]!;
    const sh = document.createElement('canvas');
    sh.width = 2; sh.height = 2;
    const x = sh.getContext('2d')!;
    x.fillStyle = b.water; x.fillRect(0, 0, 2, 2);
    x.fillStyle = b.wlight; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1);
    PAT[i] = { bank: tilePattern(t.bank), water: tilePattern(t.water), deep: tilePattern(t.deep), shallow: ctx.createPattern(sh, 'repeat')!, b };
  });
  gatePat = tilePattern(ART.s.gate_tile!);
}
function spr(name: string, x: number, y: number, flip = false): void {
  const r = ART.s[name];
  if (!r || !artReady) return;
  x = Math.round(x); y = Math.round(y);
  if (flip) { ctx.save(); ctx.translate(x + r[2], y); ctx.scale(-1, 1); ctx.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3]); ctx.restore(); }
  else ctx.drawImage(atlas, r[0], r[1], r[2], r[3], x, y, r[2], r[3]);
}
function sprC(name: string, cx: number, cy: number, flip = false): void { const r = ART.s[name]; if (r) spr(name, cx - r[2] / 2, cy - r[3] / 2, flip); }
/** Mystery Box capsule (reward spawn): a 14 px gift box with a ribbon, a question mark and a glint. */
const BOX_PX = [
  '..oooooooooo..',
  '.oLLLLRRLLLLo.',
  '.oLLLLRRLLLLo.',
  'oooooooooooooo',
  'oGGGGGRRGGGGGo',
  'oGGGqqRRqqGGGo',
  'oGGqGGRRGGqGGo',
  'oGGGGGRRGqGGGo',
  'oGGGGGRRqGGGGo',
  'oDDDDDRRDDDDDo',
  'oDDDDDRRqDDDDo',
  'oDDDDDRRDDDDDo',
  'oDDDDDRRDDDDDo',
  'oooooooooooooo',
];
const BOX_COL: Record<string, string> = { o: '#3a2340', L: '#ffe08a', G: '#f6c445', D: '#d99a2b', R: '#b04ad8', q: '#fff6c9' };
/** Live Drop capsule: the same look for every tier (the tier is revealed after verification). */
function drawCapsule(cx: number, cy: number, t: number): void {
  const x0 = Math.round(cx - 5), y0 = Math.round(cy - 7);
  const glow = ((t >> 2) & 7) < 4 ? '#d4ff4a' : '#a9d63a';
  for (let y = 0; y < 14; y++) for (let x = 0; x < 10; x++) {
    const edge = (y === 0 || y === 13) ? x > 2 && x < 7 : (y === 1 || y === 12) ? x > 0 && x < 9 : true;
    if (!edge) continue;
    const outline = x === 0 || x === 9 || y === 0 || y === 13 || ((y === 1 || y === 12) && (x === 1 || x === 8));
    ctx.fillStyle = outline ? '#1b1530' : y === 6 || y === 7 ? '#1b1530' : y < 6 ? glow : '#4f7cff';
    ctx.fillRect(x0 + x, y0 + y, 1, 1);
  }
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x0 + 2, y0 + 3, 1, 2);
}
function drawBox(cx: number, cy: number, t: number): void {
  const x0 = Math.round(cx - 7), y0 = Math.round(cy - 7);
  for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
    const c = BOX_PX[y]![x]!;
    if (c === '.') continue;
    ctx.fillStyle = BOX_COL[c]!; ctx.fillRect(x0 + x, y0 + y, 1, 1);
  }
  const k = (t >> 3) % 4, gx = k & 1 ? 9 : -9, gy = k & 2 ? 8 : -8;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(cx + gx), Math.round(cy + gy), 1, 1);
  ctx.fillStyle = '#e9c7ff';
  ctx.fillRect(Math.round(cx + gx) - 1, Math.round(cy + gy), 1, 1); ctx.fillRect(Math.round(cx + gx) + 1, Math.round(cy + gy), 1, 1);
  ctx.fillRect(Math.round(cx + gx), Math.round(cy + gy) - 1, 1, 1); ctx.fillRect(Math.round(cx + gx), Math.round(cy + gy) + 1, 1, 1);
}
function shadowC(name: string, cx: number, cy: number, flip = false): void { ctx.globalAlpha = 0.28; sprC(name, cx + 5, cy + 8, flip); ctx.globalAlpha = 1; }
const rowHash = (r: number) => { let h = Math.imul(r ^ 0x9e3779b9, 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; return (h ^ (h >>> 13)) >>> 0; };
function biomeAt(r: number): number {
  const st = S.stageAtRow(r), k = r % S.STAGE_ROWS, cur = (st - 1) % 5;
  if (st > 1 && k < 48 && (rowHash(r) % 48) >= k) return (cur + 4) % 5;
  return cur;
}

// ======================= sound =======================
const Snd = {
  ctx: null as AudioContext | null, out: null as GainNode | null, on: store.get('sqa.sound', true),
  engine: null as { o: OscillatorNode; g: GainNode } | null, noiseBuf: null as AudioBuffer | null,
  init(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC(); this.out = this.ctx.createGain(); this.out.gain.value = this.on ? 0.55 : 0; this.out.connect(this.ctx.destination);
      const len = this.ctx.sampleRate; this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  },
  setOn(v: boolean): void { this.on = v; store.set('sqa.sound', v); if (this.out && this.ctx) this.out.gain.setTargetAtTime(v ? 0.55 : 0, this.ctx.currentTime, 0.02); },
  tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (!this.ctx || !this.out) return;
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + dur + 0.03);
  },
  noise(dur: number, vol: number, freq: number, delay = 0): void {
    if (!this.ctx || !this.out || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay, src = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = this.noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out); src.start(t); src.stop(t + dur + 0.03);
  },
  shot() { this.tone('square', 1150, 540, 0.07, 0.07); },
  boom(big: boolean) { this.noise(big ? 0.7 : 0.3, big ? 0.55 : 0.32, big ? 700 : 1400); this.tone('sine', big ? 95 : 150, 38, big ? 0.55 : 0.25, 0.3); },
  clink() { this.tone('square', 1800, 1500, 0.04, 0.05); },
  gateHit() { this.tone('square', 230, 150, 0.09, 0.1); },
  refuel(level: number) { this.tone('triangle', 380 + level * 520, 400 + level * 520, 0.05, 0.06); },
  crate() { [880, 1175, 1568].forEach((f, i) => this.tone('square', f, f, 0.07, 0.06, i * 0.05)); },
  low() { this.tone('square', 680, 680, 0.07, 0.05); },
  stage() { [523, 659, 784, 1046].forEach((f, i) => this.tone('square', f, f, 0.1, 0.06, i * 0.09)); },
  wheel() { [784, 988, 1175].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.08, i * 0.08)); },
  nap() { [659, 523].forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.06, i * 0.12)); },
  gear() { [523, 784, 1046, 1568].forEach((f, i) => this.tone('triangle', f, f * 1.01, 0.09, 0.08, i * 0.04)); },
  arming() { this.tone('sine', 660, 700, 0.05, 0.05); },
  denied() { this.tone('square', 220, 180, 0.12, 0.06); },
  shieldPop() { this.tone('sine', 1400, 300, 0.3, 0.12); this.noise(0.2, 0.15, 3000); },
  warn() { this.tone('square', 990, 990, 0.06, 0.05); this.tone('square', 990, 990, 0.06, 0.05, 0.12); },
  drop() { this.tone('sine', 300, 180, 0.12, 0.06); },
  pop() { this.tone('square', 300, 900, 0.08, 0.09); },
  whistle() { this.tone('sine', 1500, 360, 2.2, 0.06, 0.05); },
  splash() { this.noise(0.6, 0.28, 2600); },
  thud() { this.tone('sine', 120, 50, 0.2, 0.25); },
  ui() { this.tone('square', 660, 880, 0.04, 0.04); },
  takeoff() { [392, 523, 659, 784].forEach((f, i) => this.tone('square', f, f, 0.08, 0.05, i * 0.06)); this.noise(0.4, 0.06, 900, 0.1); },
  tick() { this.tone('square', 1320, 1320, 0.02, 0.025); },
  result(best: boolean) { (best ? [523, 659, 784, 1046, 1318] : [392, 330, 262]).forEach((f, i) => this.tone(best ? 'square' : 'triangle', f, f, best ? 0.12 : 0.16, 0.06, i * (best ? 0.09 : 0.13))); },
  jetPass() { this.noise(0.7, 0.12, 1800); this.tone('sawtooth', 900, 200, 0.6, 0.03); },
  boxShake() { this.tone('square', 180, 220, 0.05, 0.05); },
  boxBurst() { this.noise(0.25, 0.12, 4000); [784, 1046, 1318, 1568].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.07, 0.05 + i * 0.05)); },
  engineStart(): void {
    if (!this.ctx || !this.out || this.engine) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 122; g.gain.value = 0.03; o.connect(g); g.connect(this.out); o.start();
    this.engine = { o, g };
  },
  engineTune(vx: number, low: boolean): void { if (this.engine && this.ctx) this.engine.o.frequency.setTargetAtTime(122 + Math.min(40, Math.abs(vx) * 0.6) - (low ? 18 : 0), this.ctx.currentTime, 0.08); },
  engineStop(): void { if (this.engine) { try { this.engine.o.stop(); } catch { /* already stopped */ } this.engine = null; } },
};

// ======================= input =======================
const keys = new Set<string>();
let settings: Settings = loadLocal();
const b0 = (c: string[]) => (c[0] ? keyName(c[0]) : '·');
let KEYMAP: Record<string, string> = {}, GEARMAP: Record<string, number> = {}, PAUSEKEYS = new Set<string>();
function applySettings(s: Settings): void {
  settings = s; const m = keyMaps(s); KEYMAP = m.steer; GEARMAP = m.gear; PAUSEKEYS = m.pause;
  Snd.setOn(s.sound); document.body.classList.toggle('reduced', s.reducedMotion);
  GEAR_KEYS = [b0(s.bindings.gear1), b0(s.bindings.gear2), b0(s.bindings.gear3)];
  for (let i = 0; i < 3; i++) { const el = document.getElementById('gs' + i)?.querySelector('b'); if (el) el.textContent = GEAR_KEYS[i]!; }
  const b = s.bindings, n = (c: string[]) => c.map(keyName).join(' / ');
  const kh = document.getElementById('keysHelp');
  if (kh && !document.body.classList.contains('touch')) kh.innerHTML = `<span>${n([...b.left, ...b.right])} steer</span><span>${n(b.fire)} fire</span><span>${n([b.gear1[0] ?? '', b.gear2[0] ?? '', b.gear3[0] ?? ''].filter(Boolean))} Gear</span><span>${n(b.pause)} pause</span>`;
}
applySettings(settings);
const touch = { L: false, R: false, F: false };
/** The steering finger, if any: pointer id, anchor (screen x, plane art-px x), current target (art px). */
const steer: { id: number | null; x0: number; plane0: number; target: number; scale: number; dir: number } = { id: null, x0: 0, plane0: 0, target: 0, scale: 1, dir: 0 };
function releaseSteer(): void { steer.id = null; steer.dir = 0; touch.L = touch.R = false; }
/** Steering toward the finger's target with hysteresis: start beyond 3 art px, keep going until within
 *  0.5 px. The plane settles on the finger without flickering left/right every frame (smoother to fly,
 *  and a person's input log does not look like machine chatter). */
function steerMask(): number {
  if (steer.id === null || !sim || mode !== 'play') { steer.dir = 0; return 0; }
  const d = steer.target - sim.px / U;
  if (steer.dir === S.IN.R && d < STOP_PX) steer.dir = 0;
  else if (steer.dir === S.IN.L && d > -STOP_PX) steer.dir = 0;
  if (!steer.dir) steer.dir = d > START_PX ? S.IN.R : d < -START_PX ? S.IN.L : 0;
  return steer.dir;
}
const START_PX = 3, STOP_PX = 0.5;
let testMask: number | ((s: S.StateV3) => number) | null = null;
let testFrozen = false;
function liveMask(): number {
  if (testMask !== null) return typeof testMask === 'function' ? (sim ? testMask(sim) : 0) : testMask;
  let m = 0;
  const sm = steerMask();
  const L = keys.has('L') || touch.L || sm === S.IN.L, R = keys.has('R') || touch.R || sm === S.IN.R;
  if (L && !R) m |= S.IN.L;
  if (R && !L) m |= S.IN.R;
  if (keys.has('F') || touch.F) m |= S.IN.FIRE;
  return m;
}
window.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'TEXTAREA' || tgt.tagName === 'INPUT')) return;
  const k = KEYMAP[e.code];
  if (k && (mode === 'play' || mode === 'replay' || mode === 'dying' || e.code !== 'Space')) { keys.add(k); e.preventDefault(); Snd.init(); }
  const g = GEARMAP[e.code];
  if (g !== undefined && mode === 'play' && !e.repeat) { e.preventDefault(); pressGear(g); }
  if (PAUSEKEYS.has(e.code)) { e.preventDefault(); if (!$('settings').hidden) return; togglePause(); }
  else if (e.code === 'Enter' && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) { e.preventDefault(); onEnter(); }
  else if (e.code === 'Space' && mode === 'dying') skipDeath();
  else if (e.code === 'KeyF' && replay) cycleReplaySpeed();
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
window.addEventListener('blur', () => { keys.clear(); releaseSteer(); touch.F = false; if (mode === 'play') autoPause('blur'); });

function setupTouch(): void {
  const body = document.body;
  const markTouch = () => { if (!body.classList.contains('touch')) { body.classList.add('touch'); $('keysHelp').innerHTML = '<span>Drag on the river to steer</span><span>Hold FIRE with another finger</span><span>Gear buttons on screen</span>'; } };
  try { if (window.matchMedia('(pointer: coarse)').matches) markTouch(); } catch { /* ignore */ }
  window.addEventListener('touchstart', markTouch, { passive: true, once: true });
  // Steering by dragging on the gameplay surface (M8). Relative, not teleporting: the finger's horizontal
  // travel since it touched down sets a target that many art pixels from where the plane was, and the
  // plane steers toward it at its normal speed. Only the input mask changes; flight rules do not.
  const wrap = $('screenWrap');
  const GAIN = 1.15;
  const isControl = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('button, a, input, select, textarea, .gslot, .overlay, #hud .hud-btn, [role="button"]');
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || steer.id !== null || isControl(e.target)) return;
    if (mode !== 'play' || !sim) return;
    const r = wrap.getBoundingClientRect();
    steer.id = e.pointerId; steer.scale = r.width / W; steer.x0 = e.clientX; steer.plane0 = sim.px / U; steer.target = steer.plane0;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    Snd.init(); e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steer.id) return;
    let t = steer.plane0 + ((e.clientX - steer.x0) / steer.scale) * GAIN;
    // past the screen edge, slide the anchor so turning back responds at once
    const lo = 4, hi = W - 4;
    if (t < lo || t > hi) { t = Math.max(lo, Math.min(hi, t)); steer.x0 = e.clientX - ((t - steer.plane0) * steer.scale) / GAIN; }
    steer.target = t;
  });
  const endSteer = (e: PointerEvent) => { if (e.pointerId === steer.id) releaseSteer(); };
  wrap.addEventListener('pointerup', endSteer); wrap.addEventListener('pointercancel', endSteer); wrap.addEventListener('lostpointercapture', endSteer);
  const fire = $('fireBtn');
  const fOn = (e: PointerEvent) => {
    if (mode === 'over') { startRun(lastRun ? lastRun.route : ROUTES[0]!); return; }
    touch.F = true; fire.classList.add('on'); Snd.init(); try { fire.setPointerCapture(e.pointerId); } catch { /* ignore */ } e.preventDefault();
  };
  const fOff = () => { touch.F = false; fire.classList.remove('on'); };
  fire.addEventListener('pointerdown', fOn); fire.addEventListener('pointerup', fOff); fire.addEventListener('pointercancel', fOff);
  fire.addEventListener('contextmenu', (e) => e.preventDefault());
  $('screenWrap').addEventListener('pointerdown', () => { if (mode === 'dying') skipDeath(); });
}

// ======================= layout =======================
function layout(): void {
  const box = $('screenBox'), bw = box.clientWidth, bh = box.clientHeight;
  if (!bw || !bh) return;
  let s = Math.min(bw / W, bh / H);
  if (s >= 2) s = Math.floor(s * 4) / 4;
  const wrap = $('screenWrap');
  wrap.style.width = Math.floor(W * s) + 'px'; wrap.style.height = Math.floor(H * s) + 'px';
  document.documentElement.style.setProperty('--s', s.toFixed(3));
}

// ======================= state =======================
type Mode = 'menu' | 'play' | 'paused' | 'dying' | 'over' | 'replay' | 'ended';
let mode: Mode = 'menu';
let session: Session | null = null;
let sim: S.StateV3 | null = null;
let rec: S.LogRecorder | null = null;
let hangar: Hangar | null = null;
let replay: { log: S.FlightLogV3; of: LastRun; ip: number; ig: number; is: number; mask: number } | null = null;
let lastRun: LastRun | null = null;
let replaySpeed = 1;
let viewCam = 0, acc = 0, lastTs = 0, frameNo = 0;
let attract: S.StateV3 | null = null;
let backend: Backend | null = null;
let playMode: 'practice' | 'online' = store.get<'practice' | 'online'>('sqa.v3.mode', 'practice');
let pauseUsedMs = 0, pauseSince = 0;
/** Practice only: start part-way along the route to evaluate later pressure (not counted as a best). */
let warpKm = PREVIEW ? 0 : store.get<number>('sqa.v3.warp', 0);
const warpRow = (k: number) => k * 2000 + 120; // just past the stage gate
interface LastRun {
  route: RouteInfo; log: S.FlightLogV3; params: S.FlightParamsV3; startRow: number; hash: number; frames: number; camY: number; dist: number; stage: number;
  cause: string; kills: number; gates: number; blocks: number; gearUses: number; prevBest: number; mode: string;
  verdict: string; detail: string; sha: string;
}
interface Part { x: number; y: number; vx: number; vy: number; life: number; max: number; c: string; sz: number }
const fx = {
  parts: [] as Part[], booms: [] as { x: number; y: number; t: number; big: boolean }[], smokes: [] as { x: number; y: number; vx: number; t: number; k: string }[],
  pops: [] as { x: number; y: number; t: number; text: string }[], shake: 0, flash: 0, ring: 0,
  death: null as null | { t: number; x: number; y: number; vy: number; open: number; camV: number; landed: number; water: boolean; quip: string; cx: number; cy: number },
};
const CAUSE: Record<string, string> = { bank: 'Clipped the riverbank', boat: 'Rammed a cat boat', drone: 'Hit a cat drone', jet: 'Hit a cat jet', rock: 'Hit a rock', mine: 'Hit a yarn mine', gate: 'Flew into a gate', fuel: 'Ran out of seeds' };
const QUIP: Record<string, string> = { bank: 'Who moved the river?', boat: 'Cat navy. Again.', drone: 'That drone followed me!', jet: 'Too fast!', rock: 'Rock 1, me 0', mine: 'Saw it. Too late.', gate: 'Should have shot it', fuel: 'Need... seeds...' };

/** Controls and settings sheet. Saved here at once; synced to the account when online. */
let settingsBack: string = 'menu';
function openSettings(from: string): void {
  settingsBack = from;
  showOnly('settings');
  renderSettings($('settings'), settings, (n) => {
    applySettings(n); saveLocal(n); paintSoundBtn();
    if (backend) void player.putSettings(backend, n).catch(() => { /* kept locally; synced next time */ });
  }, () => { showOnly(settingsBack); });
}
let paintSoundBtn: () => void = () => {};
function showOnly(id: string | null): void { for (const o of ['menu', 'pause', 'over', 'hangar', 'conflict', 'settings', 'help', 'account', 'pilot']) $(o).hidden = o !== id; }

/** E6: another flight is in progress. The player decides; nothing ends without their say. */
function askConflict(e: ActiveFlightError, rt: RouteInfo): void {
  const when = e.startedAt ? new Date(e.startedAt).toLocaleTimeString() : 'earlier';
  $('conflictText').textContent = `A flight on ${e.routeId === 'genesis' ? 'Genesis' : e.routeId ?? 'another route'} started at ${when} is still in progress on this account, maybe in another tab or on another device. Ending it forfeits that flight (no record, no rewards).`;
  showOnly('conflict');
  $('conflictEnd').onclick = async () => {
    if (backend && (await invalidateFlight(backend, e.flightId))) { showOnly('menu'); startRunVoid(rt); }
    else showToast('Could not end it', 'Try again in a moment', 2500);
  };
  $('conflictKeep').onclick = () => showOnly('menu');
}

async function startRun(rt: RouteInfo, replayOf?: LastRun): Promise<void> {
  releaseSteer(); // a finger left down from an earlier screen never steers a new flight
  if (replayOf) {
    session = null;
    sim = replayOf.startRow ? S.createAt(rt.route, replayOf.params, replayOf.startRow) : S.create(rt.route, replayOf.params);
    replay = { log: replayOf.log, of: replayOf, ip: 0, ig: 0, is: 0, mask: 0 };
  } else {
    replay = null;
    if (playMode === 'online' && backend) {
      showToast('Starting flight', 'Asking the gateway for a flight…', 2500, true);
      try { session = await OnlineSession.start(backend, rt, rt.kind === 'genesis' ? hangar?.loadout ?? null : null); }
      catch (e) {
        if (e instanceof ActiveFlightError) { askConflict(e, rt); return; }
        showToast('Could not start online', e instanceof TypeError ? 'The flight server cannot be reached. Practice still works.' : (e as Error).message, 3500); return;
      }
    } else session = new PracticeSession(rt);
    const warp = session.mode === 'practice' ? warpKm : 0;
    currentStartRow = warp > 0 ? warpRow(warp) : 0;
    // online flights fly the route the server pinned
    const flown = session.route.route;
    sim = warp > 0 ? S.createAt(flown, session.params, warpRow(warp)) : S.create(flown, session.params);
    rec = new S.LogRecorder();
  }
  viewCam = 0; acc = 0; lastTs = 0; pauseUsedMs = 0;
  fx.parts.length = 0; fx.booms.length = 0; fx.smokes.length = 0; fx.pops.length = 0; fx.death = null; fx.shake = 0; fx.flash = 0;
  replaySpeed = 1;
  mode = replay ? 'replay' : 'play';
  showOnly(null);
  $('hud').hidden = false;
  $('hudRoute').textContent = rt.kind === 'genesis' ? 'Genesis' : rt.kind === 'lab' ? 'Neutral' : rt.date ?? rt.id;
  $('hudBlocks').hidden = !rt.route.crates;
  $('btnReplaySpeed').hidden = !replay; $('btnReplaySpeed').textContent = 'REPLAY ×1';
  keys.clear();
  Snd.init(); Snd.engineStart(); Snd.takeoff();
  showToast(replay ? 'Replay' : 'Stage ' + sim.stage, replay ? 'Re-simulating the recorded inputs' : stageName(sim.stage) + (sim.frame > 0 ? ' · practice from ' + km(S.distanceM(sim)) + ' km' : ''), 1700, true);
  hudCache = {};
  renderGear(true);
}
const startRunVoid = (rt: RouteInfo, of?: LastRun) => { void startRun(rt, of); };

function goMenu(): void {
  if (session && (mode === 'play' || mode === 'paused')) session.abandon('quit');
  mode = 'menu'; replay = null; session = null; Snd.engineStop();
  $('hud').hidden = true; showOnly('menu'); renderMenu(); renderLab();
  if (!attract) attract = S.create(ROUTES[0]!.route);
}

function togglePause(): void {
  if (mode === 'play') {
    if (session && !session.canPause()) { showToast('Pause unavailable', 'Pause needs a connection', 1600, true); return; }
    if (pauseUsedMs >= (session?.pauseBudgetMs ?? 20_000) - 250) { showToast('No pause left', 'This flight has used its 20 s of pause', 1600, true); return; }
    mode = 'paused'; pauseSince = performance.now(); showOnly('pause'); Snd.engineStop(); keys.clear();
    session?.pauseStart();
    paintPause();
  } else if (mode === 'replay') { mode = 'paused'; pauseSince = 0; showOnly('pause'); paintPause(); }
  else if (mode === 'paused') resume();
}
function autoPause(_why: string): void { if (mode === 'play') togglePause(); }
function resume(): void {
  if (mode !== 'paused') return;
  if (pauseSince) { pauseUsedMs += performance.now() - pauseSince; pauseSince = 0; session?.pauseEnd(); mode = 'play'; }
  else mode = 'replay';
  showOnly(null); acc = 0; lastTs = 0; Snd.engineStart();
}
function pauseLeftMs(): number { const used = pauseUsedMs + (pauseSince ? performance.now() - pauseSince : 0); return Math.max(0, (session?.pauseBudgetMs ?? 20_000) - used); }
function paintPause(): void {
  if (mode !== 'paused') return;
  if (!pauseSince) { $('pauseBudget').textContent = 'Replay paused'; return; }
  const left = pauseLeftMs();
  $('pauseBudget').textContent = left <= 3000 ? 'Resuming in ' + Math.ceil(left / 1000) : (left / 1000).toFixed(1) + ' s of pause left this flight';
  if (left <= 0) resume();
}

function onEnter(): void {
  if (mode === 'menu' && $('help').hidden && $('account').hidden) startRunVoid(selected ?? ROUTES[0]!);
  else if (mode === 'over' || mode === 'ended') startRunVoid(lastRun ? lastRun.route : ROUTES[0]!);
  else if (mode === 'paused') resume();
  else if (mode === 'dying') skipDeath();
}
function cycleReplaySpeed(): void {
  replaySpeed = replaySpeed === 1 ? 2 : replaySpeed === 2 ? 4 : 1;
  $('btnReplaySpeed').textContent = 'REPLAY ×' + replaySpeed;
}

function pressGear(slot: number): void {
  if (!session || !sim || mode !== 'play') return;
  const v = session.slots()[slot];
  if (!v || v.kind === null) return;
  if (v.state === 'offline') { Snd.denied(); showToast('Gear needs a connection', 'Normal play continues offline', 1500, true); return; }
  if (v.state !== 'ready') { Snd.denied(); return; }
  session.press(slot, sim.frame);
  if (session.mode === 'online') Snd.arming();
  renderGear(true);
}

// ======================= simulation tick =======================
function stepOnce(): void {
  if (!sim) return;
  let mask: number, slots = 0;
  if (replay) {
    const L = replay.log;
    while (replay.ip < L.inputs.length && L.inputs[replay.ip]![0] <= sim.frame) { replay.mask = L.inputs[replay.ip]![1]; replay.ip++; }
    while (replay.ig < L.gear.length && L.gear[replay.ig]![0] === sim.frame) { slots |= 1 << L.gear[replay.ig]![1]; replay.ig++; }
    while (replay.is < L.spawns.length && L.spawns[replay.is]![0] === sim.frame) { const x = L.spawns[replay.is]!; S.inject(sim, x[1], x[2], x[3], x[4]); replay.is++; }
    mask = replay.mask;
  } else {
    mask = liveMask();
    slots = session ? session.applies(sim.frame) : 0;
    rec!.mask(sim.frame, mask);
    for (let n = 0; n < 3; n++) if (slots & (1 << n)) rec!.gearEdge(sim.frame, n, -1); // seq filled by the session log for online
    if (session) for (const [id, kind, x, row] of session.spawnsAt(sim.frame)) { S.inject(sim, id, kind, x, row); rec!.spawn(sim.frame, id, kind, x, row); }
  }
  const before = sim.frame;
  const ev = S.step(sim, mask, slots);
  if (session && !replay) session.stepped(before, mask, sim);
  viewCam = sim.camY;
  if (ev) for (const e of ev) handleEvent(e);
  if (!sim.dead && sim.fuel < S.FUEL_MAX * 0.25 && sim.frame % 30 === 0) Snd.low();
}

function handleEvent(e: S.SimEvent): void {
  if (!sim) return;
  switch (e.t) {
    case 'shot': Snd.shot(); break;
    case 'kill': boom(e.x / U, e.y / U, false); explode(e.x / U, e.y / U, 12, false); fx.shake = Math.max(fx.shake, 3); Snd.boom(false); break;
    case 'fuelLost': boom(e.x / U, e.y / U, false); explode(e.x / U, e.y / U, 16, false, '#efe6cc'); Snd.boom(false); showToast('Depot lost', 'You shot your own seeds', 1100, true); break;
    case 'clink': sparks(e.x / U, e.y / U, '#e6edf5'); Snd.clink(); break;
    case 'gate':
      if (e.broken) {
        const r = (e.y / S.ROW_U) | 0, rd = S.rowData(sim, r);
        for (let x = rd[0] + 6; x < rd[1]; x += 22) boom(x, e.y / U, false);
        for (let x = rd[0]; x < rd[1]; x += 8) explode(x, e.y / U, 3, false, x % 16 ? '#f6c445' : '#5f6880');
        fx.shake = Math.max(fx.shake, 7); Snd.boom(true);
      } else { sparks(e.x / U, e.y / U, '#f6c445'); Snd.gateHit(); }
      break;
    case 'crate': fx.pops.push({ x: e.x / U, y: e.y / U, t: 0, text: '+1 block' }); sparks(e.x / U, e.y / U, '#fff6c9'); sparks(e.x / U, e.y / U, '#f6c445'); Snd.crate(); break;
    case 'pickup': fx.pops.push({ x: e.x / U, y: e.y / U, t: 0, text: 'Mystery Box!' }); sparks(e.x / U, e.y / U, '#f6c445'); Snd.crate(); if (session?.mode === 'online') showToast('Mystery Box', 'Yours once the flight is verified', 1600, true); break;
    case 'refuel': if (sim.frame % 4 === 0) Snd.refuel(sim.fuel / S.FUEL_MAX); break;
    case 'stage': showToast('Stage ' + e.n, stageName(e.n), 2000, true); Snd.stage(); break;
    case 'seg': onSegment(e.seg, e.prev); break;
    case 'gear': {
      Snd.gear(); fx.ring = 24;
      if (session) { const i = session.slots().findIndex((v) => v.kind === e.kind); const el = i >= 0 ? document.getElementById('gs' + i) : null; if (el) { el.classList.remove('fired'); void el.offsetWidth; el.classList.add('fired'); setTimeout(() => el.classList.remove('fired'), 500); } }
      showToast(GEAR_LABEL[e.kind], e.kind === 'shield' ? 'Absorbs one hit' : e.kind === 'spread' ? '3-way fire for 10 s' : e.kind === 'seed' ? '+50% seeds' : 'Longer range for 15 s', 1300, true);
      try { navigator.vibrate?.(30); } catch { /* ignore */ }
      renderGear(true);
      break;
    }
    case 'shieldPop': Snd.shieldPop(); fx.flash = 4; explode(e.x / U, e.y / U, 18, false, '#9fd8ff'); break;
    case 'warn': Snd.warn(); setTimeout(() => { if (mode === 'play') Snd.jetPass(); }, 520); break;
    case 'drop': Snd.drop(); break;
    case 'death': startDeath(); break;
  }
}

function onSegment(seg: number, prev: number): void {
  const rt = replay ? replay.of.route : session?.route;
  if (!rt || rt.kind === 'lab' || prev < 0) return;
  const now = rt.raw[seg] ?? 0, before = rt.raw[prev] ?? 0;
  if (now > 0 && before <= 0) { showToast('Squeektoshi ran here!', 'His recorded wheel run at ' + rt.clock[seg] + ' UTC. Catch the crates.', 2400); Snd.wheel(); }
  else if (now <= 0 && before > 0) { showToast('Squeektoshi napped here', 'Wide water ahead. More cats.', 2000, true); Snd.nap(); }
}

// ======================= effects =======================
function boom(x: number, y: number, big: boolean): void { fx.booms.push({ x, y, t: 0, big }); }
function explode(x: number, y: number, n: number, big: boolean, color?: string): void {
  const cols = color ? [color, '#fff6c9'] : ['#ffd75e', '#ff8a3d', '#ea4a3f', '#fff6c9'];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = (big ? 0.7 : 0.45) + Math.random() * (big ? 2.6 : 1.7);
    fx.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 18 + Math.random() * (big ? 30 : 16), c: cols[(Math.random() * cols.length) | 0]!, sz: Math.random() < 0.35 ? 2 : 1 });
  }
}
function sparks(x: number, y: number, c: string): void { for (let i = 0; i < 6; i++) fx.parts.push({ x, y, vx: (Math.random() - 0.5) * 2.2, vy: Math.random() * 1.6, life: 0, max: 11, c, sz: 1 }); }
function updateEffects(): void {
  for (let i = fx.parts.length - 1; i >= 0; i--) { const p = fx.parts[i]!; p.x += p.vx; p.y += p.vy; p.vx *= 0.95; p.vy *= 0.95; p.life++; if (p.life > p.max) fx.parts.splice(i, 1); }
  for (let i = fx.booms.length - 1; i >= 0; i--) { const b = fx.booms[i]!; if (++b.t > (b.big ? 44 : 22)) fx.booms.splice(i, 1); }
  for (let i = fx.smokes.length - 1; i >= 0; i--) { const s = fx.smokes[i]!; s.t++; s.y += 0.35; s.x += s.vx; if (s.t > 60) fx.smokes.splice(i, 1); }
  for (let i = fx.pops.length - 1; i >= 0; i--) { const p = fx.pops[i]!; if (++p.t > 40) fx.pops.splice(i, 1); }
  if (fx.shake > 0) fx.shake--;
  if (fx.flash > 0) fx.flash--;
  if (fx.ring > 0) fx.ring--;
  const ws = mode === 'menu' ? attract : sim;
  if (ws) weather.update(biomeAt((((ws === attract ? ws.camY : viewCam || ws.camY) / U + S.PLAYER_SY) / ROW_PX) | 0), settings.reducedMotion);
}
const weather = new Weather(W, H);

// ======================= death & summary =======================
function startDeath(): void {
  if (!sim) return;
  const x = sim.deathX / U, y = sim.deathY / U;
  boom(x, y, true); explode(x, y, 36, true); fx.shake = 16; fx.flash = 6; Snd.boom(true); Snd.engineStop();
  try { navigator.vibrate?.(120); } catch { /* ignore */ }
  const cause = S.causeName(sim);
  fx.death = { t: 0, x, y, vy: 3.8, open: 0, camV: S.SPEED / U, landed: 0, water: true, quip: QUIP[cause] ?? 'Squeek!', cx: x, cy: y };
  mode = 'dying';
  if (!replay) void summarize();
}
function updateDeath(): void {
  const d = fx.death; if (!d || !sim) return;
  d.t++;
  d.camV *= 0.92;
  viewCam = Math.min(sim.camY + 36 * U, viewCam + d.camV * U);
  if (d.t < 30) { d.y += d.vy; d.vy -= 0.11; }
  else {
    if (!d.open) { d.open = 1; Snd.pop(); Snd.whistle(); }
    if (!d.landed) { d.y -= 0.3; d.x += Math.sin(d.t / 13) * 0.3; }
  }
  if (d.x < 12) d.x = 12;
  if (d.x > W - 12) d.x = W - 12;
  if (d.t % 9 === 0 && d.t < 150) fx.smokes.push({ x: d.cx + (Math.random() - 0.5) * 8, y: d.cy, vx: (Math.random() - 0.5) * 0.2, t: 0, k: Math.random() < 0.5 ? 'smoke_a' : 'smoke_b' });
  if (d.t === 180) {
    d.landed = 1;
    const r = Math.floor(d.y / ROW_PX), rd = S.rowData(sim, r);
    d.water = d.x > rd[0] + 4 && d.x < rd[1] - 4 && !(rd[3] > rd[2] && d.x > rd[2] - 4 && d.x < rd[3] + 4);
    if (d.water) { for (let i = 0; i < 16; i++) fx.parts.push({ x: d.x, y: d.y - 3, vx: (Math.random() - 0.5) * 2.2, vy: Math.random() * 1.8, life: 0, max: 22, c: i % 2 ? '#d8ecff' : '#ffffff', sz: 1 }); Snd.splash(); }
    else Snd.thud();
  }
  if (d.t > 205) showOver();
}
function skipDeath(): void { if (mode === 'dying' && fx.death && fx.death.t > 30) { fx.death.t = 179; updateDeath(); showOver(); } }

let currentStartRow = 0;
function startRowOf(_s: S.StateV3): number { return currentStartRow; }
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try { const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch { return ''; }
}

async function summarize(): Promise<void> {
  if (!sim || !session || !rec) return;
  const s = sim, ses = session, log = rec.log();
  const dist = S.distanceM(s);
  const prevBest = bestFor(ses.route.id);
  const run: LastRun = {
    route: ses.route, log: { inputs: log.inputs.slice(), gear: log.gear.slice(), spawns: [] }, params: ses.params, startRow: startRowOf(s), hash: s.hash, frames: s.frame, camY: s.camY, dist, stage: s.stage,
    cause: S.causeName(s), kills: s.kills, gates: s.gates, blocks: s.blocks, gearUses: s.gear.uses, prevBest, mode: ses.mode,
    verdict: 'Checking…', detail: '', sha: '',
  };
  lastRun = run;
  if (!run.startRow) logRun({ r: ses.route.id, m: Math.round(dist), st: s.stage, c: run.cause, f: s.frame, k: s.kills, b: s.blocks, t: Date.now(), mode: ses.mode });
  // local re-simulation from the recorded inputs: same rules, same result?
  const check = run.startRow ? S.createAt(ses.route.route, ses.params, run.startRow) : S.create(ses.route.route, ses.params);
  const t0 = performance.now();
  S.runTo(check, run.log, s.frame + 1);
  const ms = performance.now() - t0;
  const match = check.hash === s.hash && check.frame === s.frame && check.camY === s.camY && check.dead === s.dead;
  run.sha = await sha256Hex(S.encodeState(check));
  const local = match
    ? `Re-ran ${run.log.inputs.length} input changes${run.gearUses ? ' and ' + run.gearUses + ' Gear use' + (run.gearUses > 1 ? 's' : '') : ''}: same ${km(dist)} km in ${Math.max(1, Math.round(ms))} ms. State SHA-256 ${run.sha.slice(0, 12)}…`
    : 'The re-simulated flight ended somewhere else. This run would not verify.';
  run.verdict = match ? 'Passed locally' : 'Failed';
  run.detail = local;
  paintOver();
  const res = await ses.gameOver({ frame: s.frame, cause: run.cause, distanceRows: S.distanceRows(s) }, s);
  run.verdict = res.verdict;
  run.detail = res.detail + (ses.mode === 'practice' ? ' ' + local : '');
  paintOver();
}

function showOver(): void {
  if (mode === 'over') return;
  mode = 'over';
  $('hud').hidden = true; $('btnReplaySpeed').hidden = true;
  showOnly('over');
  paintOver();
  renderLab();
  setTimeout(() => { try { $('btnAgain').focus({ preventScroll: true }); } catch { /* ignore */ } }, 50);
}
function paintOver(): void {
  if (mode !== 'over' || !sim) return;
  const d = fx.death;
  const r = replay ? replay.of : lastRun;
  if (!r) return;
  let newBest = false;
  if (replay) {
    const match = sim.hash === r.hash && sim.frame === r.frames && sim.camY === r.camY;
    $('ovKicker').textContent = 'Replay finished';
    $('ovVerify').textContent = match ? 'Rebuilt from ' + r.log.inputs.length + ' recorded input changes. It ended exactly where the original flight did.' : 'This replay did not end where the original flight did.';
    $('ovCheck').textContent = match ? 'Same result' : 'Different';
    $('ovCheck').className = match ? 'ok' : 'bad';
  } else {
    newBest = r.dist > r.prevBest && r.prevBest > 0;
    $('ovKicker').textContent = d && !d.water ? 'Bailed out' : 'Splashdown';
    $('ovVerify').textContent = r.detail;
    $('ovCheck').textContent = r.verdict;
    $('ovCheck').className = /verified|passed|practice/i.test(r.verdict) ? 'ok' : /held|checking|waiting/i.test(r.verdict) ? '' : 'bad';
  }
  countUp(replay ? S.distanceM(sim) : r.dist, newBest);
  $('ovBest').hidden = !newBest;
  document.querySelector('.over-card')!.classList.toggle('down', !replay && !!d && !d.water);
  $('ovRoute').textContent = r.route.label + (r.mode === 'online' ? ' · online' : ' · practice');
  $('ovStageN').textContent = String(r.stage);
  $('ovStage').textContent = stageName(r.stage);
  $('ovCause').textContent = replay ? 'Replay of your flight.' : (CAUSE[r.cause] ?? r.cause) + '.';
  $('ovQuip').textContent = replay || !d ? '' : '“' + d.quip + '”';
  $('ovPrev').textContent = newBest ? 'Previous best ' + km(r.prevBest) + ' km' : r.prevBest ? 'Best on this route: ' + km(Math.max(r.prevBest, Math.round(r.dist))) + ' km' : 'First flight on this route';
  $('ovBlocksTile').hidden = !r.route.route.crates;
  $('ovBlocks').textContent = String(r.blocks);
  $('ovKills').textContent = String(r.kills);
  $('ovGates').textContent = String(r.gates);
  const secs = Math.round(r.frames / 60);
  $('ovTime').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  $('ovStats').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' airborne · ' + r.kills + ' shot down · ' + r.gates + ' gates · ' + r.gearUses + ' Gear';
  $('btnShare').setAttribute('href', shareUrl(r));
}
/** The post X opens for "Share on X" (the player writes and posts it; nothing is posted for them).
 *  The final wording and the flight card image come from the owner. */
const SHARE_HOME = 'https://squeekraid.xyz';
function shareUrl(r: LastRun): string {
  const where = r.route.kind === 'genesis' ? 'Genesis' : r.route === todayDaily ? "today's Daily" : 'a Daily route';
  const text = `I flew ${km(r.dist)} km on ${where} in SqueekRaid with Squeektoshi the hamster 🐹✈️ Can you beat it?`;
  return 'https://x.com/intent/post?' + new URLSearchParams({ text, url: SHARE_HOME }).toString();
}
/** Distance tally on the results card (skipped with reduced motion). */
let countTimer = 0;
function countUp(m: number, best: boolean): void {
  const el = $('ovDist'), done = () => { el.innerHTML = km(m) + '<small>km</small>'; };
  cancelAnimationFrame(countTimer);
  if (settings.reducedMotion || el.dataset.shown === String(m)) { done(); el.dataset.shown = String(m); return; }
  el.dataset.shown = String(m);
  const t0 = performance.now(), dur = Math.min(1400, 500 + m / 8);
  let lastTick = 0;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.innerHTML = km(m * e) + '<small>km</small>';
    if (t - lastTick > 70 && k < 1) { lastTick = t; Snd.tick(); }
    if (k < 1) countTimer = requestAnimationFrame(step); else { done(); Snd.result(best); }
  };
  countTimer = requestAnimationFrame(step);
}
function showEnded(reason: string): void {
  mode = 'ended';
  Snd.engineStop();
  $('hud').hidden = true;
  showOnly('over');
  $('ovKicker').textContent = 'Flight ended';
  $('ovDist').innerHTML = km(sim ? S.distanceM(sim) : 0) + '<small>km</small>';
  $('ovCheck').textContent = 'Ended by server'; $('ovCheck').className = 'bad';
  $('ovVerify').textContent = reason;
  $('ovCause').textContent = 'The server ended this flight.'; $('ovQuip').textContent = ''; $('ovPrev').textContent = 'No record and no rewards for an ended flight.';
  $('ovStats').textContent = 'No record and no rewards for an ended flight.';
  document.querySelector('.over-card')!.classList.add('down');
  ($('ovCheck').closest('details') as HTMLDetailsElement).open = true;
}

// ======================= attract (menu backdrop) =======================
function updateAttract(): void {
  if (!attract) return;
  attract.camY += 26;
  S.generateTo(attract, ((attract.camY / S.ROW_U) | 0) + 110);
  const cut = attract.camY - 50 * U;
  if (attract.ents.length > 40) attract.ents = attract.ents.filter((e) => e.y > cut);
}

// ======================= render =======================
function render(): void {
  const s = mode === 'menu' && attract ? attract : sim;
  ctx.fillStyle = '#0b0a18'; ctx.fillRect(0, 0, W, H);
  if (!artReady) { ctx.fillStyle = '#f6c445'; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText('LOADING' + '.'.repeat((frameNo >> 4) % 4), W / 2, H / 2); ctx.textAlign = 'left'; return; }
  if (!s) return;
  const cam = (s === attract ? s.camY : fx.death ? viewCam : s.camY) / U;
  const camPx = Math.round(cam);
  ctx.save();
  if (fx.shake > 0 && mode !== 'menu' && !settings.reducedMotion) ctx.translate(Math.round((Math.random() - 0.5) * 4), Math.round((Math.random() - 0.5) * 4));
  drawTerrain(s, camPx);
  drawEntities(s, camPx, false);
  if (s === sim) drawBullets(s, camPx);
  drawEntities(s, camPx, true);
  if (s === sim) {
    if (!sim.dead) drawPlayer(s);
    drawEffects(camPx);
    if (fx.death) drawDeath(camPx);
  } else drawAttractPlane(s, camPx);
  ctx.restore();
  weather.draw(ctx, frameNo);
  if (s === sim && !fx.death) drawMarkers(s, camPx, true);
  if (fx.flash > 0 && !settings.reducedMotion) { ctx.fillStyle = 'rgba(255,246,201,' + fx.flash / 8 + ')'; ctx.fillRect(0, 0, W, H); }
  if (s === sim) updateHud();
}

function drawTerrain(s: S.StateV3, camPx: number): void {
  const off = ((camPx % 64) + 64) % 64;
  const base = Math.floor(camPx / ROW_PX) - 2;
  const rows = Math.ceil(H / ROW_PX) + 5;
  const live = s.route.crates;
  const deco: [number, number, number, number, number][] = [];
  ctx.save();
  ctx.translate(0, off);
  for (let i = 0; i < rows; i++) {
    const r = base + i;
    if (r < 0) continue;
    if (r >= s.genRow) break;
    const y = H - (r * ROW_PX + ROW_PX - camPx);
    if (y > H || y + ROW_PX < 0) continue;
    const yy = y - off;
    const [l, rr, il, ir] = S.rowData(s, r);
    const bi = biomeAt(r), P = PAT[bi]!, b = P.b;
    ctx.fillStyle = P.bank; ctx.fillRect(0, yy, l, ROW_PX); ctx.fillRect(rr, yy, W - rr, ROW_PX);
    ctx.fillStyle = P.water; ctx.fillRect(l, yy, rr - l, ROW_PX);
    const c = Math.round((l + rr) / 2), dd = Math.round((rr - l) * 0.18);
    ctx.fillStyle = P.deep; ctx.fillRect(c - dd, yy, dd * 2, ROW_PX);
    ctx.fillStyle = P.shallow; ctx.fillRect(l + 1, yy, 2, ROW_PX); ctx.fillRect(rr - 3, yy, 2, ROW_PX);
    if (ir > il) {
      ctx.fillRect(il - 3, yy, 2, ROW_PX); ctx.fillRect(ir + 1, yy, 2, ROW_PX);
      ctx.fillStyle = P.bank; ctx.fillRect(il, yy, ir - il, ROW_PX);
      ctx.fillStyle = b.edge; ctx.fillRect(il, yy, 1, ROW_PX); ctx.fillRect(ir - 1, yy, 1, ROW_PX);
      ctx.fillStyle = b.foam; ctx.fillRect(il - 1, yy, 1, ROW_PX); ctx.fillRect(ir, yy, 1, ROW_PX);
    }
    const h = rowHash(r);
    // cosmetic: a darker lip behind the waterline, ground detail and water glints (never inside the 5 px edge band)
    ctx.fillStyle = b.dark; ctx.fillRect(l - 5, yy, 3, ROW_PX); ctx.fillRect(rr + 2, yy, 3, ROW_PX);
    bankDetail(ctx, bi, b, 0, l - 6, yy, ROW_PX, h, frameNo);
    bankDetail(ctx, bi, b, rr + 6, W, yy, ROW_PX, h >>> 1 ^ 0x5bd1e995, frameNo);
    if (ir > il) bankDetail(ctx, bi, b, il + 3, ir - 3, yy, ROW_PX, h ^ 0x27d4eb2d, frameNo);
    else waterGlint(ctx, bi, b, l, rr, yy, h, frameNo);
    ctx.fillStyle = b.edge; ctx.fillRect(l - 2, yy, 2, ROW_PX); ctx.fillRect(rr, yy, 2, ROW_PX);
    ctx.fillStyle = b.foam; ctx.fillRect(l, yy, 1, ROW_PX); ctx.fillRect(rr - 1, yy, 1, ROW_PX);
    const w = S.wAtRow(s.route, r);
    if (live && w > 0) {
      if (r % 3 === 0 && ((frameNo >> 3) + h) % 4) { ctx.fillStyle = '#ffd75e'; ctx.fillRect(l + 1, yy + 2, 1, 1); }
      if (r % 3 === 1 && ((frameNo >> 3) + h) % 4) { ctx.fillStyle = '#ffd75e'; ctx.fillRect(rr - 2, yy + 2, 1, 1); }
    }
    if (bi === 3 && h % 11 === 0 && ((frameNo + h) >> 4) % 3 === 0) {
      ctx.fillStyle = '#d4ff4a';
      ctx.fillRect(h % 2 ? 2 + ((h >>> 7) % Math.max(1, l - 6)) : rr + 3 + ((h >>> 7) % Math.max(1, W - rr - 6)), yy + 1, 1, 1);
    }
    if (h % 6 === 0) deco.push([r, 0, h, bi, w]);
    if ((h >>> 9) % 6 === 0) deco.push([r, 1, h >>> 3, bi, w]);
  }
  ctx.restore();
  for (const [r, side, h, bi, w] of deco) {
    const name = live && w > 450 && h % 5 === 0 ? 'wheel' : DECO[bi]![h % 3]!;
    const sp = ART.s[name]!, sw = sp[2], sh = sp[3];
    const span = Math.ceil(sh / ROW_PX) + 1;
    if (r + span >= s.genRow) continue;
    let lim = side ? 0 : W;
    for (let k = 0; k <= span; k++) { const rd = S.rowData(s, r + k); lim = side ? Math.max(lim, rd[1]) : Math.min(lim, rd[0]); }
    let x: number;
    if (side === 0) { const room = lim - sw - 6; if (room < 1) continue; x = 1 + ((h >>> 5) % room); }
    else { const room = W - lim - sw - 5; if (room < 1) continue; x = lim + 4 + ((h >>> 13) % room); }
    spr(name, x, H - (r * ROW_PX - camPx) - sh);
  }
}

function drawGate(s: S.StateV3, e: S.Ent, sy: number): void {
  const r = (e.y / S.ROW_U) | 0, rd = S.rowData(s, r);
  const x0 = rd[0] - 6, x1 = rd[1] + 6, top = Math.round(sy) - 8;
  ctx.save(); ctx.translate(0, top + 3); if (gatePat) ctx.fillStyle = gatePat; ctx.fillRect(x0 + 4, 0, x1 - x0 - 8, 10); ctx.restore();
  spr('gate_post', x0, top); spr('gate_post', x1 - 4, top, true);
  const cx = Math.round((x0 + x1) / 2);
  spr('gate_plate', cx - 6, top + 2);
  if ((frameNo >> 4) & 1) { ctx.fillStyle = '#6b2a2a'; ctx.fillRect(x0 + 1, top + 1, 3, 1); ctx.fillRect(x1 - 4, top + 1, 3, 1); }
  if (e.maxHp > 1) {
    for (let i = 0; i < e.maxHp; i++) { ctx.fillStyle = i < e.hp ? '#d4ff4a' : '#3a3f55'; ctx.fillRect(cx - e.maxHp * 3 + i * 6, top - 2, 4, 2); }
    if (e.hp < e.maxHp) { ctx.fillStyle = '#1b1530'; for (let i = 0; i < (e.maxHp - e.hp) * 4; i++) ctx.fillRect(x0 + 6 + ((i * 37) % Math.max(1, x1 - x0 - 12)), top + 5 + (i % 5), 2, 1); }
  }
}

function drawEntities(s: S.StateV3, camPx: number, air: boolean): void {
  const K = S.K;
  for (const e of s.ents) {
    const isAir = e.k === K.DRONE || e.k === K.JET;
    if (isAir !== air) continue;
    const sx = e.x / U, sy = H - (e.y / U - camPx);
    if (sy < -40 || sy > H + 40) continue;
    switch (e.k) {
      case K.GATE: drawGate(s, e, sy); break;
      case K.BOAT: {
        const flip = e.vx < 0;
        if (e.moving && e.awake) {
          ctx.fillStyle = 'rgba(216,236,255,.75)';
          for (let i = 0; i < 8; i += 2) { const wx = flip ? sx + 13 + i : sx - 14 - i; ctx.fillRect(Math.round(wx), Math.round(sy - 1 - i / 2), 1, 1); ctx.fillRect(Math.round(wx), Math.round(sy + 3 + i / 2), 1, 1); }
        }
        sprC('boat', sx, sy - 3, flip);
        if (e.b === S.B.LAYER) { // mine layer: a yarn ball riding on deck, one per mine left
          for (let i = 0; i < 3 - e.drops; i++) { ctx.fillStyle = i % 2 ? '#ff8fb1' : '#ffd75e'; ctx.fillRect(Math.round(sx - 4 + i * 4), Math.round(sy - 10), 3, 3); }
        }
        if (e.b === S.B.SCREEN && e.awake) { ctx.fillStyle = 'rgba(255,215,94,.55)'; ctx.fillRect(Math.round(sx - 1), Math.round(sy - 13), 2, 2); }
        break;
      }
      case K.DRONE: {
        shadowC('drone_sh', sx, sy);
        sprC((frameNo >> 1) & 1 ? 'drone_a' : 'drone_b', sx, sy);
        if (e.b === S.B.TRACKER && e.awake) { // tracker: red eye that blinks while it is steering
          ctx.fillStyle = (frameNo >> 2) & 1 ? '#ff5a5a' : '#ffb3b3'; ctx.fillRect(Math.round(sx - 1), Math.round(sy + 5), 3, 2);
        }
        if (e.b === S.B.PINCER && e.awake && e.t < 0) { // pincer pair: show the gap they leave
          const g0 = (e.gx - e.a) / U, g1 = (e.gx + e.a) / U;
          ctx.fillStyle = 'rgba(212,255,74,.7)';
          for (let x = Math.round(g0); x <= Math.round(g1); x += 4) ctx.fillRect(x, Math.round(sy + 9), 2, 1);
        }
        break;
      }
      case K.JET: if (e.t >= e.a || e.b !== S.B.STRAFE) { shadowC('jet_sh', sx, sy, e.vx < 0); sprC('jet', sx, sy, e.vx < 0); } break;
      case K.ROCK: {
        const b = PAT[biomeAt((e.y / S.ROW_U) | 0)]!.b;
        ctx.fillStyle = b.foam; ctx.fillRect(Math.round(sx - 9), Math.round(sy + 6), 18, 1); ctx.fillRect(Math.round(sx - 11), Math.round(sy + 4), 2, 1); ctx.fillRect(Math.round(sx + 9), Math.round(sy + 4), 2, 1);
        sprC('rock', sx, sy);
        break;
      }
      case K.MINE: sprC(((frameNo + e.t) >> 4) & 1 ? 'mine_a' : 'mine_b', sx, sy); break;
      case K.FUEL: sprC('depot', sx, sy); break;
      case K.PICKUP: if (e.c === 2) drawCapsule(sx, sy + Math.round(Math.sin((frameNo + e.id) / 9) * 1.5), frameNo + e.id); else drawBox(sx, sy + Math.round(Math.sin((frameNo + e.id) / 10) * 1.5), frameNo + e.id); break;
      case K.CRATE: {
        sprC('crate', sx, sy + Math.round(Math.sin((frameNo + e.id) / 12)));
        const k = ((frameNo + e.id) >> 3) % 4, ox = k & 1 ? 9 : -9, oy = k & 2 ? 9 : -9;
        ctx.fillStyle = '#fff6c9'; ctx.fillRect(Math.round(sx + ox), Math.round(sy + oy), 1, 1);
        ctx.fillStyle = '#f6c445'; ctx.fillRect(Math.round(sx + ox) - 1, Math.round(sy + oy), 1, 1); ctx.fillRect(Math.round(sx + ox) + 1, Math.round(sy + oy), 1, 1);
        ctx.fillRect(Math.round(sx + ox), Math.round(sy + oy) - 1, 1, 1); ctx.fillRect(Math.round(sx + ox), Math.round(sy + oy) + 1, 1, 1);
        break;
      }
    }
  }
}

/** Strafing-jet telegraph, at least 30 frames before entry: a red glow at the entry edge, a chevron
 *  with a countdown bar, and the jet's exact straight path across the river (its motion is linear). */
function drawMarkers(s: S.StateV3, camPx: number, _top: boolean): void {
  for (const e of s.ents) {
    if (e.b !== S.B.STRAFE || !e.awake || e.t >= e.a) continue;
    const ty = Math.round(H - (e.y / U - camPx));
    if (ty < -40 || ty > H - 8) continue;
    const sy = Math.max(64, ty); // keep the marker clear of the HUD; the path below shows the exact line
    const left = e.c === 0, frac = 1 - e.t / e.a, on = (frameNo >> 2) & 1;
    // the path: dashes marching in the direction of travel
    if (e.vx !== 0) {
      ctx.fillStyle = on ? 'rgba(255,90,90,.75)' : 'rgba(255,215,94,.6)';
      const steps = Math.ceil((W + 80) * U / Math.abs(e.vx));
      for (let k = (frameNo >> 1) % 5; k < steps; k += 5) {
        const x = Math.round((e.x + e.vx * k) / U), y = Math.round(H - ((e.y + e.vy * k) / U - camPx));
        if (x < 0 || x > W || y < 0 || y > H) continue;
        ctx.fillRect(x - 1, y, 3, 2);
      }
    }
    // edge glow
    const g = ctx.createLinearGradient(left ? 0 : W, 0, left ? 26 : W - 26, 0);
    g.addColorStop(0, `rgba(255,70,70,${(0.25 + 0.35 * frac).toFixed(2)})`); g.addColorStop(1, 'rgba(255,70,70,0)');
    ctx.fillStyle = g; ctx.fillRect(left ? 0 : W - 26, sy - 22, 26, 44);
    // chevron with an exclamation mark
    const x = left ? 3 : W - 13;
    ctx.fillStyle = '#1b1530'; ctx.fillRect(x - 1, sy - 8, 12, 16);
    ctx.fillStyle = on ? '#ff5a5a' : '#ffd75e';
    for (let i = 0; i < 5; i++) { const w = 5 - i; ctx.fillRect(left ? x + i : x + 9 - i, sy - w - 1, 1, w * 2 + 2); }
    ctx.fillStyle = '#1b1530'; ctx.fillRect(left ? x + 1 : x + 8, sy - 3, 1, 4); ctx.fillRect(left ? x + 1 : x + 8, sy + 2, 1, 1);
    ctx.fillStyle = 'rgba(27,21,48,.9)'; ctx.fillRect(x - 1, sy + 10, 12, 3);
    ctx.fillStyle = '#ff5a5a'; ctx.fillRect(x, sy + 11, Math.max(1, Math.round(10 * frac)), 1);
  }
}

function drawBullets(s: S.StateV3, camPx: number): void {
  const long = s.gear.long > 0;
  for (const b of s.bullets) {
    const x = b.x / U - 1, y = H - (b.y / U - camPx) - 2;
    if (long) { ctx.fillStyle = 'rgba(255,215,94,.6)'; ctx.fillRect(Math.round(x), Math.round(y + 4), 2, 4); }
    spr('bullet', x, y);
  }
}

function planeName(vx: number): string { return (vx < -15 ? 'planeL' : vx > 15 ? 'planeR' : 'plane') + ((frameNo >> 1) & 1 ? '_a' : '_b'); }
function drawPlane(x: number, y: number, vx: number): void {
  ctx.globalAlpha = 0.28; spr('plane_sh', x - 12 + 5, y - 11 + 8); ctx.globalAlpha = 1;
  spr(planeName(vx), x - 12, y - 11);
}
function ring(cx: number, cy: number, r: number, c: string): void {
  ctx.fillStyle = c;
  for (let a = 0; a < 48; a++) { const t = (a / 48) * Math.PI * 2; ctx.fillRect(Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), 1, 1); }
}
function drawPlayer(s: S.StateV3): void {
  const x = s.px / U, y = H - S.PLAYER_SY;
  const grace = s.gear.grace > 0;
  if (!grace || (frameNo >> 2) & 1) drawPlane(x, y, s.vx);
  if (s.gear.shield > 0) ring(x, y - 1, 14 + ((frameNo >> 4) & 1), (frameNo >> 3) & 1 ? '#9fd8ff' : '#d8f1ff');
  if (fx.ring > 0) ring(x, y - 1, 16 + (24 - fx.ring), 'rgba(255,215,94,' + (fx.ring / 24).toFixed(2) + ')');
  if (s.fuel < S.FUEL_MAX * 0.25 && (frameNo >> 3) & 1) { ctx.fillStyle = '#ff5a5a'; ctx.fillRect(Math.round(x) + 12, Math.round(y) - 10, 2, 2); }
}
function drawAttractPlane(s: S.StateV3, camPx: number): void {
  const r = ((camPx + S.PLAYER_SY) / ROW_PX) | 0;
  if (r >= s.genRow) return;
  const rd = S.rowData(s, r + 4);
  const x = (rd[0] + rd[1]) / 2 + Math.sin(frameNo / 50) * 14;
  drawPlane(x, H - S.PLAYER_SY, Math.cos(frameNo / 50) * 30);
}

function drawEffects(camPx: number): void {
  for (const s of fx.smokes) { ctx.globalAlpha = Math.max(0, 0.9 - s.t / 66); sprC(s.k, s.x, H - (s.y - camPx)); }
  ctx.globalAlpha = 1;
  for (const b of fx.booms) {
    const x = b.x, y = H - (b.y - camPx);
    if (b.big) {
      if (b.t < 7) sprC('boom_l_a', x, y); else if (b.t < 15) sprC('boom_l_b', x, y);
      else { ctx.globalAlpha = Math.max(0, 1 - (b.t - 15) / 30); sprC('smoke_a', x - 4, y - (b.t - 15) * 0.3); sprC('smoke_b', x + 5, y - 3 - (b.t - 15) * 0.25); ctx.globalAlpha = 1; }
    } else {
      if (b.t < 5) sprC('boom_s_a', x, y); else if (b.t < 10) sprC('boom_s_b', x, y);
      else { ctx.globalAlpha = Math.max(0, 1 - (b.t - 10) / 12); sprC('smoke_b', x, y - (b.t - 10) * 0.3); ctx.globalAlpha = 1; }
    }
  }
  for (const p of fx.parts) { ctx.globalAlpha = Math.max(0, 1 - p.life / p.max); ctx.fillStyle = p.c; ctx.fillRect(Math.round(p.x), Math.round(H - (p.y - camPx)), p.sz, p.sz); }
  ctx.globalAlpha = 1;
  ctx.font = '700 10px "Pixelify Sans", monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  for (const p of fx.pops) {
    const x = Math.round(p.x), y = Math.round(H - (p.y - camPx) - 12 - p.t * 0.4);
    ctx.globalAlpha = Math.max(0, 1 - p.t / 40);
    ctx.fillStyle = '#1b1530'; ctx.fillText(p.text, x + 1, y + 1);
    ctx.fillStyle = '#ffe39a'; ctx.fillText(p.text, x, y);
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

function line(x0: number, y0: number, x1: number, y1: number, c: string): void {
  ctx.fillStyle = c;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
  for (let i = 0; i <= n; i++) { const t = n ? i / n : 0; ctx.fillRect(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 1, 1); }
}
function drawDeath(camPx: number): void {
  const d = fx.death; if (!d) return;
  const hx = Math.round(d.x), hy = Math.round(H - (d.y - camPx));
  if (!d.open) sprC((d.t >> 2) & 1 ? 'body_rot' : 'body', hx, hy);
  else if (d.landed) {
    if (d.water) {
      const g = Math.min(1, (d.t - 180) / 20);
      ctx.fillStyle = '#d8ecff';
      for (const [rx, ry] of [[9 + 5 * g, 3 + 2 * g], [5 + 3 * g, 2 + g]] as const) for (let a = 0; a < 40; a++) { const t = (a / 40) * Math.PI * 2; ctx.fillRect(Math.round(hx + Math.cos(t) * rx), Math.round(hy + 3 + Math.sin(t) * ry), 1, 1); }
      spr('canopy_flat', hx + 8, hy + 2);
      sprC('head', hx, hy - 1 + ((frameNo >> 4) & 1));
    } else { spr('canopy_flat', hx + 6, hy + 2); sprC('body', hx, hy); }
  } else {
    const small = d.t < 37, cn = small ? 'canopy_s' : 'canopy', cr = ART.s[cn]!;
    const cb = hy - 12, cl = hx - cr[2] / 2, crt = hx + cr[2] / 2;
    line(cl + 2, cb - 1, hx - 5, hy, '#e3e9fb'); line(crt - 3, cb - 1, hx + 4, hy, '#e3e9fb');
    if (!small) { line(cl + 9, cb - 1, hx - 3, hy - 1, '#e3e9fb'); line(crt - 10, cb - 1, hx + 2, hy - 1, '#e3e9fb'); }
    spr(cn, cl, cb - cr[3]);
    sprC('body', hx, hy);
  }
  if (d.open && d.t > 42) {
    ctx.font = '600 10px "Pixelify Sans", monospace'; ctx.textBaseline = 'middle';
    const txt = d.quip, tw = Math.ceil(ctx.measureText(txt).width) + 10;
    let bx = hx + 12; if (bx + tw > W - 4) bx = hx - 12 - tw;
    const by = hy - 40;
    ctx.fillStyle = '#1b1530'; ctx.fillRect(bx + 2, by + 2, tw, 14); ctx.fillRect(bx - 1, by - 1, tw + 2, 16);
    ctx.fillStyle = '#fff7e6'; ctx.fillRect(bx, by, tw, 14);
    ctx.fillStyle = '#1b1530'; ctx.fillText(txt, bx + 5, by + 7.5);
  }
}

// ======================= HUD & lab =======================
let hudCache: Record<string, unknown> = {};
function setText(id: string, v: string): void { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function updateHud(): void {
  if ($('hud').hidden || !sim) return;
  const inf = S.info(sim);
  const rt = replay ? replay.of.route : session?.route;
  if (!rt) return;
  const dkm = km(inf.m);
  if (hudCache.dist !== dkm) { hudCache.dist = dkm; $('hudDist').innerHTML = dkm + '<small>km</small>'; }
  setText('hudStage', 'Stage ' + inf.stage + ' · ' + stageName(inf.stage));
  if (mode === 'play' && (frameNo & 7) === 0) Snd.engineTune(sim.vx, inf.fuelPct < 0.25);
  const hb = String((inf.stage - 1) % 5); if (hudCache.biome !== hb) { hudCache.biome = hb; $('hud').dataset.biome = hb; }
  const raw = rt.raw[inf.seg], clock = rt.clock[inf.seg] ?? '';
  let txt: string, running = false;
  if (rt.kind === 'lab') txt = 'Lab river · no wheel data';
  else if (raw === null || raw === undefined) txt = clock + ' UTC · no wheel data';
  else if (raw > 0) { txt = 'Ran ' + fmtInt(raw) + ' work at ' + clock + ' UTC'; running = true; }
  else txt = 'Asleep at ' + clock + ' UTC';
  setText('hudWheelText', txt);
  if (hudCache.run !== running) { hudCache.run = running; $('hudWheel').classList.toggle('running', running); }
  const fp = (inf.fuelPct * 100).toFixed(1) + '%'; if (hudCache.fp !== fp) { hudCache.fp = fp; ($('hudFuelBar') as HTMLElement).style.width = fp; }
  const low = inf.fuelPct < 0.25; if (hudCache.low !== low) { hudCache.low = low; $('hudFuel').classList.toggle('low', low); }
  setText('hudBlocksN', sim.blocks + (sim.blocks === 1 ? ' block' : ' blocks'));
  setText('hudLink', session ? session.status() : 'Replay');
  const ban = session ? session.banner() : '';
  setText('hudBanner', ban); $('hudBanner').hidden = !ban;
  const fxBits: string[] = [];
  if (sim.gear.shield > 0) fxBits.push('SHIELD' + (sim.gear.shield > 1 ? ' ×' + sim.gear.shield : ''));
  if (sim.gear.spread > 0) fxBits.push('SPREAD ' + Math.ceil(sim.gear.spread / 60) + 's');
  if (sim.gear.long > 0) fxBits.push('LONG ' + Math.ceil(sim.gear.long / 60) + 's');
  setText('hudFx', fxBits.join(' · ')); $('hudFx').hidden = !fxBits.length;
  if (frameNo % 6 === 0) { updateLive(inf); renderGear(false); }
  if (session) { const t = session.terminated(); if (t && mode === 'play') showEnded(t); }
}
let gearSig = '';
function renderGear(force: boolean): void {
  const views: SlotView[] = session ? session.slots() : [0, 1, 2].map(() => ({ kind: null, count: 0, state: 'none', note: '' }));
  const sig = JSON.stringify(views);
  if (!force && sig === gearSig) return;
  gearSig = sig;
  for (let i = 0; i < 3; i++) {
    const v = views[i]!, el = $('gs' + i);
    el.hidden = v.kind === null;
    el.className = 'gslot ' + v.state + (v.kind ? ' g-' + v.kind : '');
    el.setAttribute('aria-label', v.kind ? `${GEAR_LABEL[v.kind]}: ${v.count} left, key ${GEAR_KEYS[i]}${v.note ? ', ' + v.note : ''}` : 'Empty slot');
    el.querySelector('.n')!.textContent = String(v.count);
    if (v.kind && el.dataset.kind !== v.kind) { el.dataset.kind = v.kind; el.querySelector('svg')!.innerHTML = GEAR_ICON[v.kind]; }
    el.querySelector('.st')!.textContent = v.state === 'arming' ? '…' : v.state === 'offline' ? 'OFF' : '';
  }
}
function updateLive(inf: S.InfoV3): void {
  const set = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
  set('lvDist', km(inf.m) + ' km');
  set('lvP', String(inf.P));
  set('lvBudget', inf.budget + ' per 100 m');
  set('lvStage', inf.stage + ' · ' + stageName(inf.stage));
  set('lvChannel', inf.channelPx + ' px');
  set('lvFuelSp', '~' + Math.round(inf.depotSpacingM) + ' m (bound 338 m)');
  set('lvNext', inf.nextDepotM < 0 ? 'not in sight' : Math.round(inf.nextDepotM) + ' m');
  set('lvUnlocked', inf.unlocked.length ? inf.unlocked.join(', ') : 'patrols only');
  const os = Object.entries(inf.onScreen).filter(([k]) => !['fuel', 'crate', 'gate'].includes(k)).map(([k, n]) => k + ' ' + n).join(', ');
  set('lvOnScreen', os || 'clear');
}

function sparkline(rt: RouteInfo): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 96; c.height = 20; c.className = 'px';
  const x = c.getContext('2d')!;
  for (let i = 0; i < 48; i++) {
    const v = rt.raw[i];
    if (rt.kind === 'lab') { x.fillStyle = '#5f6880'; x.fillRect(i * 2, 10, 1, 10); continue; }
    if (v === null || v === undefined) { x.fillStyle = '#3a3460'; x.fillRect(i * 2, 19, 1, 1); x.fillRect(i * 2, 15, 1, 1); continue; }
    const h = Math.max(1, Math.round(Math.min(1, v / 1800) * 20));
    x.fillStyle = v > 0 ? '#f6c445' : '#3a3460';
    x.fillRect(i * 2, 20 - h, 1, h);
  }
  c.setAttribute('aria-hidden', 'true');
  return c;
}
function routeButton(rt: RouteInfo, latest: boolean, avail?: { on: boolean; text: string }): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'route ' + rt.kind; b.dataset.route = rt.id;
  b.setAttribute('aria-pressed', String(selected === rt));
  const st = statsFor(rt.id);
  const top = document.createElement('span'); top.className = 'top';
  const names = document.createElement('span'); names.className = 'names';
  const name = document.createElement('span'); name.className = 'rn';
  name.textContent = rt.kind === 'genesis' ? 'Genesis' : rt.kind === 'lab' ? rt.label : rt === todayDaily ? "Today's Daily" : latest ? 'Daily · ' + (rt.date ?? rt.label) : rt.date ?? rt.label;
  const sub = document.createElement('span'); sub.className = 'rs';
  sub.textContent = rt.kind === 'genesis' ? 'The all-time route · Squeektoshi’s first night' : rt.kind === 'lab' ? 'Control · same rules, no wheel data' : rt === todayDaily ? `Today's route · from Squeektoshi's run of ${rt.sourceDate}` : rt.sourceDate ? `From Squeektoshi's run of ${rt.sourceDate}` : 'From the ' + rt.date + ' wheel run';
  names.append(name, sub);
  top.append(names, sparkline(rt));
  const stats = document.createElement('span'); stats.className = 'stats';
  const a = document.createElement('span'), z = document.createElement('span');
  a.textContent = st ? 'Your best ' + km(st.best) + ' km' : 'Not flown yet';
  if (avail) { z.className = 'avail ' + (avail.on ? 'on' : 'off'); z.textContent = avail.text; } else if (st) z.textContent = st.n + (st.n === 1 ? ' flight' : ' flights');
  stats.append(a, z);
  b.append(top, stats);
  b.addEventListener('click', () => { Snd.init(); select(rt); });
  b.addEventListener('dblclick', () => { Snd.init(); startRunVoid(rt); });
  return b;
}
/** The route the Fly button takes: chosen by tapping a card. */
let selected: RouteInfo | null = null;
function select(rt: RouteInfo): void {
  selected = rt;
  for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .route'))) el.setAttribute('aria-pressed', String(el.dataset.route === rt.id));
  $('btnFlyText').textContent = rt.kind === 'genesis' ? 'Fly Genesis' : rt.kind === 'lab' ? 'Fly ' + rt.label : rt === todayDaily ? "Fly today's Daily" : 'Fly Daily · ' + (rt.date ?? rt.label);
  ($('btnFly') as HTMLButtonElement).disabled = false;
}
let todayDaily: RouteInfo | null = null;
/** Practice Dailies from the server: the days before today's, newest first (null: not loaded). */
let recentDailies: RouteInfo[] | null = null;
/** Genesis opens together with the leaderboards; until then it shows as coming soon. */
let genesisOpen = false;
const fromView = (d: DailyRouteView): RouteInfo => ({ id: d.id, kind: 'daily', date: d.date, label: d.label, route: d.route, raw: d.raw, clock: d.clock, sourceDate: d.sourceDate ?? null });
/** The wheel's live status as last pushed by the server (null until the first event). */
let liveNow: { state: string; since: string | null } | null = null;
function renderMenu(): void {
  const g = $('routeGenesis'), dl = $('routeDaily'), more = $('routeDailyMore'), lab = $('routeLab');
  g.replaceChildren(); dl.replaceChildren(); more.replaceChildren(); lab.replaceChildren();
  const online = playMode === 'online' && !!backend;
  const genesis = ROUTES.find((r) => r.kind === 'genesis')!;
  // practice: the Dailies whose day is over (the server's when it answers, else those shipped with
  // the game), newest first: the latest is the main route, up to 4 earlier days below it. Genesis is
  // never practised: it is the all-time challenge.
  const practice = (recentDailies && recentDailies.length ? recentDailies : ROUTES.filter((r) => r.kind === 'daily')).slice(0, 5);
  const labs = ROUTES.filter((r) => r.kind === 'lab');
  const flyable = online ? [...(todayDaily ? [todayDaily] : []), ...(genesisOpen ? [genesis] : [])] : [...practice, ...labs];
  if (!selected || !flyable.includes(selected)) selected = flyable[0] ?? null;
  if (online) {
    const gb = routeButton(genesis, false, genesisOpen ? { on: true, text: 'Online · verified' } : undefined);
    if (!genesisOpen) {
      gb.disabled = true; gb.classList.add('soon'); gb.setAttribute('aria-label', 'Genesis: coming soon');
      const tag = document.createElement('span'); tag.className = 'soon-tag';
      tag.append('Coming soon', Object.assign(document.createElement('small'), { textContent: 'Opens with the leaderboards' }));
      gb.append(tag);
    }
    g.appendChild(gb);
    if (todayDaily) dl.appendChild(routeButton(todayDaily, true, { on: true, text: 'Online · verified' }));
    else dl.appendChild(Object.assign(document.createElement('p'), { className: 'note', textContent: "Today's Daily is not available from the server right now. Practice still works." }));
  } else {
    if (practice[0]) dl.appendChild(routeButton(practice[0], true, { on: true, text: 'Practice' }));
    else dl.appendChild(Object.assign(document.createElement('p'), { className: 'note', textContent: 'No recorded days yet.' }));
    for (const rt of practice.slice(1)) more.appendChild(routeButton(rt, false));
  }
  $('moreDays').hidden = online || practice.length < 2;
  if (!online) for (const rt of ROUTES) if (rt.kind === 'lab') lab.appendChild(routeButton(rt, false));
  $('routeLabLabel').hidden = online || PREVIEW;
  $('btnHangar').hidden = !backend; // the account is not only for online flights
  $('modePractice').setAttribute('aria-pressed', String(!online));
  $('modeOnline').setAttribute('aria-pressed', String(online));
  ($('modeOnline') as HTMLButtonElement).disabled = !backend;
  $('modeOnline').textContent = backend ? 'Online' : 'Online · soon';
  $('modeOnline').title = backend ? '' : 'Verified online flights are not open yet';
  $('menuStatusText').textContent = online ? 'Online: the server replays and verifies every flight.' : 'Practice: flights run in your browser, results stay on this device.';
  const acct = $('btnAccount'), who = backend ? hangar?.signedInLabel ?? null : null;
  acct.replaceChildren(...(who ? [avatarImg(hangar?.me()?.x?.avatarUrl, 18) ?? '', who] : ['Connect wallet']));
  acct.classList.toggle('on', !!who);
  if (selected) select(selected); else { ($('btnFly') as HTMLButtonElement).disabled = true; $('btnFlyText').textContent = 'Nothing to fly right now'; }
  const kit = `Practice kit: Bubble Shield ×2 (${GEAR_KEYS[0]}) · Spread Shot ×2 (${GEAR_KEYS[1]}) · Seed Tank ×1 (${GEAR_KEYS[2]})`;
  $('kitNote').textContent = !online && warpKm > 0 ? `Practice starts at ${warpKm} km (Flight Lab setting). Warped flights are not counted as bests.` : online ? 'Gear comes from your inventory and needs a connection to use.' : kit;
  if (online && backend) void Promise.all([player.inventory(backend), player.me(backend), liveNow ? Promise.resolve(liveNow) : player.live(backend)]).then(([inv, me, live]) => {
    const lo = hangar?.loadout;
    const gear = lo && lo.length ? 'Genesis loadout: ' + lo.map((l) => l.gearType + ' ×' + l.copies).join(', ') : inv.gear.length ? 'Gear: ' + inv.gear.map((x) => x.gearType + ' ×' + x.available).join(', ') : 'No Gear yet';
    const who = me.state === 'listed_eligible' ? `@${me.x?.handle} · listed` : me.state === 'wallet' ? 'Wallet pilot · link X to be listed' : 'Guest pilot';
    const liveTxt = live.state === 'LIVE' ? 'Squeektoshi is running · Live Drops on' : live.state === 'IDLE' ? 'Squeektoshi is resting' : live.state === 'DELAYED' ? 'Wheel data delayed' : '';
    $('kitNote').textContent = [who, gear, inv.boxes.length ? inv.boxes.length + ' unopened box' + (inv.boxes.length === 1 ? '' : 'es') : '', liveTxt].filter(Boolean).join(' · ');
  }).catch(() => { $('kitNote').textContent = 'The flight server is not answering. Practice flights still work.'; });
}
function openHelp(): void {
  $('helpOnline').textContent = backend ? '' : 'Online play opens with the closed beta.';
  showOnly('help');
}
/** A listed pilot's public profile (#pilot/<handle>), from the same data the boards show. */
let pilotFrom: 'menu' | 'hangar' = 'menu';
async function openPilot(handle: string): Promise<void> {
  pilotFrom = hangar?.visible ? 'hangar' : 'menu';
  const body = $('pilotBody'), esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  $('pilotTitle').textContent = '@' + handle;
  showOnly('pilot');
  if (!backend) { body.innerHTML = '<p class="note">Pilot profiles open with online play.</p>'; return; }
  body.innerHTML = '<p class="note">Loading…</p>';
  try {
    const p = await player.profile(backend, handle);
    if (!p) { body.innerHTML = '<p class="note">No listed pilot has this handle. Pilots appear here once they link a wallet and X.</p>'; return; }
    $('pilotTitle').replaceChildren(...[avatarImg(p.avatarUrl, 36) ?? '', '@' + p.handle]);
    const row = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    body.innerHTML = `<p class="note">Verified pilot since ${esc(p.listedSince.slice(0, 10))}</p><dl class="hg-dl">${row('Genesis', p.genesis ? `${p.genesis.rank ? '#' + p.genesis.rank + ' · ' : ''}${p.genesis.distanceKm} km` : 'No listed flight yet')}${row('Verified flights', String(p.verifiedFlights))}${row('Best verified', p.bestVerifiedKm ? p.bestVerifiedKm + ' km' : '—')}</dl>`
      + `<h3>Daily results</h3>${p.daily.length ? `<dl class="hg-dl">${p.daily.map((d) => row(d.date, `${d.rank ? '#' + d.rank + ' · ' : ''}${d.distanceKm} km`)).join('')}</dl>` : '<p class="note">No listed Daily results yet.</p>'}`
      + `<h3>Collection</h3>${p.collection.length ? `<dl class="hg-dl">${p.collection.map((c) => row(c.name, `${c.tier}${c.copies > 1 ? ' ×' + c.copies : ''}`)).join('')}</dl>` : '<p class="note">No cosmetics yet.</p>'}`;
  } catch { body.innerHTML = '<p class="note">The flight server did not answer. Check your connection and try again.</p>'; }
}
/** Wallet and X: the Hangar's sign-in when a flight server is available; otherwise the real status. */
type HangarTab = 'pilot' | 'inventory' | 'collection' | 'flights' | 'boards';
/** Wallet, X, profile and the rest of the account: the Hangar (real sign-in, real data) whenever the
 *  online service answers; otherwise an honest status of why it is not available here. */
function openAccount(tab: HangarTab = 'pilot', focus: 'wallet' | 'x' | null = null): void {
  if (backend && hangar) {
    showOnly('hangar');
    const h = hangar;
    void h.show(tab).then(() => { if (focus === 'wallet' && !h.me()?.wallet) h.openWallets(); });
    return;
  }
  const configured = !!(window as unknown as { SQK_BACKEND?: unknown }).SQK_BACKEND;
  $('accountText').textContent = configured
    ? 'The SqueekRaid online service is not answering right now, so sign-in and your profile cannot load. Check your connection and try again.'
    : 'Wallet sign-in, X linking and pilot profiles run on the SqueekRaid online service, which this site is not connected to yet. They open with the closed beta.';
  const acts = $('accountActs'); acts.replaceChildren();
  const row = (label: string, hint: string, hot: boolean) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (hot ? '' : ' ghost'); b.disabled = true; b.textContent = label; b.title = hint; b.setAttribute('aria-describedby', 'accountText');
    acts.appendChild(b);
  };
  row('Connect wallet', 'Needs the online service', focus === 'wallet');
  row('Link X', 'Needs the online service and a connected wallet', focus === 'x');
  row('My profile', 'Needs the online service', focus === null && tab === 'pilot');
  if (configured) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = 'Try again';
    retry.addEventListener('click', () => { void detectBackend().then((b) => { if (b) location.reload(); else retry.textContent = 'Still not answering'; }); });
    acts.appendChild(retry);
  }
  if (FOLLOW_X) { const a = document.createElement('a'); a.className = 'btn ghost'; a.href = FOLLOW_X; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Follow us on X'; acts.appendChild(a); }
  const fly = document.createElement('button'); fly.type = 'button'; fly.className = 'btn ghost'; fly.textContent = 'Fly practice'; fly.addEventListener('click', () => { showOnly('menu'); Snd.init(); startRunVoid(selected ?? ROUTES[0]!); }); acts.appendChild(fly);
  showOnly('account');
}
function renderLab(): void {
  if (PREVIEW) return; // the public preview has no Flight Lab
  const rows = ROUTES.map((rt) => [rt, statsFor(rt.id)] as const).filter((x) => x[1]);
  const t = $('labTable');
  if (!rows.length) t.innerHTML = '<p class="note empty">No flights yet. Results per route collect here so you can compare how hard each river feels.</p>';
  else {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
    t.innerHTML = '<table class="log"><thead><tr><th>Route</th><th class="n">Flights</th><th class="n">Median</th><th class="n">Best</th></tr></thead><tbody>' +
      rows.map(([rt, st]) => '<tr><td>' + esc(rt.kind === 'genesis' ? 'Genesis' : rt.kind === 'lab' ? 'Neutral' : rt.date ?? rt.id) + '</td><td class="n">' + st!.n + '</td><td class="n">' + km(st!.median) + '</td><td class="n">' + km(st!.best) + '</td></tr>').join('') + '</tbody></table>';
  }
  const recent = getLog().slice(-8).reverse();
  const ul = $('labRecent'); ul.replaceChildren();
  if (!recent.length) { const li = document.createElement('li'); li.textContent = 'Nothing flown yet.'; ul.appendChild(li); }
  for (const e of recent) {
    const rt = ROUTES.find((x) => x.id === e.r);
    const li = document.createElement('li');
    const a = document.createElement('span'); a.textContent = (rt ? (rt.kind === 'genesis' ? 'Genesis' : rt.kind === 'lab' ? 'Neutral' : rt.date) : e.r) + ' · ' + (CAUSE[e.c] ?? e.c).toLowerCase();
    const b = document.createElement('b'); b.textContent = km(e.m) + ' km';
    li.append(a, b); ul.appendChild(li);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(a: string, b: string, ms = 1800, calm = false): void {
  $('toast1').textContent = a; $('toast2').textContent = b;
  const t = $('toast'); t.classList.toggle('calm', calm); t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ======================= wiring =======================
let clearArmed = false;
function wire(): void {
  $('btnPause').addEventListener('click', togglePause);
  $('btnResume').addEventListener('click', resume);
  $('btnQuit').addEventListener('click', goMenu);
  $('btnFly').addEventListener('click', () => { if (!selected) return; Snd.init(); startRunVoid(selected); });
  $('btnHelp').addEventListener('click', openHelp);
  $('helpBack').addEventListener('click', () => showOnly('menu'));
  $('btnAccount').addEventListener('click', () => openAccount('pilot', hangar?.signedInLabel ? null : 'wallet'));
  $('accountBack').addEventListener('click', () => showOnly('menu'));
  $('pilotBack').addEventListener('click', () => { if (location.hash.startsWith('#pilot/')) history.replaceState(null, '', location.pathname + location.search); if (pilotFrom === 'hangar' && hangar) { showOnly('hangar'); hangar.show(); } else showOnly('menu'); });
  if (HOME_URL) ($('btnHome') as HTMLAnchorElement).href = HOME_URL; else $('btnHome').hidden = true;
  $('btnAgain').addEventListener('click', () => startRunVoid(lastRun ? lastRun.route : session?.route ?? ROUTES[0]!));
  $('btnRoutes').addEventListener('click', goMenu);
  $('btnReplaySpeed').addEventListener('click', cycleReplaySpeed);
  for (let i = 0; i < 3; i++) {
    const el = $('gs' + i);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); Snd.init(); pressGear(i); });
  }
  $('modePractice').addEventListener('click', () => { playMode = 'practice'; store.set('sqa.v3.mode', playMode); renderMenu(); });
  $('modeOnline').addEventListener('click', () => { if (!backend) return; playMode = 'online'; store.set('sqa.v3.mode', playMode); renderMenu(); });
  const sb = $('btnSound');
  const paintSound = () => { sb.setAttribute('aria-pressed', String(Snd.on)); sb.setAttribute('aria-label', Snd.on ? 'Sound on' : 'Sound off'); ($('sndWave') as unknown as SVGElement).style.display = Snd.on ? '' : 'none'; };
  paintSoundBtn = paintSound;
  paintSound();
  sb.addEventListener('click', () => { Snd.init(); Snd.setOn(!Snd.on); settings = { ...settings, sound: Snd.on }; saveLocal(settings); paintSound(); });
  $('btnSettings').addEventListener('click', () => openSettings('menu'));
  const ws = $('warpSel') as HTMLSelectElement;
  ws.value = String(warpKm);
  ws.addEventListener('change', () => { warpKm = Number(ws.value) || 0; store.set('sqa.v3.warp', warpKm); renderMenu(); });
  $('btnGrant').addEventListener('click', () => { if (!backend) return; void devGrant(backend).then((ok) => { $('labMsg').textContent = ok ? 'Added 4 shield, 4 spread, 4 seed to this guest (valid until 00:00 UTC).' : 'The server refused the test grant.'; renderMenu(); }); });
  $('btnLabOpen').addEventListener('click', () => { $('lab').classList.add('open'); renderLab(); });
  $('btnHangar').addEventListener('click', () => { if (!hangar) return; showOnly('hangar'); void hangar.show('pilot'); });
  $('btnLabClose').addEventListener('click', () => $('lab').classList.remove('open'));
  $('btnClearLog').addEventListener('click', () => {
    const b = $('btnClearLog');
    if (!clearArmed) { clearArmed = true; b.textContent = 'Tap again to clear'; setTimeout(() => { clearArmed = false; b.textContent = 'Clear run log'; }, 3000); return; }
    store.set(LOG_KEY, []); clearArmed = false; b.textContent = 'Clear run log';
    renderLab(); renderMenu();
  });
  window.addEventListener('offline', () => { showToast('Connection lost', mode === 'play' && session?.mode === 'online' ? 'Keep flying: the flight resumes its link when the network returns' : 'Practice flights still work', 2500, true); if (mode === 'menu') renderMenu(); });
  window.addEventListener('online', () => { showToast('Back online', '', 1500, true); if (mode === 'menu') renderMenu(); });
  document.addEventListener('click', (e) => { const t = e.target as HTMLElement | null; if (t?.closest('.btn, .route, .modes button, .hg-tabs button')) { Snd.init(); Snd.ui(); } }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseSteer(); autoPause('hidden'); } });
  window.addEventListener('pagehide', () => { if (session && (mode === 'play' || mode === 'paused' || mode === 'dying')) session.abandon('pagehide'); });
}

let padOn: boolean | null = null;
function loop(ts: number): void {
  requestAnimationFrame(loop);
  // FIRE only while flying (play, paused, the crash, a replay): never on the menus or the results card
  const fly = mode === 'play' || mode === 'paused' || mode === 'dying' || mode === 'replay';
  if (fly !== padOn) { padOn = fly; document.body.classList.toggle('flying', fly); layout(); }
  if (!lastTs) lastTs = ts;
  const dtMs = ts - lastTs; lastTs = ts;
  if (mode === 'paused') { paintPause(); render(); return; }
  if (dtMs > CATCH_UP_MS && mode === 'play') {
    // a gap longer than 2 s is a suspension, not jank: do not fast-forward the flight
    acc = 0;
    autoPause('suspended');
    render();
    return;
  }
  const rate = mode === 'replay' ? replaySpeed : 1;
  if (testFrozen) { acc = 0; render(); return; } // tests only: hold the flight still while input is checked
  acc += Math.min(dtMs, CATCH_UP_MS) * rate;
  let n = 0;
  const maxN = Math.ceil((CATCH_UP_MS / STEP_MS) * rate);
  while (acc >= STEP_MS && n < maxN) {
    frameNo++;
    if (mode === 'play' || mode === 'replay') stepOnce();
    else if (mode === 'dying') updateDeath();
    else if (mode === 'menu') updateAttract();
    updateEffects();
    acc -= STEP_MS; n++;
  }
  render();
}

// ======================= boot =======================
async function boot(): Promise<void> {
  setupTouch();
  wire();
  layout();
  window.addEventListener('resize', layout);
  try { new ResizeObserver(layout).observe($('screenBox')); } catch { /* older browsers: resize event is enough */ }
  atlas.onload = () => { artReady = true; buildPatterns(); renderMenu(); };
  atlas.src = ART.src;
  goMenu();
  requestAnimationFrame(loop);
  void document.fonts?.ready.then(layout);
  backend = await detectBackend();
  $('btnGrant').hidden = !backend;
  if (backend) {
    hangar = new Hangar(backend, $('hangar'));
    liveStream(backend, (v) => { const changed = liveNow?.state !== v.state; liveNow = v; if (changed && mode === 'menu' && playMode === 'online') renderMenu(); });
    hangar.sfx = (k) => { Snd.init(); if (k === 'shake') Snd.boxShake(); else Snd.boxBurst(); };
    hangar.onChange = () => { if (mode !== 'menu') return; if (!hangar!.visible) showOnly('menu'); renderMenu(); };
    await hangar.refresh();
    try {
      // the account's controls follow the player to other devices; a local change since then is kept
      const remote = await player.getSettings(backend);
      if (remote && remote.bindings && localStorage.getItem('sqa.v3.settings') === null) { const n = { ...settings, ...remote, bindings: { ...settings.bindings, ...remote.bindings } }; applySettings(n); saveLocal(n); }
    } catch { /* offline: local settings stand */ }
    try {
      const d: DailyRouteView | null = await player.currentDaily(backend);
      if (d) todayDaily = fromView(d);
    } catch { /* stays practice-only */ }
    try { recentDailies = (await player.recentDailies(backend)).map(fromView); } catch { /* the Dailies shipped with the game */ }
    try { genesisOpen = await player.genesisOpen(backend); } catch { /* stays coming soon */ }
    // back from X: show the outcome in the Hangar
    let xr = new URLSearchParams(location.search).get('x');
    if (xr) {
      // the one-time ticket arrives in the fragment; drop it and the status from the address at once
      const ticket = /(?:^#|&)xt=([A-Za-z0-9_-]{20,100})/.exec(location.hash)?.[1];
      history.replaceState(null, '', location.pathname);
      if (xr === 'pending') {
        if (!ticket) xr = 'x_bad_callback';
        else { try { const r = await player.xComplete(backend, ticket); xr = r.result ?? r.code ?? 'x_failed'; } catch { xr = 'x_unavailable'; } }
      }
      showOnly('hangar'); hangar.show('pilot');
      showToast('X', xr === 'linked' ? 'X linked: your verified flights are listed' : xr === 'refreshed' ? 'Handle refreshed' : 'X was not linked (' + xr.replace(/_/g, ' ') + ')', 3500, xr === 'linked' || xr === 'refreshed');
    }
  }
  if (mode === 'menu') renderMenu();
  // the website's Wallet / Connect X buttons land here
  const onHash = () => {
    if (mode !== 'menu') return;
    // website and in-game links: #account #profile #wallet #x #inventory #collection #flights #boards #pilot/<handle>
    const h = location.hash, m = /^#pilot\/@?([A-Za-z0-9_]{1,15})$/.exec(h);
    if (m) void openPilot(m[1]!);
    else if (h === '#account' || h === '#profile') openAccount('pilot');
    else if (h === '#wallet') openAccount('pilot', 'wallet');
    else if (h === '#x') openAccount('pilot', 'x');
    else if (h === '#inventory' || h === '#collection' || h === '#flights' || h === '#boards') openAccount(h.slice(1) as HangarTab);
  };
  window.addEventListener('hashchange', onHash);
  onHash();
}
void boot();

// read-only handle and an input override for automated tests and scripted captures (left out of the
// public preview build)
declare const __TEST_HOOKS__: boolean;
if (__TEST_HOOKS__) (window as unknown as { __squeek: unknown }).__squeek = {
  mask: () => liveMask(),
  steer: () => ({ ...steer, planeX: sim ? sim.px / U : null }),
  /** Hold the flight still (no frames advance) so input handling can be checked without racing the clock. */
  freeze: (on: boolean) => { testFrozen = on; },
  state: () => ({ mode, sim, session: session ? { mode: session.mode, link: session.link(), status: session.status() } : null, lastRun }),
  setMask: (m: number | ((s: S.StateV3) => number) | null) => { testMask = m; },
  pressGear,
  start: (id: string) => { const rt = id === 'today' ? todayDaily : ROUTES.find((r) => r.id === id) ?? recentDailies?.find((r) => r.id === id); if (rt) startRunVoid(rt); },
  setMode: (m: 'practice' | 'online') => { playMode = m; renderMenu(); },
};
