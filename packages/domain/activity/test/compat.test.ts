// Compatibility with the Squeekchain developer API as documented on 2026-11-06
// (docs.squeekchain.com/developers/api). These bodies are hand-written from the documented field
// lists, not recorded observations: they show the adapter accepts the current documented shape
// (new fields included) and its error contract. Real recorded captures are still outstanding.
import { describe, expect, it } from 'vitest';
import { classify, RunsV1, squeekchainClient, StatsV1, StatusV1 } from '../src/index.ts';

const at = '2026-11-06T09:00:00.000Z';
const documentedStatus = {
  schemaVersion: 1, installationId: 'inst-1', revision: 'r1', generatedAt: at,
  measurement: { freshness: 'online', observedAt: at, receivedAt: at, staleAfterSeconds: 10, counterEpoch: 3, cumulativeWorkUnits: '123456789012345678901', provenance: 'hardware', coreStatus: 'ACTIVE', rpmMilli: 54000, speedMmPerSecond: 250, distanceMm: 1200 },
  builder: { status: 'ok', reason: null, anchor: {}, queued: 0, projected: {} },
  oracle: { state: 'ready', reason: null, latestAcceptedAt: at, latestClosure: null },
  settlementQueue: { status: 'ok', reason: null, state: 'idle', settlementEnabled: true, reporterEnvironmentEnabled: true, buffered: 0, projected: 0, incidentOpen: false, blockedReason: null, lastRun: null, latestSubmission: null },
  signer: { kind: 'pi-device-key', algorithm: 'ed25519', keySlot: 'a', enrolledAt: at, lastVerifiedAt: at, lastSignature: 'x' },
  modules: [{ instanceId: 'm1', moduleType: 'wheel', driverId: 'd', moduleVersion: '1', schemaVersion: 1, state: 'ok', observedAt: at, provenance: 'hardware', health: 'ok', data: {} }],
};
const documentedRuns = {
  schemaVersion: 'measurement-runs.v1', installationId: 'inst-1', generatedAt: at, authority: 'pi-device-key', certifiedCoreWork: false, freshness: 'fresh',
  latestObservedAt: at, coverageStartAt: at, coverageThroughAt: at, nextCursor: null,
  items: [{ segmentId: 's1', continuityId: 'c1', discontinuity: false, startAt: at, endAt: at, workUnits: '42', maxGapMs: 120, previousAt: null, boundaryGapNs: '0', passages: [{ at, offsetNs: '0' }], provenance: 'hardware', profile: 'production', observedAt: at, receivedAt: at, measurementEligible: true }],
};
const documentedStats = {
  schemaVersion: 1, installationId: 'inst-1', revision: 'r1', generatedAt: at, range: '7d', timezone: 'UTC',
  window: { startAt: at, endAt: at, dayCount: 7, bucketSeconds: 1800, roundSeconds: 1800 },
  lifetime: { acceptedWorkUnits: '1', observedDistanceMm: '1', activeDayCount: 1, settledBlockCount: 0, settlementCount: 0, settledWorkUnits: '0', coverageBps: 9000, firstObservedAt: at },
  activity: { provenance: 'hardware', coverage: 'partial', summary: {}, typicalDay: [], days: [{ date: '2026-11-05', coverage: 'partial', observedWorkUnits: '10', distanceMm: '5', buckets: [{ startMinuteUtc: 720, coverage: 'complete', observedRoundCount: 1, workUnits: '10' }] }] },
  records: {}, blocks: {}, rounds: { activeRateBps: 100 }, oracle: {},
};

describe('Squeekchain API compatibility (documented shape, 2026-11-06)', () => {
  it('accepts the documented status, runs and stats bodies, extra fields included', () => {
    expect(StatusV1.safeParse(documentedStatus).success).toBe(true);
    expect(RunsV1.safeParse(documentedRuns).success).toBe(true);
    expect(StatsV1.safeParse(documentedStats).success).toBe(true);
    const s = StatusV1.parse(documentedStatus);
    const sample = { fetchedAt: new Date(at), status: s, error: null };
    expect(classify(sample, sample, 'production', new Date(Date.parse(at) + 1000)).state).toBe('LIVE');
  });
  it('a schemaVersion the adapter does not know is refused, not guessed', () => {
    expect(StatusV1.safeParse({ ...documentedStatus, schemaVersion: 2 }).success).toBe(false);
    expect(RunsV1.safeParse({ ...documentedRuns, schemaVersion: 'measurement-runs.v2' }).success).toBe(false);
  });
  it('documented errors: stats rebuilding (503 + Retry-After) and rate limits are reported with the wait', async () => {
    const fake: typeof fetch = async (u) => String(u).includes('stats')
      ? new Response(JSON.stringify({ error: 'public_stats_rebuilding' }), { status: 503, headers: { 'retry-after': '20' } })
      : new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'retry-after': '1' } });
    const c = squeekchainClient('https://api.example', fake);
    expect(await c.stats('7d')).toMatchObject({ httpStatus: 503, retryAfterMs: 20_000, parsed: null });
    expect(await c.runs()).toMatchObject({ httpStatus: 429, retryAfterMs: 1000 });
  });
  it('sends a request id the API accepts (8–128 characters)', async () => {
    let id = '';
    await squeekchainClient('https://api.example', async (_u, init) => { id = (init?.headers as Record<string, string>)['x-request-id']!; return new Response(JSON.stringify(documentedStatus)); }).status();
    expect(id.length).toBeGreaterThanOrEqual(8); expect(id.length).toBeLessThanOrEqual(128);
  });
});
