/**
 * Self-installing, self-updating database.
 *
 * On the first request of a fresh deployment the Worker creates its tables (same SQL as migrations/0001_init.sql).
 * It then compares the version of the content bundled in data/*.json (built from the Webflow CMS exports by
 * scripts/build-data.mjs, versions in data/manifest.json) with the version recorded in the `meta` table and loads or
 * refreshes the rows when they differ. Supplements created by the quiz (source = 'ai') are never touched.
 * Everything here is idempotent and runs once per isolate.
 */
import schemaSql from '../migrations/0001_init.sql';
import { PROSPECT_SQL } from './backlinks';
import supplementsJson from '../data/supplements.json';
import resultsJson from '../data/results.json';
import manifestJson from '../data/manifest.json';
import { asFdaStatus, asFormType, asSafetyStatus, clampRating, normalizeNameKey, type Product } from './db';

interface BundledSupplement {
  slug: string;
  name: string;
  category: string;
  form_type: string;
  fda_status: string;
  safety_status: string;
  effectivity: number;
  safety: number;
  summary: string;
  benefits_html: string;
  contraindications_html: string;
  enhancing_html: string;
  interactions_html: string;
  why_consider: string;
  holistic_html: string;
  studies_html: string;
  products: Product[];
  /** Optional: "Common Questions" exported from a live database (/api/admin/export). */
  faqs?: { q: string; a: string }[];
}

interface BundledSession {
  id: string;
  created_at: string;
  cards: { position: number; slug: string; reason: string }[];
}

interface Manifest {
  supplementsVersion: string;
  resultsVersion: string;
}

const BATCH_SIZE = 100;
const TABLES = ['supplements', 'sessions', 'session_supplements', 'meta', 'events', 'images', 'subscribers', 'social_posts', 'research_notes'];
/** Columns added after the first release; created on databases that predate them. */
/** CREATE TABLE IF NOT EXISTS statements for tables that arrived after the first release (same SQL as the migration). */
const LATER_TABLES: string[] = [
  ...PROSPECT_SQL,
  `CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, script_json TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', video_url TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, set_index INTEGER NOT NULL DEFAULT 0, publish_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rendered_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tiktok_auth (id INTEGER PRIMARY KEY CHECK (id = 1), open_id TEXT NOT NULL, access_token TEXT NOT NULL, access_expires_at TEXT NOT NULL, refresh_token TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tiktok_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, publish_id TEXT NOT NULL, title TEXT NOT NULL, privacy TEXT NOT NULL, status TEXT NOT NULL, fail_reason TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reddit_mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, message_id TEXT, keyword TEXT NOT NULL, subreddit TEXT NOT NULL, title TEXT NOT NULL, author TEXT, kind TEXT NOT NULL, url TEXT NOT NULL, post_id TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reddit_mentions_received ON reddit_mentions(received_at)`,
  `CREATE INDEX IF NOT EXISTS reddit_mentions_post ON reddit_mentions(post_id)`,
  `CREATE TABLE IF NOT EXISTS reddit_used (post_id TEXT PRIMARY KEY, used_at TEXT NOT NULL, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS reddit_scores (post_id TEXT PRIMARY KEY, score INTEGER NOT NULL, scored_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reddit_limits (day TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY (day, keyword))`,
  `CREATE TABLE IF NOT EXISTS blog_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'guide', topic TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', post_json TEXT NOT NULL DEFAULT '', draft_json TEXT NOT NULL DEFAULT '', issues_json TEXT NOT NULL DEFAULT '[]', token TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), published_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS blog_posts_status ON blog_posts(status)`,
  `CREATE TABLE IF NOT EXISTS shelf_scans (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), lang TEXT NOT NULL DEFAULT 'en', goal TEXT NOT NULL DEFAULT '', ip_hash TEXT, products INTEGER NOT NULL DEFAULT 0, analysis_json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS shelf_scans_created ON shelf_scans(created_at)`,
  `CREATE TABLE IF NOT EXISTS translations (lang TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (lang, kind, ref))`,
];

const LATER_COLUMNS: [table: string, column: string, definition: string][] = [
  ['supplements', 'image', "TEXT NOT NULL DEFAULT ''"],
  ['supplements', 'faq_json', "TEXT NOT NULL DEFAULT ''"],
  // Last content change (src/indexing.ts reads it for the sitemap and the search-engine pings).
  ['supplements', 'updated_at', "TEXT NOT NULL DEFAULT ''"],
  // The language the quiz was taken in (src/i18n.ts); the result page and the recommendation text follow it.
  ['sessions', 'lang', "TEXT NOT NULL DEFAULT 'en'"],
];
let ready: Promise<void> | null = null;

/** Make sure schema and bundled content are present and current. Safe to call on every request. */
export function ensureDatabase(db: D1Database): Promise<void> {
  if (!ready) {
    ready = bootstrap(db).catch((err) => {
      ready = null; // retry on the next request
      throw err;
    });
  }
  return ready;
}

async function bootstrap(db: D1Database): Promise<void> {
  const placeholders = TABLES.map(() => '?').join(',');
  const tables = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .bind(...TABLES)
    .all<{ name: string }>();
  if (tables.results.length < TABLES.length) {
    const statements = schemaSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
    console.log('bootstrap: created database schema');
  }

  // Tables added after the first release: created on existing databases here (fresh ones get them from the schema above).
  await db.batch(LATER_TABLES.map((sql) => db.prepare(sql)));

  for (const [table, column, definition] of LATER_COLUMNS) {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!info.results.some((c) => c.name === column)) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      console.log(`bootstrap: added column ${table}.${column}`);
    }
  }

  const manifest = manifestJson as Manifest;
  const loaded = await loadedVersions(db);

  if (loaded.supplements !== manifest.supplementsVersion) {
    const supplements = supplementsJson as BundledSupplement[];
    for (const chunk of chunks(supplements, BATCH_SIZE)) await db.batch(chunk.map((s) => upsertSupplement(db, s)));
    await setVersion(db, 'supplements_version', manifest.supplementsVersion);
    console.log(`bootstrap: loaded ${supplements.length} supplements (version ${manifest.supplementsVersion})`);
  }

  if (loaded.results !== manifest.resultsVersion) {
    const sessions = resultsJson as BundledSession[];
    await loadSessions(db, sessions);
    await setVersion(db, 'results_version', manifest.resultsVersion);
    console.log(`bootstrap: loaded ${sessions.length} past result sessions (version ${manifest.resultsVersion})`);
  }
}

async function loadedVersions(db: D1Database): Promise<{ supplements: string; results: string }> {
  const { results } = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>();
  const get = (key: string) => results.find((r) => r.key === key)?.value ?? '';
  return { supplements: get('supplements_version'), results: get('results_version') };
}

function setVersion(db: D1Database, key: string, value: string) {
  return db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

async function loadSessions(db: D1Database, sessions: BundledSession[]): Promise<void> {
  if (!sessions.length) return;
  const idBySlug = new Map<string, number>();
  const { results } = await db.prepare('SELECT id, slug FROM supplements').all<{ id: number; slug: string }>();
  for (const row of results) idBySlug.set(row.slug, row.id);
  const resolve = (slug: string) => idBySlug.get(slug) ?? idBySlug.get(slug.replace(/-[0-9a-f]{5}$/, ''));

  const statements: D1PreparedStatement[] = [];
  for (const session of sessions) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(session.id)) continue;
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO sessions (id, sex, age, activity, diet, goal, status, created_at, completed_at) VALUES (?, '', '', '', '', '', 'ready', ?, ?)",
        )
        .bind(session.id, session.created_at, session.created_at),
    );
    for (const card of session.cards) {
      const supplementId = resolve(card.slug);
      if (!supplementId) continue;
      statements.push(
        db
          .prepare('INSERT OR IGNORE INTO session_supplements (session_id, position, supplement_id, reason) VALUES (?, ?, ?, ?)')
          .bind(session.id, card.position, supplementId, card.reason),
      );
    }
  }
  for (const chunk of chunks(statements, BATCH_SIZE)) await db.batch(chunk);
}

const COLUMNS = [
  'slug', 'name', 'name_key', 'category', 'form_type', 'fda_status', 'safety_status', 'effectivity', 'safety', 'summary',
  'benefits_html', 'contraindications_html', 'enhancing_html', 'interactions_html', 'why_consider', 'holistic_html',
  'studies_html', 'products_json', 'source', 'faq_json',
];
// Existing rows are refreshed by name or by slug; slugs are never rewritten (old links must keep working).
// Text fields that are empty in the bundle keep whatever the database already holds (for example articles the
// site wrote itself with the content backfill).
const KEEP_IF_BUNDLE_EMPTY = new Set([
  'summary', 'benefits_html', 'contraindications_html', 'enhancing_html', 'interactions_html', 'why_consider',
  'holistic_html', 'studies_html', 'faq_json',
]);
const assignment = (c: string) => {
  if (KEEP_IF_BUNDLE_EMPTY.has(c)) return `${c} = CASE WHEN excluded.${c} != '' THEN excluded.${c} ELSE supplements.${c} END`;
  if (c === 'products_json') return `${c} = CASE WHEN excluded.${c} NOT IN ('', '[]') THEN excluded.${c} ELSE supplements.${c} END`;
  return `${c} = excluded.${c}`;
};
// A refreshed row is stamped updated_at only when a field really changes, so sitemap dates stay honest.
const changed = (c: string) => {
  if (KEEP_IF_BUNDLE_EMPTY.has(c)) return `(excluded.${c} != '' AND excluded.${c} IS NOT supplements.${c})`;
  if (c === 'products_json') return `(excluded.${c} NOT IN ('', '[]') AND excluded.${c} IS NOT supplements.${c})`;
  return `excluded.${c} IS NOT supplements.${c}`;
};
const stamp = (skip: string[]) =>
  `updated_at = CASE WHEN ${COLUMNS.filter((c) => !skip.includes(c)).map(changed).join(' OR ')} THEN datetime('now') ELSE supplements.updated_at END`;
const UPDATE_BY_NAME = [...COLUMNS.filter((c) => c !== 'name_key' && c !== 'slug').map(assignment), stamp(['name_key', 'slug', 'source'])].join(', ');
const UPDATE_BY_SLUG = [...COLUMNS.filter((c) => c !== 'slug').map(assignment), stamp(['slug', 'source'])].join(', ');
const UPSERT_SQL =
  `INSERT INTO supplements (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ` +
  `ON CONFLICT(name_key) DO UPDATE SET ${UPDATE_BY_NAME} ON CONFLICT(slug) DO UPDATE SET ${UPDATE_BY_SLUG}`;

function upsertSupplement(db: D1Database, s: BundledSupplement): D1PreparedStatement {
  return db
    .prepare(UPSERT_SQL)
    .bind(
      s.slug,
      s.name,
      normalizeNameKey(s.name),
      s.category || 'Other',
      asFormType(s.form_type),
      asFdaStatus(s.fda_status),
      asSafetyStatus(s.safety_status),
      clampRating(s.effectivity),
      clampRating(s.safety),
      s.summary ?? '',
      s.benefits_html ?? '',
      s.contraindications_html ?? '',
      s.enhancing_html ?? '',
      s.interactions_html ?? '',
      s.why_consider ?? '',
      s.holistic_html ?? '',
      s.studies_html ?? '',
      JSON.stringify(s.products ?? []),
      'cms',
      s.faqs?.length ? JSON.stringify(s.faqs) : '',
    );
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
