#!/usr/bin/env node
/**
 * Convert a Webflow CMS export of the "Results" collection (one item per quiz session) into SQL, so that old
 * /result/{sessionID} links keep working after the move.
 *
 *   node scripts/import-webflow-results-csv.mjs path/to/Results.csv > results.sql
 *   npx wrangler d1 execute wellness-whizz --remote --file=results.sql
 *
 * Run it AFTER importing the Supplements collection: each "Supplement N" column holds a supplement slug, which is
 * resolved against the supplements table (the Webflow slug, or the same slug without its random suffix).
 */
import { readFileSync } from 'node:fs';
import { sql } from './lib.mjs';
import { resultsFromCsv } from './webflow-mapping.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/import-webflow-results-csv.mjs <Results.csv> > results.sql');
  process.exit(1);
}
const { sessions, skipped } = resultsFromCsv(readFileSync(file, 'utf8'));
const statements = [];
let cards = 0;
for (const s of sessions) {
  statements.push(
    `INSERT OR IGNORE INTO sessions (id, sex, age, activity, diet, goal, status, created_at, completed_at) ` +
      `VALUES (${sql(s.id)}, '', '', '', '', '', 'ready', ${sql(s.created_at)}, ${sql(s.created_at)});`,
  );
  for (const card of s.cards) {
    const bare = card.slug.replace(/-[0-9a-f]{5}$/, '');
    statements.push(
      `INSERT OR IGNORE INTO session_supplements (session_id, position, supplement_id, reason) ` +
        `SELECT ${sql(s.id)}, ${card.position}, id, ${sql(card.reason)} FROM supplements WHERE slug IN (${sql(card.slug)}, ${sql(bare)}) ` +
        `ORDER BY CASE WHEN slug = ${sql(card.slug)} THEN 0 ELSE 1 END LIMIT 1;`,
    );
    cards++;
  }
}
process.stdout.write(`-- Imported from ${file} by scripts/import-webflow-results-csv.mjs\n${statements.join('\n')}\n`);
console.error(`Wrote ${sessions.length} sessions with ${cards} cards (${skipped} rows skipped).`);
