// Online sessions: the flight API and the flight gateway. Inputs stream to the gateway in 100 ms
// chunks and are buffered while offline; Gear waits for a committed outcome (A1/A1r); Pause is
// budgeted by the server; the worker verifies the flight after Game Over.
import type * as S from '@sqk/sim/v3';
import { getAddress } from 'viem';
import type { RouteInfo } from '@sqk/routes';
import { GearActivationClient } from '@sqk/protocol/gear-client';
import type { GearUseOutcome, ServerMessage } from '@sqk/protocol';
import type { FlightEnd, Link, Session, SlotView } from './session.ts';

declare const __SIM_BUILD__: string;
export const SIM_BUILD: string = typeof __SIM_BUILD__ === 'string' ? __SIM_BUILD__ : '';

export interface Backend { readonly api: string }

/** A backend is offered only when the page was served by the local stack (window.SQK_BACKEND). */
export async function detectBackend(): Promise<Backend | null> {
  const cfg = (window as unknown as { SQK_BACKEND?: Backend }).SQK_BACKEND;
  if (!cfg || !SIM_BUILD) return null;
  try { const r = await fetch(cfg.api + '/healthz'); return r.ok ? cfg : null; } catch { return null; }
}

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

/** A sensitive write carries an Idempotency-Key; a network failure is retried once with the same key. */
export interface FlightRow { id: string; routeId: string; phase: string; startedAt: string; endedAt: string | null; endReason: string | null; distanceM: number | null; appeal?: 'available' | { id: string; status: string; reason: string | null } | null }
async function api<T>(b: Backend, path: string, init: RequestInit & { token?: string; idempotent?: boolean } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.idempotent) headers['idempotency-key'] = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
  let r: Response;
  try { r = await fetch(b.api + path, { ...init, headers }); }
  catch (e) { if (!init.idempotent) throw e; await new Promise((res) => setTimeout(res, 800)); r = await fetch(b.api + path, { ...init, headers }); }
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as T };
}

export async function guestToken(b: Backend): Promise<string> {
  const have = store.get('sqa.v3.token');
  if (have) {
    const r = await api<{ gear?: unknown }>(b, '/v1/inventory', { token: have });
    if (r.status === 200) return have;
  }
  const r = await api<{ token: string }>(b, '/v1/session/guest', { method: 'POST', body: '{}' });
  store.set('sqa.v3.token', r.body.token);
  return r.body.token;
}

export async function inventory(b: Backend): Promise<{ gearType: string; available: number }[]> {
  const t = await guestToken(b);
  const r = await api<{ gear: { gearType: string; available: number }[] }>(b, '/v1/inventory', { token: t });
  return r.body.gear ?? [];
}

/** Local server only: put test Gear in this guest's inventory (the endpoint exists only in development). */
export async function devGrant(b: Backend): Promise<boolean> {
  const t = await guestToken(b);
  let ok = true;
  for (const g of ['shield', 'spread', 'seed']) ok = (await api(b, '/v1/dev/grant', { method: 'POST', token: t, body: JSON.stringify({ gearType: g, copies: 4 }) })).status === 201 && ok;
  return ok;
}

interface StartResponse { flightId: string; flightKey: string; gatewayUrl: string; params: S.FlightParamsV3; pinned: { clock: { pauseBudgetMs: number } }; route?: S.RouteV3; label?: string; rewardCommitment?: string | null; error?: string; message?: string; routeId?: string; startedAt?: string }

/** Another flight of this account is in progress (another tab or device). Never ended silently. */
export class ActiveFlightError extends Error {
  readonly flightId: string; readonly routeId: string | null; readonly startedAt: string | null;
  constructor(flightId: string, routeId: string | null, startedAt: string | null) { super('A flight is already in progress on this account.'); this.flightId = flightId; this.routeId = routeId; this.startedAt = startedAt; }
}

/** Ends the account's other flight after the player confirmed it. */
export async function invalidateFlight(b: Backend, flightId: string): Promise<boolean> {
  const t = await guestToken(b);
  return (await api<{ ended?: boolean }>(b, `/v1/flights/${flightId}/invalidate`, { method: 'POST', token: t, body: '{}', idempotent: true })).status === 200;
}

// ------------------------------------------------------------------ player API (M3/M4)
export interface MeView { accountId: string; state: 'guest' | 'wallet' | 'listed_eligible'; wallet: { address: string; kind: string } | null; x: { handle: string; avatarUrl?: string | null } | null; listingRestricted: boolean; activeFlight: { flightId: string; routeId: string | null; startedAt: string } | null }
export interface InventoryView { gear: { gearType: string; available: number; reserved: number; soonestExpiry: string | null }[]; boxes: { id: string; flightId: string; expiresAt: string }[] }
export interface CollectionView { holdings: { itemId: string; name: string; kind: string; tier: string; copies: number; firstAcquired: string }[]; pendingClaims: { itemId: string; name: string; tier: string; deadline: string }[] }
export interface BoardView { board: { id: string; state: string; gameDate?: string | null }; entries: { rank: number; handle: string; distanceKm: string; gameOverAt: string; gearUsed: Record<string, number> }[]; me: { rank: number | null; listed: boolean; distanceKm: string; gameOverAt: string } | null }
export interface DailyRouteView { id: string; kind: 'daily'; date: string; label: string; sourceDate?: string | null; route: S.RouteV3; raw: (number | null)[]; clock: string[] }

/** Live wheel status pushed by the server (SSE), falling back to polling /v1/live every 30 s when
 *  the stream is unavailable (no EventSource, a proxy that buffers, repeated errors). Returns a stop function. */
export function liveStream(b: Backend, on: (v: { state: string; since: string | null }) => void): () => void {
  let es: EventSource | null = null, poll: ReturnType<typeof setInterval> | null = null, errors = 0, stopped = false;
  const startPolling = () => {
    if (poll || stopped) return;
    const once = () => { void player.live(b).then(on).catch(() => on({ state: 'NO_DATA', since: null })); };
    once(); poll = setInterval(once, 30_000);
  };
  if (typeof EventSource === 'undefined') startPolling();
  else {
    es = new EventSource(`${b.api}/v1/live/stream`);
    es.addEventListener('live', (e) => { errors = 0; try { on(JSON.parse((e as MessageEvent<string>).data) as { state: string; since: string | null }); } catch { /* ignore a bad frame */ } });
    es.onerror = () => { if (++errors >= 3) { es?.close(); es = null; startPolling(); } };
  }
  return () => { stopped = true; es?.close(); if (poll) clearInterval(poll); };
}

export interface PublicProfile { handle: string; avatarUrl?: string | null; listedSince: string; genesis: { rank: number | null; distanceKm: string } | null; daily: { date: string; rank: number | null; distanceKm: string }[]; verifiedFlights: number; bestVerifiedKm: string | null; collection: { name: string; tier: string; kind: string; copies: number }[] }
export const player = {
  async me(b: Backend): Promise<MeView> { return (await api<MeView>(b, '/v1/me', { token: await guestToken(b) })).body; },
  async inventory(b: Backend): Promise<InventoryView> { return (await api<InventoryView>(b, '/v1/me/inventory', { token: await guestToken(b) })).body; },
  async openBox(b: Backend, id: string): Promise<{ gearType?: string; validUntil?: string; message?: string }> { return (await api<{ gearType?: string; validUntil?: string; message?: string }>(b, `/v1/me/boxes/${id}/open`, { method: 'POST', token: await guestToken(b), body: '{}', idempotent: true })).body; },
  async collection(b: Backend): Promise<CollectionView> { return (await api<CollectionView>(b, '/v1/me/collection', { token: await guestToken(b) })).body; },
  async board(b: Backend, which: 'genesis' | { date: string }): Promise<BoardView> { return (await api<BoardView>(b, which === 'genesis' ? '/v1/boards/genesis' : `/v1/boards/daily/${which.date}`, { token: await guestToken(b) })).body; },
  /** null when no listed pilot has the handle. */
  async profile(b: Backend, handle: string): Promise<PublicProfile | null> { const r = await api<PublicProfile>(b, `/v1/players/${encodeURIComponent(handle)}`); return r.status === 404 ? null : r.body; },
  async beta(b: Backend): Promise<{ mode: string; tester: boolean }> { return (await api<{ mode: string; tester: boolean }>(b, '/v1/me/beta', { token: await guestToken(b) })).body; },
  async redeemBeta(b: Backend, code: string): Promise<{ ok: boolean; message: string }> {
    const r = await api<{ message?: string }>(b, '/v1/me/beta/redeem', { method: 'POST', token: await guestToken(b), body: JSON.stringify({ code }) });
    return { ok: r.status === 200, message: r.status === 200 ? 'Welcome to the closed beta: online flights are open for you.' : (r.body.message ?? 'The code was not accepted.') };
  },
  async flights(b: Backend): Promise<{ flights: FlightRow[] }> { return (await api<{ flights: FlightRow[] }>(b, '/v1/me/flights', { token: await guestToken(b) })).body; },
  /** Ask a person to look again at a held or reviewed flight. */
  async appeal(b: Backend, flightId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const r = await api<{ message?: string }>(b, '/v1/me/appeals', { method: 'POST', token: await guestToken(b), body: JSON.stringify({ subject: { kind: 'flight', id: flightId }, message }) });
    return { ok: r.status === 201, message: r.status === 201 ? 'Sent. A person will review it and you will see the decision and the reason here.' : (r.body.message ?? 'Could not send the request.') };
  },
  async live(b: Backend): Promise<{ state: string; since: string | null }> { return (await api<{ state: string; since: string | null }>(b, '/v1/live')).body; },
  async currentDaily(b: Backend): Promise<DailyRouteView | null> { const r = await api<DailyRouteView>(b, '/v1/routes/daily/current'); return r.status === 200 ? r.body : null; },
  /** The Dailies before today's, newest first (practice routes). */
  async recentDailies(b: Backend): Promise<DailyRouteView[]> { const r = await api<{ routes: DailyRouteView[] }>(b, '/v1/routes/daily/recent'); return r.status === 200 ? r.body.routes : []; },
  /** Genesis opens together with the leaderboards. */
  async genesisOpen(b: Backend): Promise<boolean> { const r = await api<{ open: boolean }>(b, '/v1/routes/genesis'); return r.status === 200 && r.body.open === true; },
  async getSettings(b: Backend): Promise<Partial<{ bindings: Record<string, string[]>; sound: boolean; reducedMotion: boolean }> | null> { const r = await api<Partial<{ bindings: Record<string, string[]>; sound: boolean; reducedMotion: boolean }>>(b, '/v1/me/settings', { token: await guestToken(b) }); return r.status === 200 ? r.body : null; },
  async putSettings(b: Backend, s: { bindings: Record<string, string[]>; sound: boolean; reducedMotion: boolean }): Promise<boolean> { return (await api(b, '/v1/me/settings', { method: 'PUT', token: await guestToken(b), body: JSON.stringify(s) })).status === 200; },
  async xStart(b: Backend): Promise<{ url?: string; message?: string }> { return (await api<{ url?: string; message?: string }>(b, '/v1/auth/x/start?json=1', { token: await guestToken(b) })).body; },
  /** Back from X: finish the link with the one-time ticket and this page's session. */
  async xComplete(b: Backend, ticket: string): Promise<{ result?: string; code?: string; message?: string }> { return (await api<{ result?: string; code?: string; message?: string }>(b, '/v1/auth/x/complete', { method: 'POST', token: await guestToken(b), body: JSON.stringify({ ticket }) })).body; },
  async logout(b: Backend): Promise<void> { await api(b, '/v1/auth/logout', { method: 'POST', token: await guestToken(b), body: '{}' }); store.set('sqa.v3.token', ''); },
  /** SIWE with an EIP-1193 wallet. The server's nonce response names the exact domain, URI and chain. */
  async signIn(b: Backend, provider: Eip1193): Promise<{ result?: string; message?: string; me?: MeView }> {
    const token = await guestToken(b);
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const address = accounts[0];
    if (!address) throw new Error('The wallet shared no address.');
    const n = (await api<{ nonce: string; domain: string; uri: string; chainId: number; issuedAt: string; statement: string }>(b, '/v1/auth/siwe/nonce', { method: 'POST', token, body: '{}' })).body;
    const message = `${n.domain} wants you to sign in with your Ethereum account:\n${checksum(address)}\n\n${n.statement}\n\nURI: ${n.uri}\nVersion: 1\nChain ID: ${n.chainId}\nNonce: ${n.nonce}\nIssued At: ${n.issuedAt}`;
    const hex = '0x' + Array.from(new TextEncoder().encode(message), (x) => x.toString(16).padStart(2, '0')).join('');
    const signature = (await provider.request({ method: 'personal_sign', params: [hex, address] })) as string;
    const r = await api<{ result?: string; message?: string; token?: string; me?: MeView }>(b, '/v1/auth/siwe/verify', { method: 'POST', token, body: JSON.stringify({ message, signature }) });
    if (r.body.token) store.set('sqa.v3.token', r.body.token);
    return r.body;
  },
};
export interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
/** EIP-4361 requires the EIP-55 checksummed address. */
function checksum(a: string): string { return getAddress(a); }
interface FlightStatus { phase: string; endReason: string | null; distanceM: number | null; reward: { boxesGranted: number; dropsGranted?: number; dropsClaimable?: number; spawns: { delivery: string; kind?: string }[]; seed: string | null } | null; report: { verdict: string; reasons: string[]; unwitnessedShare: number; unwitnessedFrames: number; inputsReproduceResult: boolean; gearEdgesPaid: boolean } | null }

const PREFERRED: S.GearKind[] = ['shield', 'spread', 'seed', 'long'];

export class OnlineSession implements Session {
  readonly mode = 'online' as const;
  readonly route: RouteInfo;
  readonly params: S.FlightParamsV3;
  readonly pauseBudgetMs: number;
  private readonly b: Backend;
  private readonly token: string;
  private readonly flightId: string;
  private readonly flightKey: string;
  private readonly gatewayUrl: string;
  private readonly gear: GearActivationClient;
  private ws: WebSocket | null = null;
  private linkState: Link = 'connecting';
  private lastPong = 0;
  private seq = 0;
  private acked = -1;
  private outbox: { seq: number; json: string }[] = [];
  private chunk: { from: number; inputs: [number, number][]; gear: [number, number, number][]; receipts: [number, number][] } = { from: 0, inputs: [], gear: [], receipts: [] };
  /** Reward spawns received in time, waiting for their materialise frame. */
  private spawnQueue: { mf: number; e: [number, number, number, number] }[] = [];
  private seenSpawns = new Set<number>();
  private missedSpawns = 0;
  private lastMask = -1;
  private frame = 0;
  private applyNext = 0;
  private applySeqs: { slot: number; seq: number }[] = [];
  private bannerText = '';
  private bannerUntil = 0;
  private endedReason: string | null = null;
  private dead = false;
  private overOk: (() => void) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];

  private constructor(b: Backend, token: string, rt: RouteInfo, s: StartResponse, loadout: { gearType: string; copies: number }[]) {
    this.b = b; this.token = token; this.route = rt;
    this.flightId = s.flightId; this.flightKey = s.flightKey; this.gatewayUrl = s.gatewayUrl;
    this.params = s.params;
    this.pauseBudgetMs = s.pinned.clock.pauseBudgetMs;
    this.gear = new GearActivationClient(s.flightId, [0, 1, 2].map((i) => loadout[i] ?? null));
  }

  /** Starts an online flight. `loadout` is the Genesis pre-flight choice (null: the best available, up to 3 x 2). */
  static async start(b: Backend, rt: RouteInfo, chosen: { gearType: string; copies: number }[] | null = null): Promise<OnlineSession> {
    const token = await guestToken(b);
    let loadout: { gearType: string; copies: number }[] = [];
    if (rt.kind === 'genesis') {
      if (chosen) loadout = chosen;
      else {
        const inv = await inventory(b);
        loadout = PREFERRED.map((k) => inv.find((g) => g.gearType === k)).filter((g): g is { gearType: string; available: number } => !!g && g.available > 0).slice(0, 3).map((g) => ({ gearType: g.gearType, copies: Math.min(2, g.available) }));
      }
    }
    const r = await api<StartResponse>(b, '/v1/flights', { method: 'POST', token, body: JSON.stringify({ routeId: rt.id, loadout, simBuild: SIM_BUILD }) });
    if (r.status === 409 && r.body.error === 'active_flight_exists' && r.body.flightId) throw new ActiveFlightError(r.body.flightId, r.body.routeId ?? null, r.body.startedAt ?? null);
    if (r.status !== 201) throw new Error(r.body.message ?? r.body.error ?? `start failed (${r.status})`);
    // the flight flies the route the server pinned (today's scheduled Daily may differ from a bundled one)
    const pinned: RouteInfo = r.body.route ? { ...rt, id: r.body.route.id, route: r.body.route, label: r.body.label ?? rt.label } : rt;
    const s = new OnlineSession(b, token, pinned, r.body, loadout);
    await s.connect(true);
    s.timers.push(setInterval(() => s.heartbeat(), 1000));
    return s;
  }

  // ------------------------------------------------------------------ socket
  private connect(first: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(`${this.gatewayUrl}/v1/flights/${this.flightId}/socket`); } catch (e) { reject(e as Error); return; }
      this.linkState = 'connecting';
      const timeout = setTimeout(() => { ws.close(); reject(new Error('the flight gateway did not answer')); }, 6000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', flightId: this.flightId, flightKey: this.flightKey, frame: this.frame, lastAckSeq: this.acked, simBuild: SIM_BUILD, ...(this.dead ? { dead: true } : {}) }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        if (m.type === 'welcome') {
          clearTimeout(timeout);
          this.ws = ws; this.linkState = 'online'; this.lastPong = performance.now();
          for (const c of this.outbox) ws.send(c.json);
          for (const req of this.gear.pendingRequests(this.frame)) ws.send(JSON.stringify(req));
          if (!first) this.flash('Back online. Buffered flight data uploaded.', 2500);
          resolve();
          return;
        }
        if (m.type === 'error' && this.linkState === 'connecting') { clearTimeout(timeout); reject(new Error(m.message)); return; }
        this.onMessage(m);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.ws === ws) { this.ws = null; if (!this.endedReason) { this.linkState = 'offline'; } }
        if (this.linkState === 'connecting') reject(new Error('could not connect'));
      };
    });
  }

  private heartbeat(): void {
    if (this.endedReason) return;
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
      if (performance.now() - this.lastPong > 3000) { this.linkState = 'offline'; this.ws.close(); this.ws = null; }
    } else if (this.linkState !== 'connecting') {
      this.connect(false).catch(() => { this.linkState = 'offline'; });
    }
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'pong': this.lastPong = performance.now(); return;
      case 'ack': this.acked = Math.max(this.acked, m.seq); this.outbox = this.outbox.filter((c) => c.seq > m.seq); return;
      case 'resend': for (const c of this.outbox) if (c.seq >= m.fromSeq) this.ws?.send(c.json); return;
      case 'gear_outcome': return this.onOutcome(m);
      case 'gear_gone': return;
      case 'ended': this.endedReason = endText(m.reason, m.detail); this.linkState = 'ended'; this.stop(); return;
      case 'over_ok': this.overOk?.(); return;
      case 'spawn': {
        if (m.kind === 'capsule') this.flash('Live Drop ahead: Squeektoshi is running', 1800);
        if (this.seenSpawns.has(m.spawnId)) return;
        this.seenSpawns.add(m.spawnId);
        // the receipt carries this frame; the gateway materialises the spawn only if it is in time
        this.chunk.receipts.push([this.frame, m.spawnId]);
        if (this.frame <= m.materializeFrame) this.spawnQueue.push({ mf: m.materializeFrame, e: [m.spawnId, m.kindCode, m.x, m.row] });
        else { this.missedSpawns++; this.flash(m.kind === 'capsule' ? 'A Live Drop was missed: the connection was too slow' : 'A Mystery Box was missed: the connection was too slow', 2500); }
        return;
      }
      default: return;
    }
  }

  private onOutcome(o: GearUseOutcome): void {
    const ev = this.gear.receive(o, this.frame);
    if (ev.kind === 'apply') { this.applyNext |= 1 << ev.slot; this.applySeqs.push({ slot: ev.slot, seq: ev.seq }); }
    else if (ev.kind === 'late') { if (this.healthy()) this.ws?.send(JSON.stringify(ev.renew)); }
    else if (ev.kind === 'missed') this.flash('Gear used, connection lost: the effect did not run', 3000);
    else if (ev.kind === 'released') this.flash('Gear not used: ' + (o.outcome === 'rejected' ? o.reason.replace(/_/g, ' ') : ''), 2000);
  }

  private healthy(): boolean { return this.linkState === 'online' && !!this.ws && performance.now() - this.lastPong < 3000; }
  private flash(t: string, ms: number): void { this.bannerText = t; this.bannerUntil = performance.now() + ms; }
  private stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  // ------------------------------------------------------------------ Session
  link(): Link { return this.linkState; }
  slots(): SlotView[] {
    const st = this.gear.exportState();
    return [0, 1, 2].map((i) => {
      const sl = st.slots[i];
      const kind = sl && sl.gearType ? (sl.gearType as S.GearKind) : null;
      if (!kind) return { kind: null, count: 0, state: 'none', note: '' };
      const count = this.gear.shownCount(i as 0 | 1 | 2);
      const state = this.gear.isWaiting(i as 0 | 1 | 2) ? 'arming' : count <= 0 ? 'empty' : !this.healthy() ? 'offline' : 'ready';
      return { kind, count, state, note: state === 'offline' ? 'needs a connection' : '' };
    });
  }
  press(slot: number, frame: number): void {
    const req = this.gear.press(slot as 0 | 1 | 2, frame, this.healthy() ? 'healthy' : 'offline');
    if (req) this.ws?.send(JSON.stringify(req));
  }
  applies(frame: number): number {
    const a = this.applyNext;
    for (const x of this.applySeqs) this.chunk.gear.push([frame, x.slot, x.seq]);
    this.applyNext = 0; this.applySeqs = [];
    return a;
  }
  spawnsAt(frame: number): [number, number, number, number][] {
    if (!this.spawnQueue.length) return [];
    const due = this.spawnQueue.filter((x) => x.mf === frame).map((x) => x.e);
    if (due.length) this.spawnQueue = this.spawnQueue.filter((x) => x.mf !== frame);
    return due;
  }
  stepped(frameBefore: number, mask: number, s: S.StateV3): void {
    if (mask !== this.lastMask) { this.chunk.inputs.push([frameBefore, mask]); this.lastMask = mask; }
    this.frame = s.frame;
    if (s.dead) this.dead = true;
    if (s.frame % 6 === 0 || s.dead) this.flush(s.hash);
  }
  private flush(hash: number): void {
    if (this.frame === this.chunk.from && !this.chunk.inputs.length && !this.chunk.receipts.length) return;
    const c = { type: 'chunk', seq: this.seq++, fromFrame: this.chunk.from, toFrame: this.frame, inputs: this.chunk.inputs, gear: this.chunk.gear, ...(this.chunk.receipts.length ? { receipts: this.chunk.receipts } : {}), hash };
    const json = JSON.stringify(c);
    this.outbox.push({ seq: c.seq, json });
    this.chunk = { from: this.frame, inputs: [], gear: [], receipts: [] };
    if (this.ws && this.ws.readyState === 1) this.ws.send(json);
  }
  canPause(): boolean { return this.healthy(); }
  pauseStart(): void { this.ws?.send(JSON.stringify({ type: 'pause_start', frame: this.frame })); }
  pauseEnd(): void { this.ws?.send(JSON.stringify({ type: 'pause_end', frame: this.frame })); }

  async gameOver(end: FlightEnd, s: S.StateV3): Promise<{ verdict: string; detail: string }> {
    // everything up to the death frame must reach the gateway before Game Over is declared
    const t0 = performance.now();
    while (this.outbox.length && !this.endedReason && performance.now() - t0 < 60_000) await sleep(200);
    if (this.endedReason) return { verdict: 'Ended', detail: this.endedReason };
    if (this.outbox.length) return { verdict: 'Waiting', detail: 'Still offline: the flight uploads and verifies when the connection returns.' };
    const done = new Promise<void>((r) => { this.overOk = r; });
    this.ws?.send(JSON.stringify({ type: 'game_over', frame: end.frame, cause: end.cause, distanceRows: end.distanceRows, hash: s.hash }));
    await Promise.race([done, sleep(8000)]);
    this.stop();
    for (let i = 0; i < 60; i++) {
      const r = await api<FlightStatus>(this.b, `/v1/flights/${this.flightId}`, { token: this.token });
      const f = r.body;
      if (f.report && ['verified', 'held', 'rejected'].includes(f.phase)) {
        const rep = f.report;
        const verdict = f.phase === 'verified' ? 'Verified' : f.phase === 'held' ? 'Held for review' : 'Rejected';
        const parts = [
          `Server replay: ${rep.inputsReproduceResult ? 'same result' : 'different result'}; Gear ${rep.gearEdgesPaid ? 'all paid' : 'unpaid use found'}.`,
          ...(f.reward ? [rewardText(f.reward, f.phase)] : []),
          rep.unwitnessedFrames ? `Offline play: ${(rep.unwitnessedFrames / 60).toFixed(1)} s (${(rep.unwitnessedShare * 100).toFixed(1)}%), not timed by the server.` : 'Every frame was witnessed online.',
          ...rep.reasons,
        ];
        return { verdict, detail: parts.join(' ') };
      }
      if (f.phase === 'terminated') return { verdict: 'Ended', detail: endText(f.endReason ?? 'terminated', '') };
      await sleep(1000);
    }
    return { verdict: 'Verifying', detail: 'The worker has not finished verifying this flight yet.' };
  }

  abandon(_reason: string): void {
    if (this.endedReason || this.dead) return;
    try {
      const blob = new Blob([JSON.stringify({ flightKey: this.flightKey })], { type: 'text/plain' });
      navigator.sendBeacon(`${this.b.api}/v1/flights/${this.flightId}/terminate`, blob);
    } catch { /* the next start ends it anyway */ }
    this.endedReason = 'You left the flight.';
    this.stop();
    this.ws?.close();
  }

  status(): string { return this.linkState === 'online' ? (this.healthy() ? 'Online' : 'Online · slow') : this.linkState === 'connecting' ? 'Connecting' : this.linkState === 'ended' ? 'Ended' : 'Reconnecting'; }
  banner(): string {
    if (this.endedReason) return '';
    if (performance.now() < this.bannerUntil) return this.bannerText;
    if (this.linkState === 'offline' || this.linkState === 'connecting') return 'Offline: play continues. Gear and Pause need a connection.';
    return '';
  }
  terminated(): string | null { return this.endedReason; }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function rewardText(r: NonNullable<FlightStatus['reward']>, phase: string): string {
  const offline = r.spawns.filter((s) => s.delivery === 'missed_offline').length;
  const parts: string[] = [];
  if (r.spawns.some((s) => s.kind !== 'capsule') || r.boxesGranted) parts.push(r.boxesGranted === 1 ? '1 Mystery Box granted' : `${r.boxesGranted} Mystery Boxes granted`);
  if (r.dropsGranted) parts.push(`${r.dropsGranted} Live Drop${r.dropsGranted === 1 ? '' : 's'} added to your collection`);
  if (r.dropsClaimable) parts.push(`${r.dropsClaimable} Live Drop${r.dropsClaimable === 1 ? '' : 's'} held for 7 days: link a wallet to keep ${r.dropsClaimable === 1 ? 'it' : 'them'}`);
  if (phase !== 'verified') return 'No rewards granted (not verified).';
  return (parts.length ? parts.join('; ') : 'No rewards on this flight') + (offline ? `; ${offline} missed while offline` : '') + '.';
}
function endText(reason: string, detail: string): string {
  const map: Record<string, string> = {
    pagehide: 'The flight ended because the page was closed or reloaded.',
    superseded: 'The flight ended because a new flight started.',
    clock_breach: 'The flight ended: game time did not match real time.',
    pause_budget: 'The flight ended because it stayed paused or in the background longer than the 20 s pause budget.',
    suspended: 'The flight ended because the page was suspended.',
    desync: 'The flight ended: the server replay disagreed with this game.',
    protocol_violation: 'The flight ended: unexpected data from the game.',
    gear_violation: 'The flight ended: a Gear effect ran without a paid activation.',
  };
  return (map[reason] ?? 'The flight was ended.') + (detail && !map[reason] ? ' ' + detail : '');
}
