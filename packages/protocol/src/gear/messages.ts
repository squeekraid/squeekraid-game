import { z } from 'zod';

/** Gear slot index: 0, 1, 2 map to the Z, X, C keys and the three touch buttons. */
export const GearSlot = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type GearSlot = z.infer<typeof GearSlot>;

export const GearType = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

/**
 * Client → gateway. Sent when the player presses a Gear key while the connection is healthy.
 * Pressing does not apply anything: the effect waits for a committed outcome.
 */
export const GearUseRequest = z.object({
  type: z.literal('gear_use'),
  flightId: z.uuid(),
  /** Per-flight activation number chosen by the client. Retries reuse it; it is the idempotency key. */
  seq: z.number().int().min(0).max(999),
  slot: GearSlot,
  gearType: GearType,
  /** Client sim frame at the moment of the press. */
  requestFrame: z.number().int().min(0),
  /**
   * Set on a resend: the client's frame now. A resend of a committed seq whose window has passed asks
   * for a fresh apply window (amendment A1r). Bounded by the server's own estimate.
   */
  clientFrame: z.number().int().min(0).optional(),
});
export type GearUseRequest = z.infer<typeof GearUseRequest>;

export const GearRejectReason = z.enum([
  'flight_not_active',
  'stale_request',
  'request_from_future',
  'type_not_in_loadout',
  'none_left',
]);
export type GearRejectReason = z.infer<typeof GearRejectReason>;

/**
 * Gateway → client. Sent only after the decision is durable in Postgres. "committed" means one copy
 * is consumed for good; the client may apply the effect on a frame no later than applyDeadlineFrame.
 * A1r: a committed activation can have up to maxWindows apply windows; `window` numbers this one and
 * `final` says no further window will be opened.
 */
export const GearUseOutcome = z.discriminatedUnion('outcome', [
  z.object({
    type: z.literal('gear_outcome'),
    outcome: z.literal('committed'),
    seq: z.number().int().min(0).max(999),
    slot: GearSlot,
    applyDeadlineFrame: z.number().int().min(0),
    window: z.number().int().min(1),
    final: z.boolean(),
  }),
  z.object({
    type: z.literal('gear_outcome'),
    outcome: z.literal('rejected'),
    seq: z.number().int().min(0).max(999),
    slot: GearSlot,
    reason: GearRejectReason,
  }),
]);
export type GearUseOutcome = z.infer<typeof GearUseOutcome>;
