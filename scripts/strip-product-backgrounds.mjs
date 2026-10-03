#!/usr/bin/env node
/**
 * Make the flat background of the product photos in public/images/products transparent, so they sit on any card
 * colour. The background colour is read from the image corners and removed only where it touches the edges
 * (flood fill), so cream-coloured labels inside a bottle are kept. Idempotent: already transparent images are skipped.
 *
 *   node scripts/strip-product-backgrounds.mjs [--tolerance 28] [--feather 22]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const TOLERANCE = opt('--tolerance', 28); // colour distance treated as background
const FEATHER = opt('--feather', 22); // extra distance over which alpha fades in (softens edges)
const DIR = new URL('../public/images/products/', import.meta.url);

let done = 0;
let skipped = 0;
for (const file of readdirSync(DIR).filter((f) => /\.(webp|png)$/i.test(f))) {
  const path = new URL(file, DIR);
  const input = sharp(readFileSync(path));
  const meta = await input.metadata();
  if (meta.hasAlpha) {
    skipped++;
    continue;
  }
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const bg = cornerColour(data, w, h, channels);
  const dist = (i) => Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);

  // Flood fill from every border pixel through pixels that look like the background.
  const limit = TOLERANCE + FEATHER;
  const visited = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (dist(p * channels) <= limit) queue.push(p);
    else visited[p] = 2; // foreground
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (queue.length) {
    const p = queue.pop();
    const x = p % w;
    const y = (p - x) / w;
    const d = dist(p * channels);
    data[p * channels + 3] = d <= TOLERANCE ? 0 : Math.round((255 * (d - TOLERANCE)) / FEATHER);
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  const out = await sharp(data, { raw: { width: w, height: h, channels } }).webp({ quality: 85, alphaQuality: 90 }).toBuffer();
  writeFileSync(path, out);
  done++;
}
console.log(`backgrounds removed: ${done} images (${skipped} already transparent)`);

function cornerColour(data, w, h, c) {
  const pts = [0, (w - 1) * c, (h - 1) * w * c, ((h - 1) * w + (w - 1)) * c];
  const avg = [0, 0, 0];
  for (const i of pts) for (let k = 0; k < 3; k++) avg[k] += data[i + k] / pts.length;
  return avg;
}
