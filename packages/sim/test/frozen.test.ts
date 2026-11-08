import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_V2_SHA256, SIM_V2_SOURCE_PATH, simV2 } from '../src/index.ts';

describe('rules v2 is frozen', () => {
  it('sim.v2.cjs is byte-identical to the prototype recorded with the golden corpus', () => {
    const digest = createHash('sha256').update(readFileSync(SIM_V2_SOURCE_PATH)).digest('hex');
    expect(digest).toBe(SIM_V2_SHA256);
  });

  it('exposes the v2 API', () => {
    expect(simV2.RULES).toBe(2);
    expect(typeof simV2.replay).toBe('function');
    expect(simV2.IN.FIRE).toBe(16);
  });

  it('is deterministic for the same route and inputs', () => {
    const route = { id: 't', seed: 12345, w: new Array<number>(48).fill(640), crates: false };
    const inputs = [[0, 0], [120, 2], [140, 0], [200, 16], [260, 1], [280, 0]] as const;
    const a = simV2.replay(route, inputs);
    const b = simV2.replay(route, inputs);
    expect(a).toEqual(b);
  });
});
