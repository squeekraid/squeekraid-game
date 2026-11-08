// TEST FIXTURES, NOT TELEMETRY. Hand-built API responses in the documented shapes, to drive the
// detector and the pipeline through every state. They are never served to players or stored as data.
import type { FetchResult, RunsV1, SqueekchainClient, StatsV1, StatusV1 } from '../src/index.ts';

export function status(over: { provenance?: string; freshness?: string; coreStatus?: string; speed?: number; signer?: boolean; measurement?: boolean; observedAt?: Date } = {}): StatusV1 {
  return {
    schemaVersion: 1, installationId: 'fixture-installation', generatedAt: '2026-11-01T12:00:00Z',
    measurement: over.measurement === false ? null : {
      freshness: (over.freshness ?? 'online') as 'online', observedAt: (over.observedAt ?? new Date('2026-11-01T12:00:05Z')).toISOString(), provenance: (over.provenance ?? 'hardware') as 'hardware',
      coreStatus: (over.coreStatus ?? 'ACTIVE') as 'ACTIVE', rpmMilli: 0, speedMmPerSecond: over.speed ?? 250, distanceMm: 0, cumulativeWorkUnits: '0',
    },
    signer: over.signer === false ? null : { kind: 'trust-m', algorithm: 'ecdsa-p256' },
  } as StatusV1;
}
export function runs(profile = 'production'): RunsV1 {
  return { schemaVersion: 'measurement-runs.v1', installationId: 'fixture-installation', generatedAt: '2026-11-01T12:00:00Z', freshness: 'fresh', items: [{ segmentId: 's1', startAt: '2026-11-01T11:59:00Z', endAt: '2026-11-01T12:00:00Z', provenance: 'hardware', profile }] } as RunsV1;
}
/** A stats response whose day `date` has `observed` of its 48 buckets complete (work 600 each). */
export function stats(date: string, observed: number): StatsV1 {
  const buckets = Array.from({ length: 48 }, (_, i) => ({ startMinuteUtc: ((24 + i) % 48) * 30, coverage: i < observed ? 'complete' : 'missing', observedRoundCount: 3, workUnits: i < observed ? '600' : null }));
  return { schemaVersion: 1, installationId: 'fixture-installation', generatedAt: '2026-11-01T12:01:00Z', range: '7d', timezone: 'UTC', window: { startAt: '2026-10-25T12:00:00Z', endAt: '2026-11-01T12:00:00Z', dayCount: 7, bucketSeconds: 1800 }, activity: { provenance: 'accepted_rounds', days: [{ date, buckets }] } } as unknown as StatsV1;
}
const ok = <T>(endpoint: 'status' | 'runs' | 'stats', parsed: T | null, error: string | null = null, at = new Date()): FetchResult<T> => ({ endpoint, fetchedAt: at, httpStatus: error ? null : 200, etag: null, notModified: false, raw: parsed ? JSON.stringify(parsed) : null, parsed, error, retryAfterMs: null });

/** A scripted client: each call returns the next value it is given (or an unreachable error). */
export function scripted(s: { status?: () => StatusV1 | null; runs?: (cursor: string | null) => RunsV1 | null; stats?: () => StatsV1 | null; now?: () => Date }): SqueekchainClient {
  const now = s.now ?? (() => new Date());
  return {
    async status() { const v = s.status?.() ?? null; return ok('status', v, v ? null : 'unreachable: fixture', now()); },
    async runs(_limit, cursor = null) { const v = s.runs?.(cursor) ?? null; return ok('runs', v, v ? null : 'unreachable: fixture', now()); },
    async stats() { const v = s.stats?.() ?? null; return ok('stats', v, v ? null : 'unreachable: fixture', now()); },
  };
}

/** The live /v1/status body from api.squeekchain.com, 2026-11-07 04:30 UTC, sanitized (signature replaced). */
export const LIVE_STATUS_2026_11_07 = {
  schemaVersion: 1,
  installationId: 'sepolia-core-sepolia-20261103',
  generatedAt: '2026-11-07T04:30:31.205Z',
  measurement: {
    freshness: 'online',
    observedAt: '2026-11-07T04:30:00.958Z',
    receivedAt: '2026-11-07T04:30:01.358Z',
    staleAfterSeconds: 120,
    counterEpoch: 'c53e3951-4e69-4ad3-b59c-d122a064d15a',
    cumulativeWorkUnits: '13064',
    provenance: 'hardware',
    coreStatus: 'IDLE',
    rpmMilli: 0,
    speedMmPerSecond: 0,
    distanceMm: 1770048,
  },
  signer: {
    kind: 'ed25519',
    algorithm: 'ed25519',
    keySlot: null,
    enrolledAt: '2026-11-04T21:32:51.138Z',
    lastVerifiedAt: '2026-11-07T04:30:01.358Z',
    lastSignature: 'SANITIZED',
  },
};
