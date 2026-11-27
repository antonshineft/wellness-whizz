/**
 * FDA recall records for the brands we profile (src/brands-data.ts), shown on the brand pages and posted on X.
 *
 * Source: openFDA's food enforcement feed (https://api.fda.gov/food/enforcement.json), which is public-domain data.
 *
 * A wrong match would say a company recalled something it did not, so matching is strict and written out by hand:
 *  - `own`: names the FDA uses for the brand's own company. A record from such a firm counts as the brand's.
 *  - `parent`: a parent or maker that also sells other brands. Its record counts only when the product text names
 *    this brand.
 * A firm that merely shares words with a brand ("21st Century Snack Foods", "Nature's Way Purewater Systems") matches
 * neither list. Brands with no entry here, or no record, show a plain "none on record" line.
 *
 * The weekly sync stores each record once. Records that are new AND recent get one post on X; the first run stores
 * the back catalogue without posting anything.
 */
import { getMeta, setMeta } from './db';
import { enqueue, siteOrigin, type SocialEnv } from './social/content';

interface Matcher { own: string[]; parent: string[]; names: string[] }

const MATCHERS: Record<string, Matcher> = {
  '21st-century': { own: ['21st Century Healthcare', 'Twenty-First Century Healthcare'], parent: [], names: ['21st Century'] },
  'california-gold-nutrition': { own: [], parent: ['iHerb'], names: ['California Gold Nutrition'] },
  'doctors-best': { own: ["Doctor's Best Inc", 'Doctors Best Inc'], parent: [], names: ["Doctor's Best"] },
  'force-factor': { own: ['Force Factor'], parent: [], names: ['Force Factor'] },
  'jarrow-formulas': { own: ['Jarrow Formulas'], parent: [], names: ['Jarrow'] },
  'life-extension': { own: ['Life Extension'], parent: ['Quality Supplements and Vitamins'], names: ['Life Extension'] },
  'natural-factors': { own: ['Natural Factors'], parent: ['Factors Group'], names: ['Natural Factors'] },
  'natures-way': { own: ["Nature's Way Products", "Nature's Way Brands"], parent: ['Schwabe North America'], names: ["Nature's Way"] },
  'now-foods': { own: ['NOW Foods', 'NOW Health Group'], parent: [], names: ['NOW'] },
  nutricost: { own: ['Nutricost'], parent: ['eSupplements'], names: ['Nutricost'] },
  'optimum-nutrition': { own: ['Optimum Nutrition'], parent: ['Glanbia Performance Nutrition'], names: ['Optimum Nutrition'] },
  solaray: { own: ['Solaray'], parent: ['Nutraceutical International', 'Nutraceutical Corporation'], names: ['Solaray'] },
  solgar: { own: ['Solgar'], parent: ['NBTY', "Nature's Bounty", 'Nestle Health Science'], names: ['Solgar'] },
  'source-naturals': { own: ['Source Naturals'], parent: ['Threshold Enterprises'], names: ['Source Naturals'] },
  'swanson-vitamins': { own: ['Swanson Health Products'], parent: [], names: ['Swanson'] },
  thorne: { own: ['Thorne Research', 'Thorne HealthTech'], parent: [], names: ['Thorne'] },
};

interface FdaRecord {
  recall_number: string;
  event_id: string;
  recalling_firm: string;
  product_description: string;
  reason_for_recall: string;
  classification: string;
  status: string;
  report_date: string;
  recall_initiation_date?: string;
  code_info?: string;
  distribution_pattern?: string;
}

/** One recall event as a brand page shows it: the FDA often files one record per product in the same event. */
export interface BrandRecall {
  eventId: string;
  firm: string;
  /** ISO date of the FDA's report. */
  date: string;
  classification: string;
  status: string;
  reason: string;
  products: string[];
  lots: string;
  /** The FDA's own recall numbers, for looking the record up. */
  numbers: string[];
}

const norm = (v: string) => v.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** True when `text` begins with all the words of `name` (so "21st century healthcare inc" starts with "21st century healthcare"). */
const startsWithWords = (text: string, name: string) => (norm(text) + ' ').startsWith(norm(name) + ' ');
const hasWords = (text: string, name: string) => (' ' + norm(text) + ' ').includes(' ' + norm(name) + ' ');

function belongs(m: Matcher, r: FdaRecord): boolean {
  if (m.own.some((n) => startsWithWords(r.recalling_firm, n))) return true;
  return m.parent.some((n) => startsWithWords(r.recalling_firm, n)) && m.names.some((n) => hasWords(r.product_description, n));
}

const isoDate = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
const tidy = (v: string | undefined, max: number) => {
  // The feed carries a few mis-encoded trademark signs ("NOWÂ¿"); drop them.
  const t = (v ?? '').replace(/Â[¿®™]?|[\uFFFD®™]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
};

async function ensureTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS brand_recalls (recall_number TEXT PRIMARY KEY, brand TEXT NOT NULL, event_id TEXT NOT NULL, report_date TEXT NOT NULL,
         json TEXT NOT NULL, first_seen TEXT NOT NULL DEFAULT (datetime('now')), posted TEXT NOT NULL DEFAULT '')`,
    )
    .run();
}

async function fetchFirm(name: string): Promise<FdaRecord[]> {
  const url = `https://api.fda.gov/food/enforcement.json?search=${encodeURIComponent(`recalling_firm:"${name}"`)}&limit=200`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return []; // openFDA answers 404 when nothing matches
  if (!res.ok) throw new Error(`openFDA ${res.status} for ${name}`);
  return (((await res.json()) as { results?: FdaRecord[] }).results ?? []).filter((r) => r.recall_number && r.report_date);
}

/** Plain words for the FDA's three classes. */
export function classWords(classification: string): string {
  if (/\bIII\b/.test(classification)) return 'Class III: not likely to cause health problems';
  if (/\bII\b/.test(classification)) return 'Class II: may cause temporary or reversible health problems';
  if (/\bI\b/.test(classification)) return 'Class I: a reasonable chance of serious harm';
  return classification || 'Not yet classified';
}

export function statusWords(status: string): string {
  if (/terminated|completed/i.test(status)) return 'Closed';
  if (/ongoing/i.test(status)) return 'Ongoing';
  return status || 'Status not given';
}

function tweetFor(env: SocialEnv, slug: string, brandName: string, r: FdaRecord): string {
  const link = `${siteOrigin(env)}/brand/${slug}`;
  const cls = /\bIII\b/.test(r.classification) ? 'Class III' : /\bII\b/.test(r.classification) ? 'Class II' : /\bI\b/.test(r.classification) ? 'Class I' : '';
  return `FDA recall notice: ${tidy(r.recalling_firm, 50)} (${brandName}) is recalling ${tidy(r.product_description, 90)}. Reason given: ${tidy(r.reason_for_recall, 110)}${cls ? ` (${cls})` : ''}. Lots and the full record: ${link}`;
}

export interface RecallSync { checked: number; stored: number; fresh: string[]; queued: string[]; errors: string[] }

/**
 * Pull the feed for every profiled brand and store what is new. `brandNames` maps slug to display name.
 * A record is posted on X only when the FDA reported it in the last 30 days and this is not the first sync.
 */
export async function syncRecalls(env: SocialEnv & { DB: D1Database }, brandNames: Map<string, string>): Promise<RecallSync> {
  await ensureTable(env.DB);
  const out: RecallSync = { checked: 0, stored: 0, fresh: [], queued: [], errors: [] };
  const firstRun = !(await getMeta(env.DB, 'recalls:synced'));
  const known = new Set(((await env.DB.prepare('SELECT recall_number FROM brand_recalls').all<{ recall_number: string }>()).results ?? []).map((r) => r.recall_number));
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const postedEvents = new Set<string>();
  for (const [slug, m] of Object.entries(MATCHERS)) {
    const name = brandNames.get(slug);
    if (!name) continue;
    const seen = new Map<string, FdaRecord>();
    for (const firm of [...m.own, ...m.parent]) {
      try {
        for (const r of await fetchFirm(firm)) if (belongs(m, r)) seen.set(r.recall_number, r);
      } catch (err) {
        out.errors.push(String(err instanceof Error ? err.message : err).slice(0, 120));
      }
    }
    out.checked += seen.size;
    for (const r of seen.values()) {
      if (known.has(r.recall_number)) {
        // Status moves from Ongoing to Terminated over time; keep the stored copy current.
        await env.DB.prepare('UPDATE brand_recalls SET json = ? WHERE recall_number = ?').bind(JSON.stringify(r), r.recall_number).run();
        continue;
      }
      const date = isoDate(r.report_date);
      const recent = date >= cutoff;
      const post = !firstRun && recent && !postedEvents.has(r.event_id);
      await env.DB
        .prepare('INSERT INTO brand_recalls (recall_number, brand, event_id, report_date, json, posted) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(r.recall_number, slug, r.event_id, date, JSON.stringify(r), post ? 'queued' : firstRun ? 'backfill' : 'old')
        .run();
      out.stored++;
      out.fresh.push(`${name}: ${tidy(r.product_description, 70)} (${date})`);
      if (post) {
        postedEvents.add(r.event_id);
        await enqueue(env.DB, 'recall', r.recall_number, [tweetFor(env, slug, name, r)], new Date());
        out.queued.push(r.recall_number);
      }
    }
  }
  await setMeta(env.DB, 'recalls:synced', new Date().toISOString());
  return out;
}

/** The brand's recall events, newest first, and when the feed was last read (null before the first sync). */
export async function brandRecalls(db: D1Database, slug: string): Promise<{ events: BrandRecall[]; checked: string | null; tracked: boolean }> {
  const tracked = slug in MATCHERS;
  let rows: { json: string }[] = [];
  try {
    rows = (await db.prepare('SELECT json FROM brand_recalls WHERE brand = ? ORDER BY report_date DESC').bind(slug).all<{ json: string }>()).results ?? [];
  } catch {
    return { events: [], checked: null, tracked }; // table not created yet
  }
  const byEvent = new Map<string, BrandRecall>();
  for (const row of rows) {
    const r = JSON.parse(row.json) as FdaRecord;
    const e = byEvent.get(r.event_id);
    if (e) {
      e.products.push(tidy(r.product_description, 160));
      e.numbers.push(r.recall_number);
      continue;
    }
    byEvent.set(r.event_id, {
      eventId: r.event_id,
      firm: r.recalling_firm,
      date: isoDate(r.report_date),
      classification: r.classification,
      status: r.status,
      reason: tidy(r.reason_for_recall, 300),
      products: [tidy(r.product_description, 160)],
      lots: tidy(r.code_info, 220),
      numbers: [r.recall_number],
    });
  }
  return { events: [...byEvent.values()], checked: (await getMeta(db, 'recalls:synced'))?.slice(0, 10) ?? null, tracked };
}

/** Every stored record, for the owner's list. */
export async function listRecalls(db: D1Database): Promise<{ brand: string; recall_number: string; report_date: string; posted: string; product: string; firm: string }[]> {
  await ensureTable(db);
  const rows = (await db.prepare('SELECT brand, recall_number, report_date, posted, json FROM brand_recalls ORDER BY report_date DESC').all<{ brand: string; recall_number: string; report_date: string; posted: string; json: string }>()).results ?? [];
  return rows.map((r) => {
    const j = JSON.parse(r.json) as FdaRecord;
    return { brand: r.brand, recall_number: r.recall_number, report_date: r.report_date, posted: r.posted, product: tidy(j.product_description, 90), firm: j.recalling_firm };
  });
}
