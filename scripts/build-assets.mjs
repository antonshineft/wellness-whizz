#!/usr/bin/env node
/**
 * Copy public/ to dist/ with CSS and JavaScript minified (esbuild). `npm run deploy` and `npm run dev` run this
 * first (predeploy / predev); wrangler serves the static assets from dist/.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';

const SRC = new URL('../public/', import.meta.url).pathname;
const OUT = new URL('../dist/', import.meta.url).pathname;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

let saved = 0;
async function minifyDir(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      await minifyDir(file);
      continue;
    }
    const loader = name.endsWith('.css') ? 'css' : name.endsWith('.js') && !name.endsWith('.min.js') ? 'js' : null;
    if (!loader) continue;
    const before = readFileSync(file, 'utf8');
    try {
      const { code } = await transform(before, { loader, minify: true, legalComments: 'none', target: loader === 'js' ? 'es2017' : undefined });
      writeFileSync(file, code);
      saved += before.length - code.length;
    } catch (err) {
      console.error(`not minified (${name}): ${String(err).split('\n')[0]}`);
    }
  }
}
await minifyDir(OUT);
console.log(`assets built into dist/ (${Math.round(saved / 1024)} KB smaller)`);
