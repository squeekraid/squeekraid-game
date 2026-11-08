// A flight session connects the game loop to wherever authority lives. Practice sessions are local:
// Gear applies at once from a practice kit and nothing is recorded anywhere. Online sessions (net.ts)
// talk to the flight gateway: Gear waits for a committed outcome, inputs stream in chunks, Pause is
// budgeted by the server, and the result is verified by the worker.
import * as S from '@sqk/sim/v3';
import type { RouteInfo } from '@sqk/routes';

export type SlotState = 'ready' | 'arming' | 'empty' | 'offline' | 'none';
export interface SlotView { readonly kind: S.GearKind | null; readonly count: number; readonly state: SlotState; readonly note: string }
export type Link = 'local' | 'connecting' | 'online' | 'offline' | 'ended';

export interface FlightEnd {
  readonly frame: number;
  readonly cause: string;
  readonly distanceRows: number;
}

export interface Session {
  readonly mode: 'practice' | 'online';
  readonly route: RouteInfo;
  readonly params: S.FlightParamsV3;
  readonly pauseBudgetMs: number;
  link(): Link;
  slots(): SlotView[];
  /** The player pressed a Gear key at sim frame `frame`. */
  press(slot: number, frame: number): void;
  /** Bitmask of Gear slots to apply on the step that starts at `frame`. */
  applies(frame: number): number;
  /** Reward spawns to inject before the step that starts at `frame`: [spawnId, kindCode, xPx, row]. */
  spawnsAt(frame: number): [number, number, number, number][];
  /** Called after each step with the mask that was used and the frame count after the step. */
  stepped(frameBefore: number, mask: number, s: S.StateV3): void;
  canPause(): boolean;
  pauseStart(): void;
  pauseEnd(): void;
  /** Game Over reached locally. Resolves with the verification text to show. */
  gameOver(end: FlightEnd, s: S.StateV3): Promise<{ verdict: string; detail: string }>;
  /** The player is leaving (page hidden for good, quit to menu). */
  abandon(reason: string): void;
  /** Short status for the HUD connection chip. */
  status(): string;
  /** Message the HUD should show, if any (offline, Gear missed, flight ended by server). */
  banner(): string;
  /** True once the server ended this flight (termination); the game shows the ended state. */
  terminated(): string | null;
}

export const PRACTICE_KIT: readonly { kind: S.GearKind; count: number }[] = [
  { kind: 'shield', count: 2 },
  { kind: 'spread', count: 2 },
  { kind: 'seed', count: 1 },
];

/** Local practice flight. Gear applies on the frame it is pressed; Pause uses the same 20 s budget. */
export class PracticeSession implements Session {
  readonly mode = 'practice' as const;
  readonly params: S.FlightParamsV3;
  readonly pauseBudgetMs = 20_000;
  private readonly counts: number[];
  private pending = 0;
  readonly route: RouteInfo;
  constructor(route: RouteInfo, kit: readonly { kind: S.GearKind; count: number }[] = PRACTICE_KIT) {
    this.route = route;
    const loadout = [0, 1, 2].map((i) => kit[i]?.kind ?? null);
    this.counts = [0, 1, 2].map((i) => kit[i]?.count ?? 0);
    this.params = { ...S.DEFAULT_PARAMS, loadout };
  }
  link(): Link { return 'local'; }
  slots(): SlotView[] {
    return [0, 1, 2].map((i) => {
      const kind = this.params.loadout[i] ?? null;
      const count = this.counts[i] ?? 0;
      return { kind, count, state: kind === null ? 'none' : count > 0 ? 'ready' : 'empty', note: '' };
    });
  }
  press(slot: number): void {
    if ((this.counts[slot] ?? 0) <= 0 || (this.pending & (1 << slot))) return;
    this.counts[slot]!--;
    this.pending |= 1 << slot;
  }
  applies(): number { const p = this.pending; this.pending = 0; return p; }
  spawnsAt(): [number, number, number, number][] { return []; }
  stepped(): void { /* nothing leaves the browser in practice */ }
  canPause(): boolean { return true; }
  pauseStart(): void {}
  pauseEnd(): void {}
  async gameOver(end: FlightEnd): Promise<{ verdict: string; detail: string }> {
    return { verdict: 'Practice', detail: `Practice flights are not sent anywhere. Down at frame ${end.frame}.` };
  }
  abandon(): void {}
  status(): string { return 'Practice'; }
  banner(): string { return ''; }
  terminated(): string | null { return null; }
}
