#!/usr/bin/env node
/**
 * Bundle the Webflow CMS content into the Worker so a fresh deployment loads it automatically on first start.
 *
 *   node scripts/build-data.mjs path/to/Supplements.csv [path/to/Results.csv] [--download-images]
 *
 * Writes data/supplements.json and data/results.json (committed to the repository). The Worker's bootstrap
 * (src/bootstrap.ts) inserts them when the database is still empty. Re-run after exporting new content from Webflow.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeManifest } from './data-manifest.mjs';
import { resultsFromCsv, supplementsFromCsv } from './webflow-mapping.mjs';

const args = process.argv.slice(2);
const downloadImages = args.includes('--download-images');
const [supplementsCsv, resultsCsv] = args.filter((a) => !a.startsWith('--'));
if (!supplementsCsv) {
  console.error('usage: node scripts/build-data.mjs <Supplements.csv> [Results.csv] [--download-images]');
  process.exit(1);
}
const DATA_DIR = new URL('../data/', import.meta.url);
const IMAGE_DIR = new URL('../public/images/products/', import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });

const { records, skipped, columnFor, ignored } = await supplementsFromCsv(readFileSync(supplementsCsv, 'utf8'), {
  imageResolver: downloadImages ? localImage : undefined,
});
console.error('Matched columns: ' + Object.entries(columnFor).map(([f, c]) => `${f}<-"${c}"`).join(', '));
if (ignored.length) console.error('Ignored columns: ' + ignored.map((h) => `"${h}"`).join(', '));
writeFileSync(new URL('supplements.json', DATA_DIR), JSON.stringify(records, null, 1) + '\n');
console.error(`data/supplements.json: ${records.length} supplements (${skipped} rows skipped)`);

if (resultsCsv) {
  const { sessions, skipped: skippedResults } = resultsFromCsv(readFileSync(resultsCsv, 'utf8'));
  writeFileSync(new URL('results.json', DATA_DIR), JSON.stringify(sessions, null, 1) + '\n');
  console.error(`data/results.json: ${sessions.length} sessions (${skippedResults} rows skipped)`);
} else if (!existsSync(new URL('results.json', DATA_DIR))) {
  writeFileSync(new URL('results.json', DATA_DIR), '[]\n');
}
const manifest = writeManifest();
console.error(`data/manifest.json: supplements ${manifest.supplementsVersion}, results ${manifest.resultsVersion}`);

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
