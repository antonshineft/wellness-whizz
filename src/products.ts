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
  await env.DB.prepare("UPDATE supplements SET products_json = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(merged), sup.id).run();
  return products.filter((p) => p.image).length;
}

/**
 * Add one more iHerb product to a supplement that has fewer than `total`. The product and its photo are found by
 * the pick collector outside the Worker (iHerb refuses searches from here); this stores the photo in D1 and appends
 * the pick. The referral code is added when the link is rendered (src/links.ts withReferral).
 */
export async function attachExtraProduct(
  env: { DB: D1Database },
  sup: Supplement,
  pick: { name: string; brand: string; url: string },
  photo: { bytes: Uint8Array; type: string },
  total = 6,
): Promise<{ ok: true; product: Product } | { ok: false; message: string }> {
  if (!sup.products.length) return { ok: false, message: 'the page has no picks to add to' };
  if (sup.products.length >= total) return { ok: false, message: `the page already has ${sup.products.length} picks` };
  if (!/^https:\/\/www\.iherb\.com\/pr\/[a-z0-9-]+\/\d+$/i.test(pick.url)) return { ok: false, message: 'url must be an iHerb product page' };
  const idOf = (u: string) => (u.match(/\/(\d+)(?:[/?#]|$)/) || [])[1] ?? '';
  if (sup.products.some((p) => idOf(p.url) === idOf(pick.url) || p.name.trim().toLowerCase() === pick.name.trim().toLowerCase())) return { ok: false, message: 'that product is already a pick' };
  if (!/^image\/(jpeg|png|webp)$/.test(photo.type) || photo.bytes.length < 2000 || photo.bytes.length > 900_000) return { ok: false, message: 'the photo is missing or not a usable image' };
  const key = `product-${sup.slug}-${sup.products.length + 1}`;
  await storeImage(env.DB, key, photo.type, photo.bytes);
  const product: Product = { name: pick.name.trim().slice(0, 60), brand: pick.brand.trim().slice(0, 60), url: pick.url, image: `/images/generated/${key}.${photo.type.includes('png') ? 'png' : photo.type.includes('webp') ? 'webp' : 'jpg'}`, opaque: true };
  await env.DB.prepare("UPDATE supplements SET products_json = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify([...sup.products, product]), sup.id).run();
  return { ok: true, product };
}

/**
 * Put another iHerb product in place `n` of a page's picks (or append it when `n` is one past the last), or, without
 * a url, only correct the name and brand of the pick that is there. Used when a product is gone from the shop, is
 * listed twice, or carries a dose the owner does not want to recommend.
 */
export async function setProduct(
  env: { DB: D1Database },
  sup: Supplement,
  n: number,
  pick: { name: string; brand: string; url?: string },
  photo: { bytes: Uint8Array; type: string } | null,
  total = 6,
): Promise<{ ok: true; product: Product } | { ok: false; message: string }> {
  if (!Number.isInteger(n) || n < 1 || n > Math.min(total, sup.products.length + 1)) return { ok: false, message: `place must be 1 to ${Math.min(total, sup.products.length + 1)}` };
  const name = pick.name.trim().slice(0, 60);
  if (!name) return { ok: false, message: 'a name is required' };
  const products = [...sup.products];
  let product: Product;
  if (!pick.url) {
    if (!products[n - 1]) return { ok: false, message: 'there is no pick at that place to rename' };
    product = { ...products[n - 1], name, brand: pick.brand.trim().slice(0, 60) };
  } else {
    if (!/^https:\/\/www\.iherb\.com\/pr\/[a-z0-9-]+\/\d+$/i.test(pick.url)) return { ok: false, message: 'url must be an iHerb product page' };
    const url = pick.url;
    const idOf = (u: string) => (u.match(/\/(\d+)(?:[/?#]|$)/) || [])[1] ?? '';
    if (products.some((p, i) => i !== n - 1 && (idOf(p.url) === idOf(url) || p.name.trim().toLowerCase() === name.toLowerCase()))) return { ok: false, message: 'that product is already a pick' };
    if (!photo || !/^image\/(jpeg|png|webp)$/.test(photo.type) || photo.bytes.length < 2000 || photo.bytes.length > 900_000) return { ok: false, message: 'the photo is missing or not a usable image' };
    // The shop's product number is part of the key, so a browser never shows the photo of the pick that was there before.
    const key = `product-${sup.slug}-${n}-${idOf(pick.url)}`;
    await storeImage(env.DB, key, photo.type, photo.bytes);
    product = { name, brand: pick.brand.trim().slice(0, 60), url: pick.url, image: `/images/generated/${key}.${photo.type.includes('png') ? 'png' : photo.type.includes('webp') ? 'webp' : 'jpg'}`, opaque: true };
  }
  products[n - 1] = product;
  await env.DB.prepare("UPDATE supplements SET products_json = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(products), sup.id).run();
  return { ok: true, product };
}

/**
 * Replace the photo of the pick at place `n` with a cut-out of the same photo (the product on a transparent
 * background). Photos taken from the shop come on white, and were shown blended into the card, which washed out
 * white bottles; a cut-out needs no blending.
 */
export async function setProductCutout(env: { DB: D1Database }, sup: Supplement, n: number, photo: { bytes: Uint8Array; type: string }): Promise<{ ok: true; image: string } | { ok: false; message: string }> {
  const product = sup.products[n - 1];
  const key = /^\/images\/generated\/([a-z0-9-]+)\.(?:jpe?g|png|webp)$/.exec(product?.image ?? '')?.[1];
  if (!product || !key) return { ok: false, message: 'that pick has no stored photo to replace' };
  if (!/^image\/(png|webp)$/.test(photo.type) || photo.bytes.length < 2000 || photo.bytes.length > 900_000) return { ok: false, message: 'the cut-out must be a PNG or WebP image' };
  const cut = `${key.replace(/-cut$/, '')}-cut`.slice(0, 120);
  await storeImage(env.DB, cut, photo.type, photo.bytes);
  const { opaque: _opaque, ...rest } = product;
  const products = [...sup.products];
  products[n - 1] = { ...rest, image: `/images/generated/${cut}.${photo.type.includes('png') ? 'png' : 'webp'}` };
  await env.DB.prepare("UPDATE supplements SET products_json = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(products), sup.id).run();
  return { ok: true, image: products[n - 1].image as string };
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
