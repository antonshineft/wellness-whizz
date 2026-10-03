// Shared mapping from Webflow CMS CSV exports (Supplements, Results) to our records.
// Used by the SQL importers and by build-data.mjs (which bundles the content into the Worker).
import {
  EFFECTIVITY_LABELS, SAFETY_LABELS, inferCategory, parseCsv, productUrl, safeUrl, sanitizeRichText, slugify,
} from './lib.mjs';

export const FIELD_MAP = {
  name: ['supplement name', 'name', 'title', 'supplement'],
  slug: ['slug'],
  category: ['category', 'type', 'subtitle', 'group', 'kind'],
  form_type: ['form', 'form type', 'shape', 'dosage form', 'image type'],
  fda_status: ['fda', 'fda status', 'fda approved', 'fda approval'],
  safety_status: ['safe option', 'safety status', 'safe', 'safety badge', 'safety label'],
  effectivity: ['effectiveness', 'effectivity', 'effectivity rating', 'efficacy', 'rate', 'rating'],
  safety: ['safe level', 'safety', 'safety rating', 'safety level', 'safety rate'],
  summary: ['summary', 'description', 'short description', 'intro', 'paragraph'],
  benefits_html: ['benefits', 'benefit'],
  contraindications_html: ['contraindications', 'contraindication', 'cautions'],
  enhancing_html: ['enhancing effect', 'enhancing', 'enhancing effects', 'synergy'],
  interactions_html: ['possible interactions', 'interactions', 'posible interactions', 'interaction'],
  why_consider: ['why you should consider to take it', 'why you should consider', 'why consider', 'why'],
  holistic_html: ['content', 'holistic highlights', 'holistic', 'highlights'],
  studies_html: ['research', 'relevant studies', 'studies', 'links'],
  product_1: ['name 1', 'top 1', 'product 1', 'top1'],
  product_2: ['name 2', 'top 2', 'product 2', 'top2'],
  product_3: ['name 3', 'top 3', 'product 3', 'top3'],
  product_4: ['name 4', 'top 4', 'product 4', 'top4'],
  product_5: ['name 5', 'top 5', 'product 5', 'top5'],
  link_1: ['link 1', 'url 1', 'product link 1'],
  link_2: ['link 2', 'url 2', 'product link 2'],
  link_3: ['link 3', 'url 3', 'product link 3'],
  link_4: ['link 4', 'url 4', 'product link 4'],
  link_5: ['link 5', 'url 5', 'product link 5'],
  image_1: ['image 1', 'product image 1'],
  image_2: ['image 2', 'product image 2'],
  image_3: ['image 3', 'product image 3'],
  image_4: ['image 4', 'product image 4'],
  image_5: ['image 5', 'product image 5'],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isLive = (row) => !/^true$/i.test(row['Archived'] ?? '') && !/^true$/i.test(row['Draft'] ?? '');

export function matchColumns(headers) {
  const columnFor = {};
  for (const [field, candidates] of Object.entries(FIELD_MAP)) {
    const hit = candidates.map(norm).map((c) => headers.find((h) => norm(h) === c)).find(Boolean);
    if (hit) columnFor[field] = hit;
  }
  const used = new Set(Object.values(columnFor));
  return { columnFor, ignored: headers.filter((h) => !used.has(h)) };
}

/**
 * Supplements export -> records ready for the database.
 * @param {string} csvText
 * @param {{ imageResolver?: (url: string, baseName: string) => Promise<string> }} [options]
 */
export async function supplementsFromCsv(csvText, options = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('CSV is empty');
  const { columnFor, ignored } = matchColumns(Object.keys(rows[0]));
  if (!columnFor.name) throw new Error('No "Name" column found; adjust FIELD_MAP in scripts/webflow-mapping.mjs');
  const get = (row, field) => (columnFor[field] ? String(row[columnFor[field]] ?? '').trim() : '');

  const records = [];
  let skipped = 0;
  for (const row of rows) {
    const name = get(row, 'name');
    if (!isLive(row) || !name) {
      skipped++;
      continue;
    }
    const slug = get(row, 'slug') || slugify(name);
    const products = [];
    for (let i = 1; i <= 5; i++) {
      const pname = get(row, `product_${i}`);
      if (!pname) continue;
      const product = { name: pname, brand: '', url: safeUrl(get(row, `link_${i}`)) || productUrl(pname) };
      const image = safeUrl(get(row, `image_${i}`));
      if (image) product.image = options.imageResolver ? await options.imageResolver(image, `${slug}-${i}`) : image;
      products.push(product);
    }
    records.push({
      slug,
      name,
      category: get(row, 'category') || inferCategory(name),
      form_type: mapForm(get(row, 'form_type')),
      fda_status: mapFda(get(row, 'fda_status')),
      safety_status: mapSafetyStatus(get(row, 'safety_status')),
      effectivity: mapRating(get(row, 'effectivity'), EFFECTIVITY_LABELS),
      safety: mapRating(get(row, 'safety'), SAFETY_LABELS),
      summary: stripTags(get(row, 'summary')),
      benefits_html: sanitizeRichText(get(row, 'benefits_html')),
      contraindications_html: sanitizeRichText(get(row, 'contraindications_html')),
      enhancing_html: sanitizeRichText(get(row, 'enhancing_html')),
      interactions_html: sanitizeRichText(get(row, 'interactions_html')),
      why_consider: stripTags(get(row, 'why_consider')),
      holistic_html: sanitizeRichText(get(row, 'holistic_html')),
      studies_html: sanitizeRichText(get(row, 'studies_html')),
      products,
    });
  }
  return { records, skipped, columnFor, ignored };
}

/** Results export -> sessions with their cards (supplement slugs + dosage text). */
export function resultsFromCsv(csvText) {
  const rows = parseCsv(csvText);
  const sessions = [];
  let skipped = 0;
  for (const row of rows) {
    const id = String(row['User Session'] || row['Slug'] || row['Name'] || '').trim();
    if (!isLive(row) || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      skipped++;
      continue;
    }
    const cards = [];
    for (let i = 1; i <= 5; i++) {
      const slug = String(row[`Supplement ${i}`] || row[`Supplements ${i}`] || '').trim();
      if (!slug) continue;
      cards.push({ position: i, slug, reason: String(row[`Dosage ${i}`] || row[`Reason ${i}`] || '').trim() });
    }
    sessions.push({ id, created_at: toSqlDate(row['Created On']), cards });
  }
  return { sessions, skipped };
}

// ---------- value mappers ----------

export function mapForm(v) {
  const s = v.toLowerCase();
  if (!s) return 'capsule';
  if (s.includes('small')) return 'small_softgel';
  if (s.includes('soft')) return 'softgel';
  if (s.includes('tablet') || s.includes('pill')) return 'tablet';
  if (s.includes('powder')) return 'powder';
  if (s.includes('gumm')) return 'gummy';
  if (s.includes('bar')) return 'bar';
  if (s.includes('drop') || s.includes('liquid') || s.includes('oil')) return 'drops';
  return 'capsule';
}

export function mapFda(v) {
  const s = v.toLowerCase();
  if (!s) return 'probably_ok';
  if (/\b(not|no|unapproved|banned)\b/.test(s)) return 'not_approved';
  if (/\b(yes|approved|true)\b/.test(s)) return 'approved';
  return 'probably_ok';
}

export function mapSafetyStatus(v) {
  const s = v.toLowerCase();
  if (!s || s === '-') return 'ok'; // Webflow "Safe Option" = "-" was shown as the "Safe Ok" badge
  if (s.includes('prescription')) return 'prescription';
  if (/\b(not|no|unsafe|danger)\b/.test(s)) return 'not_safe';
  if (/\b(ok|moderate|caution)\b/.test(s)) return 'ok';
  return 'safe';
}

export function mapRating(v, labels) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return Math.round(n);
  const m = /rate\s*([1-5])/i.exec(v) || /([1-5])\s*(out of|\/)\s*5/i.exec(v);
  if (m) return Number(m[1]);
  const idx = labels.findIndex((l) => v.toLowerCase().includes(l));
  return idx >= 0 ? idx + 1 : 3;
}

export function stripTags(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function toSqlDate(value) {
  const d = new Date(String(value ?? ''));
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}
