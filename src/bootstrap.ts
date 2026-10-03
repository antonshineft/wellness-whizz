/**
 * Self-installing database.
 *
 * On the first request of a fresh deployment the Worker creates its tables (same SQL as migrations/0001_init.sql)
 * and, when the supplements table is empty, loads the content bundled in data/*.json (built from the Webflow CMS
 * exports by scripts/build-data.mjs). This is what lets the "Deploy to Cloudflare" button produce a working site
 * without any manual database steps. Everything here is idempotent and cheap after the first run.
 */
import schemaSql from '../migrations/0001_init.sql';
import supplementsJson from '../data/supplements.json';
import resultsJson from '../data/results.json';
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
}

interface BundledSession {
  id: string;
  created_at: string;
  cards: { position: number; slug: string; reason: string }[];
}

const BATCH_SIZE = 100;
let ready: Promise<void> | null = null;

/** Make sure schema and bundled content exist. Safe to call on every request; runs once per isolate. */
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
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('supplements', 'sessions', 'session_supplements')")
    .all<{ name: string }>();
  if (tables.results.length < 3) {
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

  const count = await db.prepare('SELECT COUNT(*) AS n FROM supplements').first<{ n: number }>();
  if ((count?.n ?? 0) > 0) return;

  const supplements = supplementsJson as BundledSupplement[];
  const sessions = resultsJson as BundledSession[];
  if (!supplements.length) return;

  for (const chunk of chunks(supplements, BATCH_SIZE)) {
    await db.batch(chunk.map((s) => supplementStatement(db, s)));
  }
  console.log(`bootstrap: loaded ${supplements.length} supplements`);

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
  console.log(`bootstrap: loaded ${sessions.length} past result sessions`);
}

function supplementStatement(db: D1Database, s: BundledSupplement): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO supplements (slug, name, name_key, category, form_type, fda_status, safety_status, effectivity, safety,
         summary, benefits_html, contraindications_html, enhancing_html, interactions_html, why_consider, holistic_html,
         studies_html, products_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cms')`,
    )
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
    );
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
