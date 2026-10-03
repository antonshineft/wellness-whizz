#!/usr/bin/env node
/**
 * Convert a Webflow CMS export of the "Supplements" collection into SQL for the D1 database.
 *
 *   1. In Webflow: CMS -> Supplements -> Export (CSV).
 *   2. node scripts/import-webflow-csv.mjs path/to/Supplements.csv > import.sql
 *   3. npx wrangler d1 execute wellness-whizz --remote --file=import.sql   (or --local)
 *
 * Add --download-images to copy the product images from Webflow's CDN into public/images/products/ and link to the
 * local copies (run it before Webflow hosting is switched off). Without it the original image URLs are kept.
 * Rows are upserted by supplement name or slug, so re-running the import refreshes existing rows.
 *
 * Column names are matched by scripts/webflow-mapping.mjs (FIELD_MAP); the script prints what it matched to stderr.
 * Tip: to bundle the content into the Worker instead (loaded automatically on first start), use scripts/build-data.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { supplementInsert } from './lib.mjs';
import { supplementsFromCsv } from './webflow-mapping.mjs';

const args = process.argv.slice(2);
const downloadImages = args.includes('--download-images');
const file = args.find((a) => !a.startsWith('--'));
const IMAGE_DIR = new URL('../public/images/products/', import.meta.url);
if (!file) {
  console.error('usage: node scripts/import-webflow-csv.mjs <Supplements.csv> [--download-images] > import.sql');
  process.exit(1);
}

const { records, skipped, columnFor, ignored } = await supplementsFromCsv(readFileSync(file, 'utf8'), {
  imageResolver: downloadImages ? localImage : undefined,
});
console.error('Matched columns:');
for (const [field, col] of Object.entries(columnFor)) console.error(`  ${field.padEnd(22)} <- "${col}"`);
console.error('Ignored columns: ' + ignored.map((h) => `"${h}"`).join(', '));

const statements = records.map((rec) => supplementInsert(rec, 'upsert'));
process.stdout.write(`-- Imported from ${file} by scripts/import-webflow-csv.mjs\n${statements.join('\n\n')}\n`);
console.error(`Wrote ${statements.length} INSERT statements (${skipped} rows skipped).`);

/** Download a product image into public/images/products and return its local URL (falls back to the remote URL). */
async function localImage(url, baseName) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = (/\.(png|jpe?g|webp|gif|svg)(?=$|\?)/i.exec(new URL(url).pathname)?.[1] ?? 'png').toLowerCase();
    const fileName = `${baseName}.${ext}`;
    mkdirSync(IMAGE_DIR, { recursive: true });
    const target = new URL(fileName, IMAGE_DIR);
    if (!existsSync(target)) writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    return `/images/products/${fileName}`;
  } catch (err) {
    console.error(`  image not downloaded (${err.message}): ${url}`);
    return url;
  }
}
