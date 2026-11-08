// Content hash of the rules-v3 sim build. A flight pins it at start; the client reports the hash of
// the build it runs (injected at bundle time), the gateway's shadow and the worker run the same files.
// Node only: the browser gets the value baked into its bundle.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SIM_V3_FILES = ['sim.ts', 'pressure.ts', 'encode.ts', 'replay.ts', 'index.ts'] as const;

let cached: string | null = null;
export function simV3BuildSha256(): string {
  if (cached) return cached;
  const h = createHash('sha256');
  for (const f of SIM_V3_FILES) {
    const text = readFileSync(fileURLToPath(new URL('./' + f, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    h.update(f + '\n' + text.length + '\n' + text);
  }
  cached = h.digest('hex');
  return cached;
}
