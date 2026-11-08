// Detector v1 (plan v1.1, "Squeekchain activity detector"). Pure: a state from the latest stored
// observations. Only LIVE enables Live Drops. A missing or unreadable API is NO DATA, never IDLE, and
// the game never says "asleep". The running rule is provisional until Squeekchain defines one.
import type { RunsV1, StatusV1 } from './api.ts';

export type LiveState = 'LIVE' | 'IDLE' | 'DELAYED' | 'NO_DATA';
export interface DetectorConfig {
  readonly version: string;
  /** Running rule (provisional): speedMmPerSecond at or above this on the latest validated observation. */
  readonly minSpeedMmPerSecond: number;
  readonly freshMs: number;
  /** The observation itself (observedAt) must be at most this old for LIVE or IDLE: a 304 or a cached
   *  response repeats an old observation, and old evidence is not live evidence. */
  readonly maxObservationAgeMs: number;
  /** A resting wheel is reported about once a minute: an at-rest observation stays IDLE up to this age
   *  (and never beyond the API's own staleAfterSeconds). Running always needs maxObservationAgeMs. */
  readonly maxIdleObservationAgeMs: number;
  readonly delayedMaxMs: number;
  /** signer.kind values trusted as hardware attestation (official list is an external blocker). */
  readonly trustedSignerKinds: readonly string[] | null;
  /** Run-segment profiles accepted as real activity of the official installation. */
  readonly acceptedProfiles: readonly string[];
}
/**
 * v1.1 (owner decision, 2026-11-08): Squeekchain runs on Sepolia and labels its official installation's
 * segments `staging`; those are accepted alongside `production`. `development` and `shadow` are not.
 */
export const DETECTOR_V1: DetectorConfig = { version: 'detector-v1.1-provisional', minSpeedMmPerSecond: 100, freshMs: 10_000, maxObservationAgeMs: 15_000, maxIdleObservationAgeMs: 120_000, delayedMaxMs: 10 * 60_000, trustedSignerKinds: null, acceptedProfiles: ['production', 'staging'] };

export interface StatusSample { readonly fetchedAt: Date; readonly status: StatusV1 | null; readonly error: string | null }
export interface Classification { readonly state: LiveState; readonly reason: string }

/** Validated: hardware provenance, a signer present, an accepted profile (from runs), no counter fault. */
function validated(s: StatusV1, profile: string | null, cfg: DetectorConfig): string | null {
  const m = s.measurement;
  if (!m) return 'no_measurement';
  if (m.provenance !== 'hardware') return `provenance_${m.provenance}`;
  if (!s.signer) return 'no_signer';
  if (cfg.trustedSignerKinds && !cfg.trustedSignerKinds.includes(s.signer.kind)) return `signer_${s.signer.kind}`;
  if (m.coreStatus === 'COUNTER_FAULT') return 'counter_fault';
  if (!profile) return 'profile_unknown';
  if (!cfg.acceptedProfiles.includes(profile)) return `profile_${profile}`;
  return null;
}

/**
 * `latest`: the newest status poll (successful or not). `lastValid`: the newest poll whose observation
 * validated. `profile`: the profile of the newest runs segment, if any.
 */
export function classify(latest: StatusSample | null, lastValid: StatusSample | null, profile: string | null, now: Date, cfg: DetectorConfig = DETECTOR_V1): Classification {
  const age = (t: Date) => now.getTime() - t.getTime();
  let why: string | null = null;
  if (latest && latest.status && !latest.error && age(latest.fetchedAt) <= cfg.freshMs) {
    why = validated(latest.status, profile, cfg);
    if (!why) {
      const m = latest.status.measurement!;
      if (m.freshness === 'stale') return { state: 'DELAYED', reason: 'api_reports_stale' };
      const obsAge = now.getTime() - Date.parse(m.observedAt);
      const old = { state: 'DELAYED' as const, reason: `observation_${Number.isFinite(obsAge) ? Math.round(obsAge / 1000) + 's' : 'undated'}_old` };
      if (!Number.isFinite(obsAge)) return old;
      const speed = m.speedMmPerSecond ?? 0;
      // running is only ever shown from a fresh observation: earlier activity is not current activity
      if (speed >= cfg.minSpeedMmPerSecond) return obsAge > cfg.maxObservationAgeMs ? old : { state: 'LIVE', reason: `speed_${speed}` };
      // at rest the API reports about once a minute; it stays IDLE while that report is within its own staleness bound
      const idleMax = Math.min(cfg.maxIdleObservationAgeMs, typeof m.staleAfterSeconds === 'number' ? m.staleAfterSeconds * 1000 : Infinity);
      return obsAge > idleMax ? old : { state: 'IDLE', reason: `speed_${speed}` };
    }
    if (latest.status.measurement?.provenance && latest.status.measurement.provenance !== 'hardware') return { state: 'NO_DATA', reason: why };
  }
  // DELAYED is measured from the newest valid observation itself, not from when it was fetched
  const validAt = lastValid?.status?.measurement ? Date.parse(lastValid.status.measurement.observedAt) : NaN;
  if (lastValid && Number.isFinite(validAt) && now.getTime() - validAt <= cfg.delayedMaxMs) return { state: 'DELAYED', reason: `last_valid_${Math.round((now.getTime() - validAt) / 1000)}s_ago` };
  // the reason is the current one: why the newest poll does not validate, if it was readable
  return { state: 'NO_DATA', reason: latest?.error ?? why ?? (latest ? 'nothing_valid_for_10_min' : 'never_polled') };
}

/** The profile of the last segment on one runs page (the newest only when that page is the tail). */
export function latestProfile(runs: RunsV1 | null): string | null {
  if (!runs || !runs.items.length) return null;
  return runs.items[runs.items.length - 1]!.profile;
}
export function isValidSample(s: StatusSample, profile: string | null, cfg: DetectorConfig = DETECTOR_V1): boolean {
  return !!s.status && !s.error && validated(s.status, profile, cfg) === null;
}
