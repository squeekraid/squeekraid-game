// Cosmetic scenery: bank detail per biome and screen-space weather. Rendering only. Nothing here reads
// or writes the simulation, so collision geometry, routes and replays are unaffected. Particles use
// Math.random freely for that reason.
export interface Biome { name: string; bank: string; dark: string; light: string; edge: string; water: string; wdark: string; wlight: string; foam: string }

/** Ground details on one bank span [x0, x1) of a row. Never drawn within 5 px of the waterline. */
export function bankDetail(ctx: CanvasRenderingContext2D, bi: number, b: Biome, x0: number, x1: number, y: number, rowPx: number, h: number, frame: number): void {
  const a = x0 + 1, z = x1 - 1;
  if (z - a < 4) return;
  const at = (k: number) => a + ((h >>> k) % (z - a));
  const px = (x: number, yy: number, w: number, hh: number, c: string) => { if (x >= a && x + w <= z) { ctx.fillStyle = c; ctx.fillRect(x, yy, w, hh); } };
  switch (bi) {
    case 0: { // meadow: grass tufts and wildflowers
      if (h % 3 === 0) { const x = at(4); px(x, y + 1, 1, 3, b.light); px(x + 2, y + 2, 1, 2, b.light); px(x + 1, y + 3, 1, 1, b.dark); }
      if (h % 7 === 1) px(at(9), y + 2, 1, 1, ['#ff9ecb', '#ffe066', '#ffffff', '#b8a4ff'][(h >>> 3) & 3]!);
      if (h % 11 === 2) { const x = at(13); px(x, y + 1, 2, 2, b.dark); px(x, y + 1, 1, 1, b.light); }
      break;
    }
    case 1: { // dune: wind ripples and pebbles
      if (h % 2 === 0) { const x = at(5), w = 3 + ((h >>> 2) % 5); px(x, y + 2, w, 1, b.light); px(x + 1, y + 3, w, 1, b.dark); }
      if (h % 9 === 3) px(at(11), y + 1, 2, 1, b.edge);
      break;
    }
    case 2: { // frost: drift shadows and glints that catch the light
      if (h % 3 === 1) { const x = at(6), w = 4 + ((h >>> 2) % 6); px(x, y + 3, w, 1, b.dark); }
      if (h % 5 === 2 && ((frame >> 3) + h) % 6 === 0) px(at(10), y + 1, 1, 1, '#ffffff');
      if (h % 5 === 2) px(at(10) + 1, y + 1, 1, 1, '#dbe8ff');
      break;
    }
    case 3: { // night marsh: dark pools and moss
      if (h % 4 === 0) { const x = at(5); px(x, y + 1, 4, 3, b.edge); px(x + 1, y + 1, 2, 1, '#22406a'); }
      if (h % 3 === 1) px(at(9), y + 2, 1, 1, b.light);
      break;
    }
    case 4: { // ember gorge: lava cracks that glow and fade, ash flecks
      if (h % 3 === 0) {
        const x = at(5), glow = ((frame >> 2) + (h & 31)) % 32, hot = glow < 16 ? glow : 32 - glow;
        const c = hot > 11 ? '#ffd27a' : hot > 6 ? '#ff8a3d' : '#b9412a';
        px(x, y + 1, 1, rowPx - 2, c); px(x + 1, y + 2, 1, 1, c);
      }
      if (h % 5 === 4) px(at(12), y + 3, 1, 1, '#8c6f6a');
      break;
    }
  }
}

/** Sun glints and ripples in open water (1 px, never shaped like an object). */
export function waterGlint(ctx: CanvasRenderingContext2D, bi: number, b: Biome, l: number, r: number, y: number, h: number, frame: number): void {
  if (r - l < 20 || h % 4 !== 0) return;
  const x = l + 6 + ((h >>> 6) % (r - l - 12));
  const on = ((frame >> 3) + (h & 15)) % 8;
  if (on > 2) return;
  ctx.fillStyle = bi === 4 ? '#ff9d5c' : bi === 3 ? '#6f8fc9' : b.foam;
  ctx.fillRect(x, y + 2, on === 1 ? 3 : 1, 1);
}

interface P { x: number; y: number; vx: number; vy: number; s: number; t: number }
/** Screen-space weather per biome, cross-fading as the river changes biome. */
export class Weather {
  private readonly w: number;
  private readonly h: number;
  private mix = [1, 0, 0, 0, 0];
  private ps: P[][] = [[], [], [], [], []];
  private vign: (HTMLCanvasElement | null)[] = [null, null, null, null, null];
  constructor(w: number, h: number) { this.w = w; this.h = h; }

  update(bi: number, reduced: boolean): void {
    for (let i = 0; i < 5; i++) this.mix[i] = Math.max(0, Math.min(1, this.mix[i]! + (i === bi ? 0.02 : -0.02)));
    if (reduced) { for (const l of this.ps) l.length = 0; return; }
    const W = this.w, H = this.h, R = Math.random;
    const spawn = (i: number, n: number, mk: () => P) => { if (this.mix[i]! > 0.05) while (this.ps[i]!.length < n) this.ps[i]!.push(mk()); };
    spawn(0, 14, () => ({ x: R() * W, y: R() * H, vx: 0.15 + R() * 0.2, vy: 0.25 + R() * 0.3, s: 1, t: R() * 100 }));
    spawn(1, 26, () => ({ x: -R() * W, y: R() * H, vx: 2.2 + R() * 1.6, vy: 0.3, s: R() < 0.3 ? 2 : 1, t: 0 }));
    spawn(2, 70, () => ({ x: R() * W, y: -R() * H, vx: 0, vy: 0.5 + R() * 0.7, s: R() < 0.25 ? 2 : 1, t: R() * 100 }));
    spawn(3, 12, () => ({ x: R() * W, y: R() * H, vx: 0, vy: 0, s: 1, t: R() * 200 }));
    spawn(4, 30, () => ({ x: R() * W, y: H + R() * H, vx: 0, vy: -(0.4 + R() * 0.7), s: R() < 0.2 ? 2 : 1, t: R() * 100 }));
    for (let i = 0; i < 5; i++) {
      const l = this.ps[i]!;
      for (let k = l.length - 1; k >= 0; k--) {
        const p = l[k]!; p.t++;
        if (i === 2) p.vx = Math.sin(p.t / 30) * 0.3;
        if (i === 3) { p.vx = Math.sin(p.t / 40) * 0.25; p.vy = Math.cos(p.t / 53) * 0.2; }
        if (i === 4) p.vx = Math.sin(p.t / 20) * 0.35;
        p.x += p.vx; p.y += p.vy;
        const gone = p.y > H + 4 || p.x > W + 4 || p.y < -4 && i === 4;
        if (gone || this.mix[i]! <= 0.05) {
          if (this.mix[i]! <= 0.05) l.splice(k, 1);
          else { if (i === 1) { p.x = -4; p.y = R() * H; } else if (i === 4) { p.y = H + 2; p.x = R() * W; } else { p.y = -2; p.x = R() * W; } }
        }
      }
    }
  }

  private vignette(i: number, ctx: CanvasRenderingContext2D): HTMLCanvasElement {
    const have = this.vign[i];
    if (have) return have;
    const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
    const x = c.getContext('2d')!;
    const tint = ['rgba(255,236,170,0)', 'rgba(120,60,10,.16)', 'rgba(170,200,255,.18)', 'rgba(4,8,24,.55)', 'rgba(60,8,4,.42)'][i]!;
    const g = x.createRadialGradient(this.w / 2, this.h * 0.55, this.h * 0.25, this.w / 2, this.h * 0.55, this.h * 0.75);
    g.addColorStop(0, tint.replace(/[\d.]+\)$/, '0)')); g.addColorStop(1, tint);
    x.fillStyle = g; x.fillRect(0, 0, this.w, this.h);
    void ctx;
    this.vign[i] = c;
    return c;
  }

  draw(ctx: CanvasRenderingContext2D, frame: number): void {
    for (let i = 0; i < 5; i++) {
      const m = this.mix[i]!;
      if (m <= 0.01) continue;
      if (i !== 0) { ctx.globalAlpha = m; ctx.drawImage(this.vignette(i, ctx), 0, 0); }
      for (const p of this.ps[i]!) {
        let c = '#fff';
        if (i === 0) { c = '#fff3b0'; ctx.globalAlpha = m * (0.4 + 0.4 * Math.abs(Math.sin(p.t / 25))); }
        else if (i === 1) { c = '#fbe2b0'; ctx.globalAlpha = m * 0.5; }
        else if (i === 2) { c = '#ffffff'; ctx.globalAlpha = m * 0.85; }
        else if (i === 3) { c = '#d4ff4a'; ctx.globalAlpha = m * Math.max(0, Math.sin(p.t / 18)); }
        else { c = p.s > 1 ? '#ffd27a' : '#ff7a3a'; ctx.globalAlpha = m * (0.5 + 0.5 * Math.abs(Math.sin((p.t + frame) / 9))); }
        ctx.fillStyle = c;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), i === 1 ? p.s + 1 : p.s, p.s);
      }
      if (i === 3) { // drifting mist: soft bands, dithered at the edges
        ctx.fillStyle = '#9fb7e0';
        for (let k = 0; k < 3; k++) {
          const yy = Math.round(((frame * 0.15 + k * 150) % (this.h + 60)) - 30);
          for (let d = 0; d < 14; d++) { ctx.globalAlpha = m * 0.06 * Math.sin((d / 14) * Math.PI); ctx.fillRect(0, yy + d, this.w, 1); }
        }
      }
      if (i === 0) { // cloud shadows drifting over the meadow
        ctx.globalAlpha = m * 0.08; ctx.fillStyle = '#10301a';
        for (let k = 0; k < 2; k++) {
          const cx = ((frame * 0.12 + k * 140) % (this.w + 120)) - 60, cy = ((frame * 0.35 + k * 230) % (this.h + 120)) - 60;
          for (let d = -14; d <= 14; d++) { const half = Math.round(Math.sqrt(196 - d * d) * 2.2); ctx.fillRect(Math.round(cx - half), Math.round(cy + d), half * 2, 1); }
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
