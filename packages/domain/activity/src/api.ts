// Typed adapter for the Squeekchain developer API (docs.squeekchain.com/developers/api). Only the
// fields the detector and the Daily pipeline use are typed; unknown fields are ignored, as the API asks.
// A schemaVersion this adapter does not support is rejected (the detector then reads NO DATA).
import { z } from 'zod';

const iso = z.string().min(10);
const big = z.union([z.string().regex(/^-?[0-9]+$/), z.number().int()]);

export const StatusV1 = z.object({
  schemaVersion: z.literal(1),
  installationId: z.string(),
  generatedAt: iso,
  measurement: z.object({
    freshness: z.enum(['online', 'stale']),
    observedAt: iso,
    receivedAt: iso.optional(),
    staleAfterSeconds: z.number().optional(),
    provenance: z.enum(['hardware', 'simulated', 'replay', 'derived']),
    coreStatus: z.enum(['IDLE', 'ACTIVE', 'COUNTER_FAULT']),
    rpmMilli: z.number().int().nullable().optional(),
    speedMmPerSecond: z.number().int().nullable().optional(),
    distanceMm: z.number().int().nullable().optional(),
    cumulativeWorkUnits: big.nullable().optional(),
  }).passthrough().nullable(),
  signer: z.object({ kind: z.string(), algorithm: z.string().optional(), keySlot: z.string().nullable().optional(), lastVerifiedAt: iso.optional() }).passthrough().nullable().optional(),
}).passthrough();
export type StatusV1 = z.infer<typeof StatusV1>;

export const RunsV1 = z.object({
  schemaVersion: z.literal('measurement-runs.v1'),
  installationId: z.string(),
  generatedAt: iso,
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  latestObservedAt: iso.nullable().optional(),
  items: z.array(z.object({
    segmentId: z.union([z.string(), z.number()]),
    startAt: iso, endAt: iso,
    workUnits: big.nullable().optional(),
    provenance: z.enum(['hardware', 'simulated', 'replay', 'derived']),
    profile: z.enum(['development', 'staging', 'shadow', 'production']),
    observedAt: iso.optional(),
    measurementEligible: z.boolean().optional(),
  }).passthrough()),
  nextCursor: z.string().nullable().optional(),
}).passthrough();
export type RunsV1 = z.infer<typeof RunsV1>;

export const StatsV1 = z.object({
  schemaVersion: z.literal(1),
  installationId: z.string(),
  generatedAt: iso,
  range: z.enum(['7d', '30d']),
  timezone: z.string(),
  window: z.object({ startAt: iso, endAt: iso, dayCount: z.number().int(), bucketSeconds: z.literal(1800) }).passthrough(),
  activity: z.object({
    provenance: z.string(),
    days: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      buckets: z.array(z.object({
        startMinuteUtc: z.number().int().min(0).max(1439),
        coverage: z.enum(['complete', 'partial', 'missing', 'future']),
        workUnits: big.nullable().optional(),
      }).passthrough()),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
export type StatsV1 = z.infer<typeof StatsV1>;

export type Endpoint = 'status' | 'runs' | 'stats';
export interface FetchResult<T> {
  readonly endpoint: Endpoint;
  readonly fetchedAt: Date;
  readonly httpStatus: number | null;
  readonly etag: string | null;
  /** 304: nothing changed since the ETag. */
  readonly notModified: boolean;
  readonly raw: string | null;
  readonly parsed: T | null;
  readonly error: string | null;
  readonly retryAfterMs: number | null;
}

export interface SqueekchainClient {
  status(etag?: string | null): Promise<FetchResult<StatusV1>>;
  /** Runs are oldest first; pass the previous page's nextCursor to continue from it. */
  runs(limit?: number, cursor?: string | null): Promise<FetchResult<RunsV1>>;
  stats(range: '7d' | '30d', etag?: string | null): Promise<FetchResult<StatsV1>>;
}

/** The real HTTP client. `baseUrl` defaults to https://api.squeekchain.com. */
export function squeekchainClient(baseUrl = 'https://api.squeekchain.com', fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): SqueekchainClient {
  async function get<T>(endpoint: Endpoint, path: string, schema: z.ZodType<T>, etag?: string | null): Promise<FetchResult<T>> {
    const fetchedAt = now();
    const headers: Record<string, string> = { accept: 'application/json', 'x-request-id': `sqa-${endpoint}-${fetchedAt.getTime()}` };
    if (etag) headers['if-none-match'] = etag;
    let res: Response;
    try { res = await fetchImpl(baseUrl + path, { headers, signal: AbortSignal.timeout(5000) }); }
    catch (e) { return { endpoint, fetchedAt, httpStatus: null, etag: null, notModified: false, raw: null, parsed: null, error: `unreachable: ${(e as Error).message}`, retryAfterMs: null }; }
    const ra = res.headers.get('retry-after');
    const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - fetchedAt.getTime())) : null;
    if (res.status === 304) return { endpoint, fetchedAt, httpStatus: 304, etag: etag ?? null, notModified: true, raw: null, parsed: null, error: null, retryAfterMs };
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { endpoint, fetchedAt, httpStatus: res.status, etag: null, notModified: false, raw, parsed: null, error: `http ${res.status}`, retryAfterMs };
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return { endpoint, fetchedAt, httpStatus: res.status, etag: null, notModified: false, raw, parsed: null, error: 'not json', retryAfterMs }; }
    const p = schema.safeParse(json);
    return { endpoint, fetchedAt, httpStatus: res.status, etag: res.headers.get('etag'), notModified: false, raw, parsed: p.success ? p.data : null, error: p.success ? null : `schema: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, retryAfterMs };
  }
  return {
    status: (etag) => get('status', '/v1/status', StatusV1, etag),
    runs: (limit = 20, cursor = null) => get('runs', `/v1/measurement/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, RunsV1),
    stats: (range, etag) => get('stats', `/v1/measurement/stats?range=${range}`, StatsV1, etag),
  };
}
