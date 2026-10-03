#!/usr/bin/env node
/**
 * Find real iHerb products (name, brand, link, photo) for a supplement and copy their photos into
 * public/images/products/ as transparent WebP files, the same way the Webflow photos were brought over.
 *
 *   node scripts/iherb-products.mjs --query "l-theanine" --slug l-theanine [--max 5] [--brand-limit 2] [--json]
 *
 * Prints a JSON array of products ({ name, brand, url, image }) ready to paste into data/supplements.json.
 * With --json only the JSON is printed. Network access to www.iherb.com and cloudinary.images-iherb.com is needed
 * (in a proxied sandbox: NODE_USE_ENV_PROXY=1).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const QUERY = opt('--query', '');
const SLUG = opt('--slug', '');
const MAX = Number(opt('--max', 5));
const BRAND_LIMIT = Number(opt('--brand-limit', 2));
const JSON_ONLY = args.includes('--json');
const START_INDEX = Number(opt('--start-index', 1));

const IMAGE_DIR = new URL('../public/images/products/', import.meta.url);
mkdirSync(IMAGE_DIR, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export async function searchIherb(query, { max = 5, brandLimit = 2 } = {}) {
  const res = await fetch(`https://www.iherb.com/search?kw=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`iHerb search ${res.status}`);
  return parseSearch(await res.text(), query, { max, brandLimit });
}

/** Pull product cards out of the search page. Exported so the test and the Worker share one parser idea. */
export function parseSearch(html, query, { max = 5, brandLimit = 2 } = {}) {
  const tokens = significantTokens(query);
  const products = [];
  const seen = new Set();
  const perBrand = new Map();
  const cellRe = /<a\b[^>]*class="absolute-link product-link"[^>]*>/g;
  let m;
  while ((m = cellRe.exec(html))) {
    const tag = m[0];
    const url = (tag.match(/href="(https:\/\/www\.iherb\.com\/pr\/[^"]+)"/) || [])[1];
    if (!url) continue;
    const brand = decode((tag.match(/data-ga-brand-name="([^"]*)"/) || [])[1] || '');
    const rest = html.slice(m.index, m.index + 8000);
    const title = decode(((rest.match(/class="product-title[^"]*"[^>]*>([^<]*)</) || [])[1] || '').trim());
    const image = (rest.match(/<img[^>]+src="(https:\/\/cloudinary\.images-iherb\.com\/image\/upload\/[^"]+\/images\/[^"]+)"/) || [])[1];
    if (!title || !image || seen.has(url)) continue;
    const norm = title.toLowerCase();
    if (!tokens.every((t) => norm.includes(t))) continue; // must actually be this supplement
    const count = perBrand.get(brand) || 0;
    if (count >= brandLimit) continue;
    perBrand.set(brand, count + 1);
    seen.add(url);
    products.push({ name: shortName(title, brand), brand, url, image });
    if (products.length >= max) break;
  }
  return products;
}

function significantTokens(query) {
  const generic = new Set(['vitamin', 'supplement', 'supplements', 'complex', 'extract', 'powder', 'capsules', 'acid', 'the', 'and', 'with', 'of']);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !generic.has(t) && (t.length >= 4 || /\d/.test(t)));
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripBrand(title, brand) {
  const parts = title.split(',').map((p) => p.trim());
  if (brand && parts[0] && parts[0].toLowerCase() === brand.toLowerCase()) parts.shift();
  return parts.join(', ');
}

/** "NOW Foods, L-Theanine, 200 mg, 120 Veg Capsules" -> "L-Theanine 200 mg" */
function shortName(title, brand) {
  const parts = stripBrand(title, brand)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/\b(\d+\s*(veg(gie|etarian)?\s*)?(capsules?|caps|tablets?|tabs|softgels?|gummies|packets?|lozenges|chewables?)|\d+(\.\d+)?\s*(oz|g|lb|lbs|ml|fl oz|kg))\b/i.test(p));
  let name = parts.join(' ').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > 48) name = name.slice(0, 48).replace(/\s+\S*$/, '');
  return name;
}

/** Download, shrink to 612 px WebP and make the flat background transparent (flood fill from the edges). */
export async function fetchProductImage(url, fileName) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const resized = await sharp(buffer).resize({ width: 612, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = resized;
  stripBackground(data, info.width, info.height, info.channels);
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).webp({ quality: 86 }).toBuffer();
  writeFileSync(new URL(fileName, IMAGE_DIR), out);
  return `/images/products/${fileName}`;
}

function stripBackground(data, w, h, channels, TOLERANCE = 28, FEATHER = 22) {
  const corners = [0, (w - 1) * channels, (h - 1) * w * channels, ((h - 1) * w + w - 1) * channels];
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((s, i) => s + data[i + c], 0) / corners.length));
  const dist = (i) => Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  const limit = TOLERANCE + FEATHER;
  const visited = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (dist(p * channels) <= limit) queue.push(p);
    else visited[p] = 2;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const p = queue.pop();
    const x = p % w;
    const y = (p - x) / w;
    const d = dist(p * channels);
    data[p * channels + 3] = d <= TOLERANCE ? 0 : Math.round((255 * (d - TOLERANCE)) / FEATHER);
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!QUERY || !SLUG) {
    console.error('usage: node scripts/iherb-products.mjs --query "<search>" --slug <supplement-slug>');
    process.exit(1);
  }
  const found = await searchIherb(QUERY, { max: MAX, brandLimit: BRAND_LIMIT });
  if (!JSON_ONLY) console.error(`${found.length} products for "${QUERY}"`);
  const out = [];
  for (let i = 0; i < found.length; i++) {
    const p = found[i];
    const fileName = `${SLUG}-${START_INDEX + i}.webp`;
    try {
      const image = await fetchProductImage(p.image, fileName);
      out.push({ name: p.name, brand: p.brand, url: p.url, image });
      if (!JSON_ONLY) console.error(`  ${p.brand} — ${p.name} -> ${image}`);
    } catch (err) {
      if (!JSON_ONLY) console.error(`  ${p.name}: ${String(err)}`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
