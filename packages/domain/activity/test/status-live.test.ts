// The live /v1/status body as https://api.squeekchain.com returned it on 2026-11-07 (04:30 UTC),
// sanitized: the signature is replaced; every field and its type is as received. The live signer
// reports keySlot: null, which the adapter refused ("signer.keySlot ... received null"), so the
// detector read NO DATA while the API was answering.
import { describe, expect, it } from 'vitest';
import { classify, squeekchainClient, StatusV1 } from '../src/index.ts';
import { LIVE_STATUS_2026_11_07 as liveStatus } from './fixtures.ts';

const withSigner = (signer: Record<string, unknown>) => ({ ...liveStatus, signer });
const { keySlot: _omit, ...signerWithoutSlot } = liveStatus.signer;

describe('live /v1/status (2026-11-07)', () => {
  it('accepts the live body, with keySlot null', () => {
    const p = StatusV1.safeParse(liveStatus);
    expect(p.success).toBe(true);
    expect(p.data!.signer!.keySlot).toBeNull();
  });
  it('signer.keySlot may be a string, null or absent, and nothing else', () => {
    expect(StatusV1.safeParse(withSigner({ ...liveStatus.signer, keySlot: 'a' })).success).toBe(true);
    expect(StatusV1.safeParse(withSigner({ ...liveStatus.signer, keySlot: null })).success).toBe(true);
    expect(StatusV1.safeParse(withSigner(signerWithoutSlot)).success).toBe(true);
    expect(StatusV1.safeParse(withSigner({ ...liveStatus.signer, keySlot: 7 })).success).toBe(false);
    expect(StatusV1.safeParse(withSigner({ ...liveStatus.signer, keySlot: {} })).success).toBe(false);
  });
  it('the rest of the validation is unchanged', () => {
    expect(StatusV1.safeParse(withSigner({ ...liveStatus.signer, kind: null })).success).toBe(false);
    expect(StatusV1.safeParse({ ...liveStatus, schemaVersion: 2 }).success).toBe(false);
    expect(StatusV1.safeParse({ ...liveStatus, measurement: { ...liveStatus.measurement, provenance: 'unknown' } }).success).toBe(false);
  });
  it('through the HTTP client: parsed, no schema error', async () => {
    const r = await squeekchainClient('https://api.example', async () => new Response(JSON.stringify(liveStatus), { headers: { 'content-type': 'application/json' } })).status();
    expect(r.error).toBeNull();
    expect(r.parsed?.signer?.kind).toBe('ed25519');
  });
  it('the detector reads the real data as it is: idle wheel, never invented LIVE; old evidence is DELAYED', () => {
    const s = StatusV1.parse(liveStatus);
    const observed = Date.parse(liveStatus.measurement.observedAt);
    const sample = (at: number) => ({ fetchedAt: new Date(at), status: s, error: null });
    // fresh poll of a fresh observation, wheel at 0 mm/s: IDLE
    expect(classify(sample(observed + 1000), sample(observed + 1000), 'production', new Date(observed + 2000))).toEqual({ state: 'IDLE', reason: 'speed_0' });
    // the same body as served at generatedAt (observation 30 s old): a resting wheel is reported about
    // once a minute, so it is still IDLE; past the API's staleAfterSeconds (120 s) it is DELAYED
    const gen = Date.parse(liveStatus.generatedAt);
    expect(classify(sample(gen), sample(gen), 'production', new Date(gen)).state).toBe('IDLE');
    expect(classify(sample(observed + 121_000), sample(observed + 121_000), 'production', new Date(observed + 121_000)).state).toBe('DELAYED');
    // without an accepted runs profile the observation does not validate
    expect(classify(sample(observed + 1000), null, null, new Date(observed + 2000)).state).toBe('NO_DATA');
  });
});
