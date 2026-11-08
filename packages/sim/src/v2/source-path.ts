import { fileURLToPath } from 'node:url';

/** Absolute path of the frozen rules-v2 source, for runners that load it into another engine. */
export const SIM_V2_SOURCE_PATH: string = fileURLToPath(new URL('./sim.v2.cjs', import.meta.url));

/** SHA-256 of sim.v2.cjs as recorded with the golden corpus on 2026-11-01. Changing the file is a rules change. */
export const SIM_V2_SHA256 = '8fbb13f82cbdb4b03159f27680e1048cd7f31b4c484caeec430ff183a7262cbf';
