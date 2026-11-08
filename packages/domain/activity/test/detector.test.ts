import { describe, expect, it } from 'vitest';
import { bucketsOf, classify, squeekchainClient, StatusV1 } from '../src/index.ts';
import { stats, status } from './fixtures.ts';

const now = new Date('2026-11-01T12:00:10Z');
const at = (msAgo: number) => new Date(now.getTime() - msAgo);
const sample = (s: StatusV1 | null, msAgo = 1000, error: string | null = null) => ({ fetchedAt: at(msAgo), status: s, error });

describe('detector v1', () => {
  it('reads LIVE only for a fresh, validated hardware observation that meets the running rule', () => {
    const s = sample(status({ speed: 250 }));
    expect(classify(s, s, 'production', now).state).toBe('LIVE');
    expect(classify(sample(status({ speed: 40 })), s, 'production', now).state).toBe('IDLE');
  });
  it('never treats missing or untrusted data as a resting hamster', () => {
    const valid = sample(status(), 120_000);
    expect(classify(sample(null, 500, 'unreachable'), null, 'production', now).state).toBe('NO_DATA');
    expect(classify(sample(status({ provenance: 'simulated' })), null, 'production', now)).toEqual({ state: 'NO_DATA', reason: 'provenance_simulated' });
    expect(classify(sample(status({ signer: false })), null, 'production', now).state).toBe('NO_DATA');
    expect(classify(sample(status({ coreStatus: 'COUNTER_FAULT' })), null, 'production', now).state).toBe('NO_DATA');
    // profiles: the official installation's staging segments are accepted (owner decision 2026-11-08);
    // development, shadow and an unknown profile are not
    expect(classify(sample(status()), null, 'staging', now).state).toBe('LIVE');
    expect(classify(sample(status()), null, 'development', now)).toEqual({ state: 'NO_DATA', reason: 'profile_development' });
    expect(classify(sample(status()), null, 'shadow', now)).toEqual({ state: 'NO_DATA', reason: 'profile_shadow' });
    expect(classify(sample(status()), null, null, now)).toEqual({ state: 'NO_DATA', reason: 'profile_unknown' });
    // a valid observation 2 minutes ago: DELAYED, not IDLE; after 10 minutes: NO DATA
    expect(classify(sample(null, 500, 'unreachable'), valid, 'production', now).state).toBe('DELAYED');
    expect(classify(sample(null, 500, 'unreachable'), sample(status({ observedAt: at(11 * 60_000) }), 11 * 60_000), 'production', now).state).toBe('NO_DATA');
    // the API itself says stale
    expect(classify(sample(status({ freshness: 'stale' })), valid, 'production', now).state).toBe('DELAYED');
    // A: a fresh poll that repeats an old observation (304 or a cached body) is not LIVE
    expect(classify(sample(status({ observedAt: new Date(now.getTime() - 60_000) })), valid, 'production', now).state).toBe('DELAYED');
    // a poll older than 10 s is not fresh
    expect(classify(sample(status(), 15_000), sample(status(), 15_000), 'production', now).state).toBe('DELAYED');
    expect(classify(sample(status({ observedAt: at(16_000) })), null, 'production', now).state).toBe('DELAYED');
    // at rest: the once-a-minute report stays IDLE up to 120 s (or the API's own bound), then DELAYED
    expect(classify(sample(status({ speed: 0, observedAt: at(60_000) })), null, 'production', now).state).toBe('IDLE');
    expect(classify(sample(status({ speed: 0, observedAt: at(121_000) })), null, 'production', now).state).toBe('DELAYED');
  });
  it('rejects unsupported schema versions and parses large numbers as strings', () => {
    expect(StatusV1.safeParse({ ...status(), schemaVersion: 2 }).success).toBe(false);
    expect(StatusV1.safeParse(status()).success).toBe(true);
  });
  it('maps a noon-to-noon day to 48 buckets in clock order, with coverage', () => {
    const b = bucketsOf(stats('2026-10-30', 36), '2026-10-30')!;
    expect(b.coverage).toBe(0.75);
    expect(b.buckets[24]).toBe(600); // 12:00 UTC: the first bucket of the day
    expect(b.buckets.filter((x) => x === null)).toHaveLength(12);
    expect(bucketsOf(stats('2026-10-30', 48), '2026-10-31')).toBeNull();
  });
  it('the HTTP client sends If-None-Match, honours 304 and Retry-After, and reports failures', async () => {
    const seen: Record<string, string>[] = [];
    let n = 0;
    const fake: typeof fetch = async (_u, init) => {
      seen.push(init?.headers as Record<string, string>);
      n++;
      if (n === 1) return new Response(JSON.stringify(status()), { status: 200, headers: { etag: '"v1"' } });
      if (n === 2) return new Response(null, { status: 304 });
      if (n === 3) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'retry-after': '3' } });
      throw new TypeError('fetch failed');
    };
    const c = squeekchainClient('https://api.example', fake);
    const a = await c.status();
    expect(a.parsed?.schemaVersion).toBe(1);
    expect(a.etag).toBe('"v1"');
    const b = await c.status(a.etag);
    expect(seen[1]!['if-none-match']).toBe('"v1"');
    expect(b.notModified).toBe(true);
    const r = await c.status();
    expect(r).toMatchObject({ httpStatus: 429, retryAfterMs: 3000, parsed: null });
    expect((await c.status()).error).toMatch(/unreachable/);
  });
});
