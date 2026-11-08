import { createRequire } from 'node:module';
import type { SimV2 } from './v2/types.ts';

export type { RouteV2, InputChangeV2, ReplayResultV2, StateV2, SimV2 } from './v2/types.ts';
export { SIM_V2_SHA256, SIM_V2_SOURCE_PATH } from './v2/source-path.ts';

const require = createRequire(import.meta.url);

/** The frozen rules-v2 simulation, loaded from its unchanged prototype source. */
export const simV2: SimV2 = require('./v2/sim.v2.cjs') as SimV2;

/** Rules v3: the current ruleset (fixed speed, pressure model, AI behaviours, bounded fuel, Gear). */
export * as simV3 from './v3/index.ts';
