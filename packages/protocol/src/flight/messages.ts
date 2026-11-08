// Flight socket protocol (client <-> gateway), rules v3. JSON text frames.
import { z } from 'zod';
import { GearUseRequest, type GearUseOutcome } from '../gear/messages.ts';

const frame = z.number().int().min(0);
const InputChange = z.tuple([frame, z.number().int().min(0).max(7)]);
const GearEdge = z.tuple([frame, z.union([z.literal(0), z.literal(1), z.literal(2)]), z.number().int().min(0).max(999)]);
/** spawn_receipt: [the client's frame when the reveal arrived, spawnId]. */
const SpawnReceipt = z.tuple([frame, z.number().int().min(1)]);

/** First message on every connection. The flight key lives only in the tab's memory. */
export const Hello = z.strictObject({
  type: z.literal('hello'),
  flightId: z.uuid(),
  flightKey: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
  /** The client's sim frame now (frames already stepped). */
  frame,
  /** Highest chunk seq the client knows was acked. */
  lastAckSeq: z.number().int().min(-1),
  /** Content hash of the client's sim build; must equal the flight's pinned build. */
  simBuild: z.string().regex(/^[0-9a-f]{64}$/),
  /** The plane died while offline: the offline interval may be shorter than the outage. */
  dead: z.boolean().optional(),
});

/** Inputs for frames [fromFrame, toFrame). Sent every 100 ms online; buffered while offline. */
export const Chunk = z.strictObject({
  type: z.literal('chunk'),
  seq: z.number().int().min(0),
  fromFrame: frame,
  toFrame: frame,
  inputs: z.array(InputChange).max(4000),
  gear: z.array(GearEdge).max(30),
  receipts: z.array(SpawnReceipt).max(30).optional(),
  /** The client's per-frame FNV state hash after toFrame steps (live desync detection). */
  hash: z.number().int().min(0).max(0xffffffff),
});

export const PauseStart = z.strictObject({ type: z.literal('pause_start'), frame });
export const PauseEnd = z.strictObject({ type: z.literal('pause_end'), frame });
export const GameOver = z.strictObject({ type: z.literal('game_over'), frame, cause: z.string().max(16), distanceRows: z.number().int().min(0), hash: z.number().int().min(0).max(0xffffffff) });
export const Ping = z.strictObject({ type: z.literal('ping'), t: z.number() });

export const ClientMessage = z.discriminatedUnion('type', [Hello, Chunk, GearUseRequest, PauseStart, PauseEnd, GameOver, Ping]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type Hello = z.infer<typeof Hello>;
export type Chunk = z.infer<typeof Chunk>;

export const EndReason = z.enum([
  'pagehide', 'superseded', 'admin', 'clock_breach', 'pause_budget', 'suspended', 'desync', 'protocol_violation', 'gear_violation',
]);
export type EndReason = z.infer<typeof EndReason>;

export type ServerMessage =
  | { type: 'welcome'; flightId: string; ackSeq: number; lastFrame: number; pauseLeftMs: number; resumed: boolean }
  | { type: 'ack'; seq: number }
  /** A chunk arrived out of order: resend from this seq. */
  | { type: 'resend'; fromSeq: number }
  | GearUseOutcome
  /** The flight ended before this request was decided: nothing stored, nothing consumed. */
  | { type: 'gear_gone'; seq: number }
  | { type: 'pause_ok'; leftMs: number }
  | { type: 'pause_denied'; reason: 'not_healthy' | 'budget_spent' | 'not_active' }
  | { type: 'resume_ok'; leftMs: number }
  | { type: 'over_ok'; verifyingFrom: number }
  | { type: 'ended'; reason: EndReason | string; detail: string }
  | { type: 'pong'; t: number; serverMs: number }
  /**
   * A reward spawn, sent when the shadow sim is R px short of its row. The client acknowledges with its
   * frame in the next chunk's receipts; it injects the spawn before the step at materializeFrame only
   * if that receipt frame is no later than materializeFrame (otherwise missed_late; it never pops in).
   */
  | { type: 'spawn'; spawnId: number; kind: 'box' | 'capsule'; kindCode: number; row: number; x: number; materializeFrame: number }
  | { type: 'error'; code: string; message: string };
