/**
 * Real iHerb products for supplements that have none (the ones the quiz creates). The Worker searches iHerb for the
 * supplement name, keeps up to five matching products and copies their photos into D1 so the site never hotlinks
 * iHerb's CDN. Photos come with a white background; `opaque: true` tells the templates to blend it into the tile.
 */
import type { Product, Supplement } from './db';
import { storeImage } from './images';
import { searchUrl, type LinkEnv } from './links';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GENERIC = new Set(['vitamin', 'supplement', 'supplements', 'complex', 'extract', 'powder', 'capsules', 'acid', 'the', 'and', 'with', 'of']);

export interface IherbProduct {
  name: string;
  brand: string;
  url: string;
  image: string;
}

export function significantTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !GENERIC.has(t) && (t.length >= 4 || /\d/.test(t)));
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripBrand(title: string, brand: string): string[] {
  const parts = title.split(',').map((p) => p.trim());
  if (brand && parts[0] && parts[0].toLowerCase() === brand.toLowerCase()) parts.shift();
  return parts;
}

/** "NOW Foods, L-Theanine, 200 mg, 120 Veg Capsules" -> "L-Theanine 200 mg" */
export function shortProductName(title: string, brand: string): string {
  const parts = stripBrand(title, brand).filter(
    (p) => p && !/\b(\d+\s*(veg(gie|etarian)?\s*)?(capsules?|caps|tablets?|tabs|softgels?|gummies|packets?|lozenges|chewables?)|\d+(\.\d+)?\s*(oz|g|lb|lbs|ml|fl oz|kg))\b/i.test(p),
  );
  let name = parts.join(' ').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > 48) name = name.slice(0, 48).replace(/\s+\S*$/, '');
  return name || title.slice(0, 48);
}

/** Product cards from an iHerb search page: title, brand, product link and photo. */
export function parseIherbSearch(html: string, query: string, max = 5, brandLimit = 1): IherbProduct[] {
  const tokens = significantTokens(query);
  if (!tokens.length) return [];
  const products: IherbProduct[] = [];
  const seen = new Set<string>();
  const perBrand = new Map<string, number>();
  const cellRe = /<a\b[^>]*class="absolute-link product-link"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(html))) {
    const tag = m[0];
    const url = (tag.match(/href="(https:\/\/www\.iherb\.com\/pr\/[^"]+)"/) || [])[1];
    if (!url || seen.has(url)) continue;
    const brand = decode((tag.match(/data-ga-brand-name="([^"]*)"/) || [])[1] || '');
    const rest = html.slice(m.index, m.index + 8000);
    const title = decode(((rest.match(/class="product-title[^"]*"[^>]*>([^<]*)</) || [])[1] || '').trim());
    const image = (rest.match(/<img[^>]+src="(https:\/\/cloudinary\.images-iherb\.com\/image\/upload\/[^"]+\/images\/[^"]+)"/) || [])[1];
    if (!title || !image) continue;
    const norm = title.toLowerCase();
    if (!tokens.every((t) => norm.includes(t))) continue;
    const count = perBrand.get(brand) ?? 0;
    if (count >= brandLimit) continue;
    perBrand.set(brand, count + 1);
    seen.add(url);
    products.push({ name: shortProductName(title, brand), brand, url, image });
    if (products.length >= max) break;
  }
  return products;
}

export async function searchIherb(query: string, max = 5): Promise<IherbProduct[]> {
  const res = await fetch(`https://www.iherb.com/search?kw=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`iHerb search ${res.status}`);
  return parseIherbSearch(await res.text(), query, max);
}

/**
 * Give a supplement real iHerb products with photos. Returns the number of products attached (0 when iHerb had no
 * match or could not be reached). Existing products without photos are replaced; ones with photos are kept.
 */
export async function attachIherbProducts(env: LinkEnv & { DB: D1Database }, sup: Supplement, max = 5): Promise<number> {
  const found = await searchIherb(sup.name, max);
  if (!found.length) return 0;
  const products: Product[] = [];
  for (let i = 0; i < found.length; i++) {
    const p = found[i];
    try {
      const res = await fetch(p.image, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`image ${res.status}`);
      const type = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      const bytes = new Uint8Array(await res.arrayBuffer());
      const key = `product-${sup.slug}-${i + 1}`;
      await storeImage(env.DB, key, type, bytes);
      products.push({ name: p.name, brand: p.brand, url: p.url, image: `/images/generated/${key}.${type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'}`, opaque: true });
    } catch (err) {
      console.error(`photo for ${sup.slug} (${p.name}) failed: ${String(err)}`);
      products.push({ name: p.name, brand: p.brand, url: p.url });
    }
  }
  if (!products.some((p) => p.image)) return 0;
  const kept = sup.products.filter((p) => p.image);
  const merged = [...kept, ...products.filter((p) => !kept.some((k) => k.name.toLowerCase() === p.name.toLowerCase()))].slice(0, 5);
  await env.DB.prepare('UPDATE supplements SET products_json = ? WHERE id = ?').bind(JSON.stringify(merged), sup.id).run();
  return products.filter((p) => p.image).length;
}

/** Supplements without a single product photo, AI-created ones first. */
export async function supplementsWithoutPhotos(db: D1Database, limit: number): Promise<{ id: number; slug: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug FROM supplements
       WHERE products_json NOT LIKE '%"image":%'
       ORDER BY source = 'ai' DESC, created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number; slug: string }>();
  return results;
}

/** Search link for a product without a URL of its own (kept for callers that build products by hand). */
export function fallbackProductUrl(env: LinkEnv, p: { name: string; brand?: string }): string {
  return searchUrl(env, `${p.brand ?? ''} ${p.name}`.trim());
}
