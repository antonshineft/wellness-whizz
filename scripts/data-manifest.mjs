// Writes data/manifest.json with a version (content hash) per bundled data file.
// The Worker compares these with what it already loaded and refreshes the database when they change.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const DATA_DIR = new URL('../data/', import.meta.url);

function version(fileName) {
  const file = new URL(fileName, DATA_DIR);
  if (!existsSync(file)) return 'none';
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
}

export function writeManifest() {
  const manifest = {
    supplementsVersion: version('supplements.json'),
    resultsVersion: version('results.json'),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(new URL('manifest.json', DATA_DIR), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
