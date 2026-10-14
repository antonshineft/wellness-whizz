#!/usr/bin/env node
/**
 * Make the flat background of the product photos in public/images/products transparent, so they sit on any card
 * colour. The background colour is read from the image corners and removed only where it touches the edges
 * (flood fill), so cream-coloured labels inside a bottle are kept. Idempotent: already transparent images are skipped.
 *
 *   node scripts/strip-product-backgrounds.mjs [--tolerance 12] [--feather 18] [--gap 3]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { stripBackground } from './strip-background.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const TOLERANCE = opt('--tolerance', 12); // colour distance the fill may walk through
const FEATHER = opt('--feather', 18); // extra distance over which alpha fades in (softens edges)
const GAP = opt('--gap', 3); // leaks through gaps narrower than about twice this are cut off
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
  stripBackground(data, w, h, channels, { TOLERANCE, FEATHER, GAP });
  const out = await sharp(data, { raw: { width: w, height: h, channels } }).webp({ quality: 85, alphaQuality: 90 }).toBuffer();
  writeFileSync(path, out);
  done++;
}
console.log(`backgrounds removed: ${done} images (${skipped} already transparent)`);
