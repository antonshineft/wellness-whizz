/** D1 data access. The three tables replace the Webflow CMS collections and the Make.com state. */

export type FormType = 'capsule' | 'softgel' | 'small_softgel' | 'tablet' | 'powder' | 'gummy' | 'bar' | 'drops';
export type FdaStatus = 'approved' | 'probably_ok' | 'not_approved';
export type SafetyStatus = 'safe' | 'ok' | 'not_safe' | 'prescription';
export type SessionStatus = 'pending' | 'ready' | 'failed';
export type SupplementSource = 'cms' | 'ai';

/** One entry of the "Common Questions" block on a supplement page (written from the phrases people search for). */
export interface Faq {
  q: string;
  a: string;
}

export const FORM_TYPES: readonly FormType[] = ['capsule', 'softgel', 'small_softgel', 'tablet', 'powder', 'gummy', 'bar', 'drops'];
export const FDA_STATUSES: readonly FdaStatus[] = ['approved', 'probably_ok', 'not_approved'];
export const SAFETY_STATUSES: readonly SafetyStatus[] = ['safe', 'ok', 'not_safe', 'prescription'];
export const CATEGORIES: readonly string[] = [
  'Vitamin', 'Mineral', 'Fatty Acid', 'Amino Acid', 'Protein', 'Probiotic', 'Herbal', 'Adaptogen',
  'Antioxidant', 'Enzyme', 'Fiber', 'Other',
];

export interface Product {
  name: string;
  brand: string;
  url: string;
  /** Optional product image URL (imported from the Webflow CMS, or copied from iHerb into D1). */
  image?: string;
  /** The photo still has iHerb's white background (blend it into the tile). */
  opaque?: boolean;
}

export interface Supplement {
  id: number;
  slug: string;
  name: string;
  category: string;
  form_type: FormType;
  fda_status: FdaStatus;
  safety_status: SafetyStatus;
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
  /** Questions and answers shown under "Common Questions"; empty until the FAQ writer has run for this page. */
  faqs: Faq[];
  source: SupplementSource;
  /** Generated illustration path (supplements without product photos), empty otherwise. */
  image: string;
  created_at: string;
}

export type SupplementInput = Omit<Supplement, 'id' | 'slug' | 'created_at' | 'source' | 'image' | 'faqs'>;

export interface QuizProfile {
  sex: string;
  age: string;
  activity: string;
  diet: string;
  goal: string;
}

export interface Session extends QuizProfile {
  id: string;
  status: SessionStatus;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ResultItem {
  position: number;
  reason: string;
  supplement: Supplement;
}

type SupplementRow = Omit<Supplement, 'products' | 'faqs'> & { products_json: string; faq_json: string | null; name_key: string };

// ---------- helpers ----------

export function normalizeNameKey(name: string): string {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Looser identity than name_key: word order, plurals and filler words are ignored, so "Vitamin B Complex" and
 * "B Vitamins" share one alias key while "Vitamin C" and "Vitamin E" do not.
 */
const ALIAS_FILLER = new Set(['complex', 'supplement', 'supplements', 'formula', 'blend', 'the', 'of', 'and', 'with']);
export function aliasKey(name: string): string {
  const words = normalizeNameKey(name)
    .split(' ')
    .filter((w) => w && !ALIAS_FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(' ');
}

export function slugify(name: string): string {
  return normalizeNameKey(name).replace(/\s+/g, '-').slice(0, 80).replace(/-+$/g, '');
}

export function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 5);
}

export function clampRating(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 3;
  return Math.min(5, Math.max(1, v));
}

export function asFormType(v: unknown): FormType {
  return (FORM_TYPES as readonly string[]).includes(String(v)) ? (v as FormType) : 'capsule';
}
export function asFdaStatus(v: unknown): FdaStatus {
  return (FDA_STATUSES as readonly string[]).includes(String(v)) ? (v as FdaStatus) : 'probably_ok';
}
export function asSafetyStatus(v: unknown): SafetyStatus {
  return (SAFETY_STATUSES as readonly string[]).includes(String(v)) ? (v as SafetyStatus) : 'safe';
}

export function parseProducts(json: string | null | undefined): Product[] {
  try {
    const parsed = JSON.parse(json || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
      .map((p) => ({
        name: String(p.name),
        brand: String(p.brand ?? ''),
        url: String(p.url ?? ''),
        ...(p.image ? { image: String(p.image) } : {}),
        ...(p.opaque ? { opaque: true } : {}),
      }));
  } catch {
    return [];
  }
}

export function parseFaqs(json: string | null | undefined): Faq[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((f) => ({ q: String(f?.q ?? '').trim(), a: String(f?.a ?? '').trim() }))
      .filter((f) => f.q && f.a);
  } catch {
    return [];
  }
}

function rowToSupplement(row: SupplementRow): Supplement {
  const { products_json, faq_json, name_key: _nameKey, ...rest } = row;
  return {
    ...rest,
    faqs: parseFaqs(faq_json),
    form_type: asFormType(rest.form_type),
    fda_status: asFdaStatus(rest.fda_status),
    safety_status: asSafetyStatus(rest.safety_status),
    effectivity: clampRating(rest.effectivity),
    safety: clampRating(rest.safety),
    products: parseProducts(products_json),
    source: rest.source === 'ai' ? 'ai' : 'cms',
    image: rest.image ?? '',
  };
}

const SUPPLEMENT_COLUMNS =
  'id, slug, name, name_key, category, form_type, fda_status, safety_status, effectivity, safety, summary, ' +
  'benefits_html, contraindications_html, enhancing_html, interactions_html, why_consider, holistic_html, ' +
  'studies_html, products_json, source, image, faq_json, created_at';

// ---------- supplements ----------

/** @param curatedOnly leave out supplements the AI pipeline created (LIST_AI_SUPPLEMENTS=false). */
export async function listSupplements(db: D1Database, limit = 200, curatedOnly = false): Promise<Supplement[]> {
  const where = curatedOnly ? "WHERE source != 'ai'" : '';
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements ${where} ORDER BY name COLLATE NOCASE LIMIT ?`)
    .bind(limit)
    .all<SupplementRow>();
  return results.map(rowToSupplement);
}

export async function listSupplementNames(db: D1Database, limit = 300): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT name FROM supplements ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function randomSupplements(db: D1Database, n: number, curatedOnly = false): Promise<Supplement[]> {
  const where = curatedOnly ? "WHERE source != 'ai'" : '';
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements ${where} ORDER BY RANDOM() LIMIT ?`)
    .bind(n)
    .all<SupplementRow>();
  return results.map(rowToSupplement);
}

export async function getSupplementBySlug(db: D1Database, slug: string): Promise<Supplement | null> {
  const row = await db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE slug = ?`).bind(slug).first<SupplementRow>();
  return row ? rowToSupplement(row) : null;
}

const WEBFLOW_SUFFIX = /-[0-9a-f]{5}$/;

/**
 * Webflow slugs carry a random 5-hex suffix ("zinc-fe1df"). Resolve "zinc" to "zinc-fe1df" when exactly one such
 * row exists, and "zinc-fe1df" to a plain "zinc" row. Anything else is not guessed.
 */
export async function resolveSupplementSlug(db: D1Database, requested: string): Promise<string | null> {
  const clean = requested.toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(clean)) return null;
  const { results } = await db
    .prepare('SELECT slug FROM supplements WHERE slug GLOB ? LIMIT 2')
    .bind(`${clean}-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]`)
    .all<{ slug: string }>();
  if (results.length === 1) return results[0].slug;
  if (WEBFLOW_SUFFIX.test(clean)) {
    const bare = clean.replace(WEBFLOW_SUFFIX, '');
    const row = await db.prepare('SELECT slug FROM supplements WHERE slug = ?').bind(bare).first<{ slug: string }>();
    if (row) return row.slug;
  }
  return null;
}

export async function getSupplementsBySlugs(db: D1Database, slugs: string[]): Promise<Map<string, Supplement>> {
  const map = new Map<string, Supplement>();
  const unique = [...new Set(slugs.filter(Boolean))];
  if (!unique.length) return map;
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE slug IN (${unique.map(() => '?').join(',')})`)
    .bind(...unique)
    .all<SupplementRow>();
  for (const row of results) map.set(row.slug, rowToSupplement(row));
  return map;
}

export async function countSupplements(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM supplements').first<{ n: number }>();
  return row?.n ?? 0;
}

/** Slugs and creation dates of the whole catalogue (sitemap). */
export async function listSupplementSlugs(db: D1Database, curatedOnly = false): Promise<{ slug: string; created_at: string }[]> {
  const { results } = await db
    .prepare(`SELECT slug, created_at FROM supplements${curatedOnly ? " WHERE source = 'cms'" : ''} ORDER BY name`)
    .all<{ slug: string; created_at: string }>();
  return results;
}

export async function getSupplementByNameKey(db: D1Database, key: string): Promise<Supplement | null> {
  const row = await db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE name_key = ?`).bind(key).first<SupplementRow>();
  return row ? rowToSupplement(row) : null;
}

/** Find an existing supplement whose alias key matches the name (see aliasKey). Curated rows win over AI rows. */
export async function findSupplementByAlias(db: D1Database, name: string): Promise<Supplement | null> {
  const wanted = aliasKey(name);
  if (!wanted) return null;
  const { results } = await db
    .prepare("SELECT id, name, source FROM supplements ORDER BY source = 'cms' DESC, id")
    .all<{ id: number; name: string; source: string }>();
  const hit = results.find((r) => aliasKey(r.name) === wanted);
  if (!hit) return null;
  const row = await db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE id = ?`).bind(hit.id).first<SupplementRow>();
  return row ? rowToSupplement(row) : null;
}

/**
 * Merge AI-created supplements that duplicate a curated one under another name ("Vitamin B Complex" next to
 * "B Vitamins"): past results are re-pointed to the curated row and the duplicate is deleted.
 */
export async function mergeDuplicateSupplements(db: D1Database): Promise<{ merged: string[] }> {
  const { results } = await db
    .prepare('SELECT id, slug, name, source FROM supplements ORDER BY id')
    .all<{ id: number; slug: string; name: string; source: string }>();
  const curated = new Map<string, { id: number; slug: string }>();
  for (const r of results) if (r.source !== 'ai' && !curated.has(aliasKey(r.name))) curated.set(aliasKey(r.name), r);
  const merged: string[] = [];
  for (const r of results) {
    if (r.source !== 'ai') continue;
    const target = curated.get(aliasKey(r.name));
    if (!target || target.id === r.id) continue;
    await db.batch([
      db.prepare('UPDATE OR IGNORE session_supplements SET supplement_id = ? WHERE supplement_id = ?').bind(target.id, r.id),
      db.prepare('DELETE FROM session_supplements WHERE supplement_id = ?').bind(r.id),
      db.prepare('DELETE FROM supplements WHERE id = ?').bind(r.id),
    ]);
    merged.push(`${r.slug} -> ${target.slug}`);
  }
  return { merged };
}

export async function getSupplementsByNameKeys(db: D1Database, keys: string[]): Promise<Map<string, Supplement>> {
  const map = new Map<string, Supplement>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return map;
  const placeholders = unique.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE name_key IN (${placeholders})`)
    .bind(...unique)
    .all<SupplementRow>();
  for (const row of results) map.set(row.name_key, rowToSupplement(row));
  return map;
}

/** Insert a supplement. Safe to call concurrently: if the name already exists, the existing row is returned. */
export async function insertSupplement(db: D1Database, input: SupplementInput, source: SupplementSource = 'cms'): Promise<Supplement> {
  const nameKey = normalizeNameKey(input.name);
  if (!nameKey) throw new Error('Supplement name is empty');
  const existing = await getSupplementByNameKey(db, nameKey);
  if (existing) return existing;

  let slug = slugify(input.name) || 'supplement';
  const taken = await db.prepare('SELECT 1 AS x FROM supplements WHERE slug = ?').bind(slug).first();
  if (taken) slug = `${slug}-${shortHash(nameKey + Date.now())}`;

  try {
    await db
      .prepare(
        `INSERT INTO supplements (slug, name, name_key, category, form_type, fda_status, safety_status, effectivity, safety,
           summary, benefits_html, contraindications_html, enhancing_html, interactions_html, why_consider, holistic_html,
           studies_html, products_json, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        slug,
        input.name.trim(),
        nameKey,
        input.category,
        asFormType(input.form_type),
        asFdaStatus(input.fda_status),
        asSafetyStatus(input.safety_status),
        clampRating(input.effectivity),
        clampRating(input.safety),
        input.summary,
        input.benefits_html,
        input.contraindications_html,
        input.enhancing_html,
        input.interactions_html,
        input.why_consider,
        input.holistic_html,
        input.studies_html,
        JSON.stringify(input.products ?? []),
        source,
      )
      .run();
  } catch (err) {
    // Lost a race with a parallel insert of the same supplement: reuse that row.
    const again = await getSupplementByNameKey(db, nameKey);
    if (again) return again;
    throw err;
  }
  const created = await getSupplementByNameKey(db, nameKey);
  if (!created) throw new Error('Supplement insert did not persist');
  return created;
}

// ---------- sessions ----------

/** Returns false when a session with this id already exists (duplicate submit). */
export async function createSession(db: D1Database, id: string, profile: QuizProfile, ipHash: string | null): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO sessions (id, sex, age, activity, diet, goal, status, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, profile.sex, profile.age, profile.activity, profile.diet, profile.goal, 'pending', ipHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getSession(db: D1Database, id: string): Promise<Session | null> {
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<Session>();
  return row ?? null;
}

export async function markSession(db: D1Database, id: string, status: SessionStatus, error: string | null = null): Promise<void> {
  await db
    .prepare("UPDATE sessions SET status = ?, error = ?, completed_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END WHERE id = ?")
    .bind(status, error, status, id)
    .run();
}

export async function saveSessionResults(
  db: D1Database,
  sessionId: string,
  items: { supplementId: number; reason: string }[],
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM session_supplements WHERE session_id = ?').bind(sessionId),
    ...items.map((item, i) =>
      db
        .prepare('INSERT INTO session_supplements (session_id, position, supplement_id, reason) VALUES (?, ?, ?, ?)')
        .bind(sessionId, i + 1, item.supplementId, item.reason),
    ),
    db.prepare("UPDATE sessions SET status = 'ready', error = NULL, completed_at = datetime('now') WHERE id = ?").bind(sessionId),
  ];
  await db.batch(statements);
}

export async function getSessionResults(db: D1Database, sessionId: string): Promise<ResultItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ss.position, ss.reason, s.id, s.slug, s.name, s.name_key, s.category, s.form_type, s.fda_status, s.safety_status,
              s.effectivity, s.safety, s.summary, s.benefits_html, s.contraindications_html, s.enhancing_html,
              s.interactions_html, s.why_consider, s.holistic_html, s.studies_html, s.products_json, s.source, s.image, s.created_at
       FROM session_supplements ss JOIN supplements s ON s.id = ss.supplement_id
       WHERE ss.session_id = ? ORDER BY ss.position`,
    )
    .bind(sessionId)
    .all<SupplementRow & { position: number; reason: string }>();
  return results.map((row) => {
    const { position, reason, ...rest } = row;
    return { position, reason, supplement: rowToSupplement(rest as SupplementRow) };
  });
}

/** Sessions started in the last `hours` hours, for one IP hash or (null) for everyone. */
// ---------- content backfill ----------

/** Supplements whose Holistic Highlights article is missing or short, or whose studies list is empty. */
export async function supplementsNeedingContent(db: D1Database, minArticleLength: number, limit: number): Promise<Supplement[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SUPPLEMENT_COLUMNS} FROM supplements
       WHERE length(holistic_html) < ? OR studies_html = ''
       ORDER BY source = 'ai' DESC, created_at DESC LIMIT ?`,
    )
    .bind(minArticleLength, limit)
    .all<SupplementRow>();
  return results.map(rowToSupplement);
}

export async function countSupplementsNeedingContent(db: D1Database, minArticleLength: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM supplements WHERE length(holistic_html) < ? OR studies_html = ''`)
    .bind(minArticleLength)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateSupplementContent(
  db: D1Database,
  id: number,
  content: { holistic_html?: string; studies_html?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE supplements SET
         holistic_html = CASE WHEN ? != '' THEN ? ELSE holistic_html END,
         studies_html = CASE WHEN studies_html = '' AND ? != '' THEN ? ELSE studies_html END
       WHERE id = ?`,
    )
    .bind(content.holistic_html ?? '', content.holistic_html ?? '', content.studies_html ?? '', content.studies_html ?? '', id)
    .run();
}

// ---------- FAQ backfill ----------

/** Supplements whose "Common Questions" block has not been written yet (curated catalogue first). */
export async function supplementsNeedingFaqs(db: D1Database, limit: number): Promise<Supplement[]> {
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE faq_json = '' ORDER BY source = 'cms' DESC, id LIMIT ?`)
    .bind(limit)
    .all<SupplementRow>();
  return results.map(rowToSupplement);
}

export async function countSupplementsNeedingFaqs(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM supplements WHERE faq_json = ''`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateSupplementFaqs(db: D1Database, id: number, faqs: Faq[]): Promise<void> {
  await db.prepare('UPDATE supplements SET faq_json = ? WHERE id = ?').bind(JSON.stringify(faqs), id).run();
}

/** Everything in the catalogue, for exporting back into data/supplements.json. */
export async function exportSupplements(db: D1Database): Promise<Supplement[]> {
  const { results } = await db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements ORDER BY id`).all<SupplementRow>();
  return results.map(rowToSupplement);
}

// ---------- events (measurement) ----------

export type EventType = 'home_view' | 'quiz_view' | 'result_view' | 'supplement_view' | 'page_view' | 'outbound_click' | 'subscribe' | 'share';
export const EVENT_TYPES: readonly EventType[] = ['home_view', 'quiz_view', 'result_view', 'supplement_view', 'page_view', 'outbound_click', 'subscribe', 'share'];

export interface EventInput {
  type: EventType;
  slug?: string | null;
  product?: string | null;
  page?: string | null;
  referrer?: string | null;
  target?: string | null;
  session_id?: string | null;
  ip_hash?: string | null;
}

export async function logEvent(db: D1Database, e: EventInput): Promise<void> {
  await db
    .prepare('INSERT INTO events (type, slug, product, page, referrer, target, session_id, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(e.type, e.slug ?? null, e.product ?? null, e.page ?? null, e.referrer ?? null, e.target ?? null, e.session_id ?? null, e.ip_hash ?? null)
    .run();
}

export interface Stats {
  generated_at: string;
  funnel: Record<string, { last_7_days: number; last_30_days: number }>;
  quizzes: { last_7_days: number; last_30_days: number; completed_30_days: number; failed_30_days: number };
  top_supplements_30_days: { slug: string; clicks: number }[];
  top_products_30_days: { slug: string; product: string; clicks: number }[];
  referrers_30_days: { referrer: string; views: number }[];
}

/** Funnel numbers for the last 7 and 30 days. */
export async function statsSummary(db: D1Database): Promise<Stats> {
  const [byType, quizzes, topSupplements, topProducts, referrers] = await Promise.all([
    db
      .prepare(
        `SELECT type, SUM(ts >= datetime('now', '-7 days')) AS d7, COUNT(*) AS d30
         FROM events WHERE ts >= datetime('now', '-30 days') GROUP BY type`,
      )
      .all<{ type: string; d7: number; d30: number }>(),
    db
      .prepare(
        `SELECT SUM(created_at >= datetime('now', '-7 days')) AS d7, COUNT(*) AS d30,
                SUM(status = 'ready') AS ready, SUM(status = 'failed') AS failed
         FROM sessions WHERE created_at >= datetime('now', '-30 days') AND sex != ''`,
      )
      .first<{ d7: number; d30: number; ready: number; failed: number }>(),
    db
      .prepare(
        `SELECT slug, COUNT(*) AS clicks FROM events
         WHERE type = 'outbound_click' AND ts >= datetime('now', '-30 days') AND slug IS NOT NULL
         GROUP BY slug ORDER BY clicks DESC LIMIT 20`,
      )
      .all<{ slug: string; clicks: number }>(),
    db
      .prepare(
        `SELECT slug, product, COUNT(*) AS clicks FROM events
         WHERE type = 'outbound_click' AND ts >= datetime('now', '-30 days') AND product IS NOT NULL
         GROUP BY slug, product ORDER BY clicks DESC LIMIT 20`,
      )
      .all<{ slug: string; product: string; clicks: number }>(),
    db
      .prepare(
        `SELECT referrer, COUNT(*) AS views FROM events
         WHERE referrer IS NOT NULL AND ts >= datetime('now', '-30 days')
         GROUP BY referrer ORDER BY views DESC LIMIT 20`,
      )
      .all<{ referrer: string; views: number }>(),
  ]);
  const funnel: Stats['funnel'] = {};
  for (const type of EVENT_TYPES) funnel[type] = { last_7_days: 0, last_30_days: 0 };
  for (const row of byType.results) funnel[row.type] = { last_7_days: Number(row.d7 ?? 0), last_30_days: Number(row.d30 ?? 0) };
  return {
    generated_at: new Date().toISOString(),
    funnel,
    quizzes: {
      last_7_days: Number(quizzes?.d7 ?? 0),
      last_30_days: Number(quizzes?.d30 ?? 0),
      completed_30_days: Number(quizzes?.ready ?? 0),
      failed_30_days: Number(quizzes?.failed ?? 0),
    },
    top_supplements_30_days: topSupplements.results,
    top_products_30_days: topProducts.results,
    referrers_30_days: referrers.results,
  };
}

export interface WeeklyNumbers {
  /** The week covered: [from, to) as ISO dates, and the week before it for comparison. */
  from: string;
  to: string;
  events: Record<EventType, { this_week: number; last_week: number }>;
  quizzes: { this_week: number; last_week: number; completed_this_week: number; failed_this_week: number };
  subscribers: { this_week: number; last_week: number; total: number };
  top_clicked: { slug: string; name: string; clicks: number }[];
  top_products: { slug: string; product: string; clicks: number }[];
  top_viewed: { slug: string; name: string; views: number }[];
  referrers: { referrer: string; views: number }[];
  social: { posted_this_week: number; failed_this_week: number; queued: number };
  research: { notes: number; notes_this_week: number };
}

/** "blog:magnesium-glycinate-vs-citrate" (an article's buy button) reads as "Article: Magnesium glycinate vs citrate". */
function readableRef(ref: string): string {
  const m = /^blog:(.+)$/.exec(ref);
  if (!m) return ref;
  const words = m[1].replace(/-/g, ' ');
  return `Article: ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The last seven days against the seven before them (the Monday report email, src/report.ts). */
export async function weeklyNumbers(db: D1Database): Promise<WeeklyNumbers> {
  const [byType, quizzes, subs, topClicked, topProducts, topViewed, referrers, social, research] = await Promise.all([
    db
      .prepare(
        `SELECT type, SUM(ts >= datetime('now', '-7 days')) AS w1, SUM(ts < datetime('now', '-7 days')) AS w0
         FROM events WHERE ts >= datetime('now', '-14 days') GROUP BY type`,
      )
      .all<{ type: string; w1: number; w0: number }>(),
    db
      .prepare(
        `SELECT SUM(created_at >= datetime('now', '-7 days')) AS w1, SUM(created_at < datetime('now', '-7 days')) AS w0,
                SUM(created_at >= datetime('now', '-7 days') AND status = 'ready') AS ready,
                SUM(created_at >= datetime('now', '-7 days') AND status = 'failed') AS failed
         FROM sessions WHERE created_at >= datetime('now', '-14 days') AND sex != ''`,
      )
      .first<{ w1: number; w0: number; ready: number; failed: number }>(),
    db
      .prepare(
        `SELECT SUM(created_at >= datetime('now', '-7 days')) AS w1,
                SUM(created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')) AS w0,
                SUM(unsubscribed_at IS NULL) AS total
         FROM subscribers`,
      )
      .first<{ w1: number; w0: number; total: number }>(),
    db
      .prepare(
        `SELECT e.slug, COALESCE(s.name, e.slug) AS name, COUNT(*) AS clicks FROM events e LEFT JOIN supplements s ON s.slug = e.slug
         WHERE e.type = 'outbound_click' AND e.ts >= datetime('now', '-7 days') AND e.slug IS NOT NULL
         GROUP BY e.slug ORDER BY clicks DESC LIMIT 8`,
      )
      .all<{ slug: string; name: string; clicks: number }>(),
    db
      .prepare(
        `SELECT slug, product, COUNT(*) AS clicks FROM events
         WHERE type = 'outbound_click' AND ts >= datetime('now', '-7 days') AND product IS NOT NULL
         GROUP BY slug, product ORDER BY clicks DESC LIMIT 8`,
      )
      .all<{ slug: string; product: string; clicks: number }>(),
    db
      .prepare(
        `SELECT e.slug, COALESCE(s.name, e.slug) AS name, COUNT(*) AS views FROM events e LEFT JOIN supplements s ON s.slug = e.slug
         WHERE e.type = 'supplement_view' AND e.ts >= datetime('now', '-7 days') AND e.slug IS NOT NULL
         GROUP BY e.slug ORDER BY views DESC LIMIT 8`,
      )
      .all<{ slug: string; name: string; views: number }>(),
    db
      .prepare(
        `SELECT referrer, COUNT(*) AS views FROM events
         WHERE referrer IS NOT NULL AND ts >= datetime('now', '-7 days')
         GROUP BY referrer ORDER BY views DESC LIMIT 8`,
      )
      .all<{ referrer: string; views: number }>(),
    db
      .prepare(
        `SELECT SUM(status = 'posted' AND posted_at >= datetime('now', '-7 days')) AS posted,
                SUM(status = 'failed' AND created_at >= datetime('now', '-7 days')) AS failed,
                SUM(status = 'queued') AS queued
         FROM social_posts`,
      )
      .first<{ posted: number; failed: number; queued: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS notes, SUM(created_at >= datetime('now', '-7 days')) AS fresh FROM research_notes WHERE summary != ''`)
      .first<{ notes: number; fresh: number }>(),
  ]);
  const events = {} as WeeklyNumbers['events'];
  for (const type of EVENT_TYPES) events[type] = { this_week: 0, last_week: 0 };
  for (const row of byType.results) if ((EVENT_TYPES as readonly string[]).includes(row.type)) events[row.type as EventType] = { this_week: Number(row.w1 ?? 0), last_week: Number(row.w0 ?? 0) };
  const day = 24 * 60 * 60 * 1000;
  const to = new Date();
  return {
    from: new Date(to.getTime() - 7 * day).toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    events,
    quizzes: {
      this_week: Number(quizzes?.w1 ?? 0),
      last_week: Number(quizzes?.w0 ?? 0),
      completed_this_week: Number(quizzes?.ready ?? 0),
      failed_this_week: Number(quizzes?.failed ?? 0),
    },
    subscribers: { this_week: Number(subs?.w1 ?? 0), last_week: Number(subs?.w0 ?? 0), total: Number(subs?.total ?? 0) },
    top_clicked: topClicked.results.map((r) => ({ ...r, name: readableRef(r.name) })),
    top_products: topProducts.results,
    top_viewed: topViewed.results,
    referrers: referrers.results,
    social: { posted_this_week: Number(social?.posted ?? 0), failed_this_week: Number(social?.failed ?? 0), queued: Number(social?.queued ?? 0) },
    research: { notes: Number(research?.notes ?? 0), notes_this_week: Number(research?.fresh ?? 0) },
  };
}

// ---------- related supplements, subscribers, content progress ----------

/** Supplements of the same category (random order), falling back to random ones; never the supplement itself. */
export async function relatedSupplements(db: D1Database, sup: Supplement, n = 4, curatedOnly = false): Promise<Supplement[]> {
  const curated = curatedOnly ? " AND source = 'cms'" : '';
  const { results } = await db
    .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE id != ? AND category = ?${curated} ORDER BY RANDOM() LIMIT ?`)
    .bind(sup.id, sup.category, n)
    .all<SupplementRow>();
  const related = results.map(rowToSupplement);
  if (related.length < n) {
    const ids = [sup.id, ...related.map((r) => r.id)];
    const { results: more } = await db
      .prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE id NOT IN (${ids.map(() => '?').join(',')})${curated} ORDER BY RANDOM() LIMIT ?`)
      .bind(...ids, n - related.length)
      .all<SupplementRow>();
    related.push(...more.map(rowToSupplement));
  }
  return related;
}

export interface SubscriberInput {
  email: string;
  source: 'results' | 'newsletter';
  session_id?: string | null;
  ip_hash?: string | null;
}

/** Store an email address; an existing address keeps its row (the session id is updated when given). */
export async function addSubscriber(db: D1Database, input: SubscriberInput): Promise<{ created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.prepare('SELECT id FROM subscribers WHERE email = ?').bind(email).first<{ id: number }>();
  if (existing) {
    await db
      .prepare('UPDATE subscribers SET session_id = COALESCE(?, session_id), unsubscribed_at = NULL WHERE id = ?')
      .bind(input.session_id ?? null, existing.id)
      .run();
    return { created: false };
  }
  await db
    .prepare('INSERT INTO subscribers (email, source, session_id, ip_hash) VALUES (?, ?, ?, ?)')
    .bind(email, input.source, input.session_id ?? null, input.ip_hash ?? null)
    .run();
  return { created: true };
}

export async function markSubscriberSent(db: D1Database, email: string): Promise<void> {
  await db.prepare("UPDATE subscribers SET last_sent_at = datetime('now') WHERE email = ?").bind(email.trim().toLowerCase()).run();
}

export async function countRecentSubscriptions(db: D1Database, ipHash: string | null, hours = 1): Promise<number> {
  if (!ipHash) return 0;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at >= datetime('now', ?)`)
    .bind(ipHash, `-${hours} hours`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface SubscriberRow {
  email: string;
  source: string;
  session_id: string | null;
  created_at: string;
  last_sent_at: string | null;
  unsubscribed_at: string | null;
}

export async function listSubscribers(db: D1Database): Promise<SubscriberRow[]> {
  const { results } = await db
    .prepare('SELECT email, source, session_id, created_at, last_sent_at, unsubscribed_at FROM subscribers ORDER BY created_at DESC')
    .all<SubscriberRow>();
  return results;
}

export interface ContentProgress {
  supplements: number;
  with_article: number;
  with_studies: number;
  with_faqs: number;
  without_product_photos: number;
  subscribers: number;
}

/** How far the background writers have got (shown on /api/stats). */
export async function contentProgress(db: D1Database, minArticleLength: number): Promise<ContentProgress> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS supplements,
              SUM(CASE WHEN length(holistic_html) >= ? THEN 1 ELSE 0 END) AS with_article,
              SUM(CASE WHEN studies_html != '' THEN 1 ELSE 0 END) AS with_studies,
              SUM(CASE WHEN faq_json != '' THEN 1 ELSE 0 END) AS with_faqs,
              SUM(CASE WHEN products_json NOT LIKE '%"image":%' THEN 1 ELSE 0 END) AS without_product_photos
       FROM supplements`,
    )
    .bind(minArticleLength)
    .first<{ supplements: number; with_article: number; with_studies: number; with_faqs: number; without_product_photos: number }>();
  const subs = await db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NULL').first<{ n: number }>();
  return {
    supplements: Number(row?.supplements ?? 0),
    with_article: Number(row?.with_article ?? 0),
    with_studies: Number(row?.with_studies ?? 0),
    with_faqs: Number(row?.with_faqs ?? 0),
    without_product_photos: Number(row?.without_product_photos ?? 0),
    subscribers: Number(subs?.n ?? 0),
  };
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function countRecentSessions(db: D1Database, ipHash: string | null, hours = 1): Promise<number> {
  const row = ipHash
    ? await db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ip_hash = ? AND created_at >= datetime('now', ?)`)
        .bind(ipHash, `-${hours} hours`)
        .first<{ n: number }>()
    : await db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE created_at >= datetime('now', ?)`)
        .bind(`-${hours} hours`)
        .first<{ n: number }>();
  return row?.n ?? 0;
}
