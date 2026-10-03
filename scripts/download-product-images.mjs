#!/usr/bin/env node
/**
 * Copy the product photos referenced in data/supplements.json from Webflow's CDN into public/images/products/,
 * shrink them to web size (max 612 px wide, WebP) and point the data at the local files. Run it once before
 * Webflow hosting is cancelled; commit public/images/products and data/ afterwards, the next deploy refreshes
 * the live database automatically.
 *
 *   node scripts/download-product-images.mjs [--max-width 612] [--concurrency 6]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeManifest } from './data-manifest.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const MAX_WIDTH = opt('--max-width', 612);
const CONCURRENCY = opt('--concurrency', 6);
const DATA_FILE = new URL('../data/supplements.json', import.meta.url);
const IMAGE_DIR = new URL('../public/images/products/', import.meta.url);
mkdirSync(IMAGE_DIR, { recursive: true });

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is not installed; images are stored as downloaded (run `npm install` to get resizing).');
}

const supplements = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const jobs = [];
for (const s of supplements) {
  s.products.forEach((p, i) => {
    if (/^https?:\/\//i.test(p.image ?? '')) jobs.push({ product: p, baseName: `${s.slug}-${i + 1}` });
  });
}
console.error(`${jobs.length} remote product images to copy`);

let done = 0;
let failed = 0;
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    try {
      job.product.image = await localise(job.product.image, job.baseName);
      done++;
    } catch (err) {
      failed++;
      console.error(`  failed ${job.product.image}: ${err.message}`);
    }
    if ((done + failed) % 50 === 0) console.error(`  ${done + failed} processed`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

writeFileSync(DATA_FILE, JSON.stringify(supplements, null, 1) + '\n');
const manifest = writeManifest();
console.error(`done: ${done} copied, ${failed} failed; data/supplements.json rewritten (version ${manifest.supplementsVersion})`);

async function localise(url, baseName) {
  const ext = sharp ? 'webp' : ((/\.(png|jpe?g|webp|gif)(?=$|\?)/i.exec(new URL(url).pathname)?.[1] ?? 'png').toLowerCase());
  const fileName = `${baseName}.${ext}`;
  const target = new URL(fileName, IMAGE_DIR);
  if (!existsSync(target)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const original = Buffer.from(await res.arrayBuffer());
    const bytes = sharp
      ? await sharp(original).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
      : original;
    writeFileSync(target, bytes);
  }
  return `/images/products/${fileName}`;
}
