/**
 * Brand profiles: a page for each of the brands behind most product picks, with a short history and both sides of
 * the company's record.
 *
 *  - The profiles themselves (src/brands-data.ts) are researched by hand from named sources and reviewed before they
 *    are published; every point about a company carries the link it rests on. Nothing here is written by a model at
 *    request time.
 *  - What the site adds from its own data: which picks carry the brand, and how those picks sit on the dose scale.
 *
 * BRAND_PAGES switches the pages, the links to them and the logo strip: "true", "preview" (only with ?brands=preview,
 * the default) or "false".
 */
import { BRAND_PROFILES } from './brands-data';
import { listSupplements, type Product, type Supplement } from './db';
import { doseFor, listDoseChecks, visibleCheck, type DoseState } from './dose';

export interface BrandPoint {
  text: string;
  source: string;
  sourceName: string;
}

export interface BrandProfile {
  slug: string;
  name: string;
  /** Other spellings the shop uses for the brand ("Swanson" for "Swanson Vitamins"). */
  aliases?: string[];
  founded: number | null;
  founder: string | null;
  headquarters: string | null;
  owner: string | null;
  history: string;
  positives: BrandPoint[];
  negatives: BrandPoint[];
  /** Path of the logo under /images/brands/, or null: the name is set in type instead. */
  logo: string | null;
  /** ISO date the profile was last checked against its sources. */
  reviewed: string;
}

const key = (name: string) => name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const byName = new Map<string, BrandProfile>();
for (const b of BRAND_PROFILES) for (const n of [b.name, ...(b.aliases ?? [])]) byName.set(key(n), b);

export function listBrands(): BrandProfile[] {
  return BRAND_PROFILES;
}

export function getBrand(slug: string): BrandProfile | null {
  return BRAND_PROFILES.find((b) => b.slug === slug) ?? null;
}

/** The profile of the brand a pick names, if it has one. */
export function brandFor(name: string | undefined | null): BrandProfile | null {
  return name ? byName.get(key(name)) ?? null : null;
}

export interface BrandPick {
  supplement: Supplement;
  product: Product;
  /** The pick's verdict on the dose scale, when the page shows one. */
  state: DoseState | null;
}

/** Every pick of a brand across the catalogue, in page order, with its dose verdict where one is shown. */
export async function brandPicks(db: D1Database, brand: BrandProfile, curatedOnly: boolean, studied: boolean, maxPicks: number): Promise<BrandPick[]> {
  const [sups, checks] = await Promise.all([listSupplements(db, 500, curatedOnly), listDoseChecks(db)]);
  const bySlug = new Map(checks.map((c) => [c.slug, visibleCheck(c, studied)]));
  const out: BrandPick[] = [];
  for (const s of sups) {
    for (const p of s.products.slice(0, maxPicks)) {
      if (brandFor(p.brand)?.slug !== brand.slug) continue;
      out.push({ supplement: s, product: p, state: doseFor(bySlug.get(s.slug), p.url)?.state ?? null });
    }
  }
  return out;
}

export interface DoseRecord {
  rated: number;
  /** Within the need or the studied range, or above the need and under the ceiling. */
  fine: number;
  /** Above the safe ceiling, or above the doses used in studies. */
  high: number;
  /** A single dose larger than the body absorbs. */
  more: number;
  /** Below the doses used in studies. */
  low: number;
}

export function doseRecord(picks: BrandPick[]): DoseRecord {
  const r: DoseRecord = { rated: 0, fine: 0, high: 0, more: 0, low: 0 };
  for (const p of picks) {
    if (!p.state || p.state === 'unknown') continue;
    r.rated += 1;
    if (p.state === 'over' || p.state === 'beyond') r.high += 1;
    else if (p.state === 'more') r.more += 1;
    else if (p.state === 'under') r.low += 1;
    else r.fine += 1;
  }
  return r;
}

/**
 * Give every pick its brand. Older picks were stored without one; the shop's title for the product, kept with its
 * label ("NOW Foods, Zinc, 50 mg, 250 Tablets"), starts with it. Returns how many picks were filled in.
 */
export async function backfillBrands(db: D1Database): Promise<number> {
  const titles = new Map((await db.prepare('SELECT url, title FROM dose_labels').all<{ url: string; title: string }>()).results.map((r) => [r.url, r.title]));
  const sups = await listSupplements(db, 500, false);
  let filled = 0;
  for (const s of sups) {
    let changed = false;
    const products = s.products.map((p) => {
      if (p.brand?.trim()) return p;
      const brand = (titles.get(p.url) ?? '').split(',')[0].trim().slice(0, 60);
      if (!brand) return p;
      changed = true;
      filled += 1;
      return { ...p, brand };
    });
    if (changed) await db.prepare("UPDATE supplements SET products_json = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(products), s.id).run();
  }
  return filled;
}
