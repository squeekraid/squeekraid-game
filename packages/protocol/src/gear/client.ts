import type { GearSlot, GearUseOutcome, GearUseRequest } from './messages.ts';

/** Connection health as the flight socket reports it. Healthy = a heartbeat was acked within 3 s. */
export type ConnectionHealth = 'healthy' | 'degraded' | 'offline';

export interface LoadedSlot {
  readonly gearType: string;
  readonly copies: number;
}

export interface GearClientState {
  readonly flightId: string;
  readonly slots: readonly { readonly gearType: string; readonly left: number }[];
  readonly pending: readonly { readonly seq: number; readonly slot: GearSlot; readonly gearType: string; readonly requestFrame: number; readonly committed: boolean; readonly seenWindow: number }[];
  readonly handled: readonly number[];
  readonly nextSeq: number;
}

interface Pending {
  readonly slot: GearSlot;
  readonly gearType: string;
  readonly requestFrame: number;
  /** A committed outcome arrived but its window had passed; a renewal was requested (A1r). */
  committed: boolean;
  /** Highest window number seen for this seq; older windows arriving late are ignored. */
  seenWindow: number;
}

export type ClientEvent =
  /** Apply the effect on this frame: set the slot's input bit, recorded with the activation seq. */
  | { readonly kind: 'apply'; readonly seq: number; readonly slot: GearSlot; readonly frame: number }
  /**
   * A1r: committed, but this window passed before it arrived. Send `renew` (a resend of the same seq
   * with the current frame) to ask for a fresh window; the effect stays pending.
   */
  | { readonly kind: 'late'; readonly seq: number; readonly slot: GearSlot; readonly renew: GearUseRequest }
  /** Committed, every window passed (or the flight left the active phase). The copy is spent; no effect runs. */
  | { readonly kind: 'missed'; readonly seq: number; readonly slot: GearSlot }
  /** Rejected: nothing was consumed. The slot is usable again. */
  | { readonly kind: 'released'; readonly seq: number; readonly slot: GearSlot }
  /** Duplicate or unknown outcome (for example, a retry answered twice). Nothing happens. */
  | { readonly kind: 'ignored'; readonly seq: number };

/**
 * Client side of Gear activation (amendment A1). The invariant it maintains: an effect is applied
 * only after a committed outcome for that seq has arrived, and at most once per seq. While the
 * connection is not healthy no new activation can start; effects already applied keep running in
 * the sim, which is deterministic and does not depend on the network.
 *
 * The controller lives in page memory only. Closing or reloading the page discards it, together with
 * any pending request; the server's decision for that request stands either way.
 */
export class GearActivationClient {
  readonly flightId: string;
  private readonly slots: { gearType: string; left: number }[];
  private readonly pending = new Map<number, Pending>();
  private readonly handled = new Set<number>();
  private nextSeq = 0;

  constructor(flightId: string, loadout: readonly (LoadedSlot | null)[]) {
    this.flightId = flightId;
    this.slots = loadout.map((s) => ({ gearType: s?.gearType ?? '', left: s?.copies ?? 0 }));
  }

  /** Copies the server has not yet committed, minus requests waiting for an answer. Drives the HUD count. */
  shownCount(slot: GearSlot): number {
    const s = this.slots[slot];
    if (!s) return 0;
    let waiting = 0;
    for (const p of this.pending.values()) if (p.slot === slot && !p.committed) waiting++;
    return s.left - waiting;
  }

  isWaiting(slot: GearSlot): boolean {
    for (const p of this.pending.values()) if (p.slot === slot) return true;
    return false;
  }

  canActivate(slot: GearSlot, health: ConnectionHealth): boolean {
    const s = this.slots[slot];
    return health === 'healthy' && !!s && s.gearType !== '' && !this.isWaiting(slot) && this.shownCount(slot) > 0 && this.nextSeq <= 999;
  }

  /** Called on the rising edge of a Gear key. Returns the request to send, or null if activation is not allowed now. */
  press(slot: GearSlot, frame: number, health: ConnectionHealth): GearUseRequest | null {
    if (!this.canActivate(slot, health)) return null;
    const s = this.slots[slot];
    if (!s) return null;
    const seq = this.nextSeq++;
    this.pending.set(seq, { slot, gearType: s.gearType, requestFrame: frame, committed: false, seenWindow: 0 });
    return { type: 'gear_use', flightId: this.flightId, seq, slot, gearType: s.gearType, requestFrame: frame };
  }

  /** Handles an outcome from the gateway at the client's current frame. */
  receive(outcome: GearUseOutcome, frameNow: number): ClientEvent {
    const p = this.pending.get(outcome.seq);
    if (!p || this.handled.has(outcome.seq)) return { kind: 'ignored', seq: outcome.seq };
    if (outcome.outcome === 'rejected') {
      if (p.committed) return { kind: 'ignored', seq: outcome.seq }; // cannot happen: decisions never change
      this.pending.delete(outcome.seq);
      this.handled.add(outcome.seq);
      return { kind: 'released', seq: outcome.seq, slot: p.slot };
    }
    if (outcome.window < p.seenWindow) return { kind: 'ignored', seq: outcome.seq };
    if (!p.committed) { p.committed = true; const s = this.slots[p.slot]; if (s) s.left -= 1; }
    if (frameNow <= outcome.applyDeadlineFrame) {
      this.pending.delete(outcome.seq);
      this.handled.add(outcome.seq);
      return { kind: 'apply', seq: outcome.seq, slot: p.slot, frame: frameNow };
    }
    if (outcome.final) {
      this.pending.delete(outcome.seq);
      this.handled.add(outcome.seq);
      return { kind: 'missed', seq: outcome.seq, slot: p.slot };
    }
    p.seenWindow = outcome.window;
    return { kind: 'late', seq: outcome.seq, slot: p.slot, renew: this.requestFor(outcome.seq, p, frameNow) };
  }

  /** Plain-data copy of the controller, for the protocol model checker and crash diagnostics. */
  exportState(): GearClientState {
    return {
      flightId: this.flightId,
      slots: this.slots.map((s) => ({ ...s })),
      pending: [...this.pending.entries()].map(([seq, p]) => ({ seq, slot: p.slot, gearType: p.gearType, requestFrame: p.requestFrame, committed: p.committed, seenWindow: p.seenWindow })),
      handled: [...this.handled].sort((a, b) => a - b),
      nextSeq: this.nextSeq,
    };
  }

  static fromState(st: GearClientState): GearActivationClient {
    const c = new GearActivationClient(st.flightId, []);
    c.slots.push(...st.slots.map((s) => ({ ...s })));
    for (const p of st.pending) c.pending.set(p.seq, { slot: p.slot, gearType: p.gearType, requestFrame: p.requestFrame, committed: p.committed, seenWindow: p.seenWindow });
    for (const h of st.handled) c.handled.add(h);
    c.nextSeq = st.nextSeq;
    return c;
  }

  /**
   * Requests still waiting for an outcome or a usable window; resent after a reconnect with the same
   * seq (idempotent) and the current frame, so a committed one can get a fresh window (A1r).
   */
  pendingRequests(frameNow?: number): GearUseRequest[] {
    return [...this.pending.entries()].map(([seq, p]) => this.requestFor(seq, p, frameNow));
  }

  private requestFor(seq: number, p: Pending, frameNow: number | undefined): GearUseRequest {
    const r: GearUseRequest = { type: 'gear_use', flightId: this.flightId, seq, slot: p.slot, gearType: p.gearType, requestFrame: p.requestFrame };
    return frameNow === undefined ? r : { ...r, clientFrame: frameNow };
  }
}
