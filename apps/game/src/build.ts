// Builds the game into one self-contained HTML page: the template, the art atlas, and an esbuild
// bundle of the client with sim rules v3 and the route catalogue. With --backend, the page is told
// where the local flight API and gateway run, which turns on Online mode.
import { build } from 'esbuild';
import { simV3BuildSha256 } from '@sqk/sim/v3/build';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export interface GameBuildOptions {
  /** Website home link for the entry screen (the site build sets '../'). */
  readonly home?: string;
  /** The project's X profile, for the optional Follow us on X action. */
  readonly followX?: string;
  /** api: base URL of the flight API ('' = same origin; the gateway URL comes with each flight). */
  readonly backend?: { readonly api: string };
  readonly minify?: boolean;
  /** For publishing as an artifact: the host wraps the page in its own document skeleton. */
  readonly artifact?: boolean;
  /** window.__squeek test handle (on for development and tests, off for the public preview). */
  readonly testHooks?: boolean;
  /** The public Builder Preview: practice only, labelled as such. */
  readonly preview?: boolean;
}

export async function buildGame(opts: GameBuildOptions = {}): Promise<string> {
  const out = await build({
    entryPoints: [join(here, 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    minify: opts.minify ?? true,
    legalComments: 'none',
    define: { __SIM_BUILD__: JSON.stringify(simV3BuildSha256()), __TEST_HOOKS__: String(opts.testHooks ?? true) },
    logLevel: 'silent',
  });
  const js = out.outputFiles[0]!.text;
  const atlas = readFileSync(join(here, 'atlas.js'), 'utf8');
  const cfg = (opts.backend ? `window.SQK_BACKEND = ${JSON.stringify(opts.backend)};\n` : '') + (opts.preview ? 'window.SQK_PREVIEW = true;\n' : '')
    + (opts.home ? `window.SQK_HOME = ${JSON.stringify(opts.home)};\n` : '') + (opts.followX ? `window.SQK_FOLLOW_X = ${JSON.stringify(opts.followX)};\n` : '');
  // the three typefaces, inlined: the page makes no third-party font requests
  const fonts = gameFontCss();
  const tpl = readFileSync(join(here, 'template.html'), 'utf8').replace('/*FONTS*/', () => fonts)
    .replaceAll('/*CAPTAIN*/', () => 'data:image/png;base64,' + readFileSync(join(here, '..', 'assets', 'captain-160.png')).toString('base64'));
  const body = tpl.replace('/*ATLAS*/', () => atlas).replace('/*GAME*/', () => cfg + js.replace(/<\/script/gi, '<\\/script'));
  if (opts.artifact) return body;
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + body.replace('<style>', '</head><body>\n<style>') + '\n</body></html>\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(here, '..', 'dist');
  mkdirSync(outDir, { recursive: true });
  const backendArg = process.argv.find((a) => a.startsWith('--backend='));
  const backend = backendArg ? (JSON.parse(backendArg.slice('--backend='.length)) as { api: string }) : undefined;
  const artifact = process.argv.includes('--artifact');
  const html = await buildGame({ ...(backend ? { backend } : {}), artifact });
  const file = join(outDir, artifact ? 'artifact.html' : 'index.html');
  writeFileSync(file, html);
  console.log('wrote', file, (html.length / 1024).toFixed(0), 'KB');
}

/** The game's three typefaces as inline @font-face rules (shared with the public website). */
export function gameFontCss(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const face = (family: string, file: string, weight: number) => `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(join(here, '..', 'fonts', file)).toString('base64')}) format("woff2")}`;
  return [face('Jersey 10', 'jersey-10-latin-400-normal.woff2', 400), ...[400, 600, 700].map((w) => face('Pixelify Sans', `pixelify-sans-latin-${w}-normal.woff2`, w)), ...[400, 500].map((w) => face('IBM Plex Mono', `ibm-plex-mono-latin-${w}-normal.woff2`, w))].join('\n');
}
