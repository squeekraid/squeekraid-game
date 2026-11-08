// Public subset of the Squeekchain activity module: the typed API client, the live-state detector and
// the wheel buckets that shape routes. The server's polling, storage and scheduling are not included.
export { StatusV1, RunsV1, StatsV1, squeekchainClient } from './api.ts';
export type { SqueekchainClient, FetchResult, Endpoint } from './api.ts';
export { classify, isValidSample, latestProfile, DETECTOR_V1 } from './detector.ts';
export type { LiveState, DetectorConfig, Classification, StatusSample } from './detector.ts';
export { bucketsOf, MIN_COVERAGE } from './buckets.ts';
