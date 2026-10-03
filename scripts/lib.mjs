// Shared helpers for the seed builder and the Webflow CSV importer (plain Node, no dependencies).

export const FORM_TYPES = ['capsule', 'softgel', 'small_softgel', 'tablet', 'powder', 'gummy', 'bar', 'drops'];
export const EFFECTIVITY_LABELS = ['possible', 'supportive', 'reasonable', 'potent', 'clinically proven'];
export const SAFETY_LABELS = ['cautionary', 'mild risk', 'secure', 'safe', 'proven safe'];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function listHtml(items, tag = 'ol') {
  const clean = (items ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!clean.length) return '';
  return `<${tag}>${clean.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`;
}

export function studiesHtml(studies) {
  const clean = (studies ?? []).filter((s) => s && s.title);
  if (!clean.length) return '';
  return `<ul>${clean
    .map((s) => {
      const label = [s.title, [s.source, s.year].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
      const href = s.url || `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(s.title)}`;
      return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener nofollow">${escapeHtml(label)}</a></li>`;
    })
    .join('')}</ul>`;
}

export function normalizeNameKey(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function slugify(name) {
  return normalizeNameKey(name).replace(/\s+/g, '-').slice(0, 80).replace(/-+$/g, '');
}

const RICH_TEXT_TAGS = new Set(['p', 'br', 'ol', 'ul', 'li', 'strong', 'em', 'b', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'a', 'div', 'span']);

/** Keep only harmless formatting tags from CMS rich text; links keep an http(s) href only. */
export function sanitizeRichText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag, attrs) => {
      const name = tag.toLowerCase();
      if (!RICH_TEXT_TAGS.has(name)) return '';
      if (match.startsWith('</')) return `</${name}>`;
      if (name !== 'a') return `<${name}>`;
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = safeUrl(href ? (href[1] ?? href[2] ?? href[3] ?? '') : '');
      return url ? `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener nofollow">` : '<a>';
    })
    .replace(/<p>(?:\s|&nbsp;|\u200d|\u200b)*<\/p>/g, '')
    .trim();
}

/** Only absolute http(s) URLs are allowed into href attributes. */
export function safeUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

export function productUrl(query, template = 'https://www.iherb.com/search?kw={query}') {
  return template.replace('{query}', encodeURIComponent(query));
}

export function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function clampRating(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
}

/** Rough category from the supplement name (the Webflow CMS had no category field). */
export function inferCategory(name) {
  const n = String(name).toLowerCase();
  const rules = [
    ['Probiotic', /probiotic/],
    ['Protein', /protein|whey|casein|collagen|meal replacement|bar\b/],
    ['Fatty Acid', /omega|fish oil|mct|krill|flax/],
    ['Vitamin', /vitamin|folic|biotin|choline|inositol|multivitamin|prenatal|b12|niacin/],
    ['Mineral', /zinc|magnesium|iron|calcium|selenium|potassium|chromium|iodine|copper|manganese|boron|electrolyte/],
    ['Amino Acid', /creatine|carnitine|glutamine|arginine|citrulline|beta-alanine|bcaa|taurine|theanine|hydroxy|methylsulfonyl|nicotinamide|glucosamine/],
    ['Adaptogen', /ashwagandha|rhodiola|ginseng|maca|holy basil/],
    ['Antioxidant', /coenzyme|coq10|curcumin|resveratrol|quercetin|lutein|lycopene|green tea|acai|blueberry|goji|pomegranate|cranberry/],
    ['Fiber', /fiber|fibre|psyllium/],
    ['Herbal', /extract|root|leaf|berry|garlic|ginger|ginkgo|echinacea|milk thistle|saffron|saw palmetto|turmeric|spirulina|chlorella|superfood|bee pollen|cider/],
  ];
  for (const [cat, re] of rules) if (re.test(n)) return cat;
  return 'Other';
}

/** Build one INSERT statement for the supplements table from a normalised record.
 *  mode 'ignore' keeps existing rows (used by the seed); 'upsert' overwrites them by name (used by the CMS import). */
export function supplementInsert(rec, mode = 'ignore') {
  const name = String(rec.name).trim();
  const cols = [
    'slug', 'name', 'name_key', 'category', 'form_type', 'fda_status', 'safety_status', 'effectivity', 'safety', 'summary',
    'benefits_html', 'contraindications_html', 'enhancing_html', 'interactions_html', 'why_consider', 'holistic_html',
    'studies_html', 'products_json',
  ];
  const vals = [
    rec.slug || slugify(name), name, normalizeNameKey(name), rec.category || 'Other',
    FORM_TYPES.includes(rec.form_type) ? rec.form_type : 'capsule', rec.fda_status || 'probably_ok',
    rec.safety_status || 'safe', clampRating(rec.effectivity), clampRating(rec.safety), rec.summary || '',
    rec.benefits_html || '', rec.contraindications_html || '', rec.enhancing_html || '', rec.interactions_html || '',
    rec.why_consider || '', rec.holistic_html || '', rec.studies_html || '', JSON.stringify(rec.products || []),
  ];
  if (mode !== 'upsert') return `INSERT OR IGNORE INTO supplements (${cols.join(', ')})\nVALUES (${vals.map(sql).join(', ')});`;
  // Existing slugs are never rewritten (old /supplement/... links must keep working); a row is matched either by
  // its normalised name or by its slug.
  const byName = cols.filter((c) => c !== 'name_key' && c !== 'slug').map((c) => `${c} = excluded.${c}`).join(', ');
  const bySlug = cols.filter((c) => c !== 'slug').map((c) => `${c} = excluded.${c}`).join(', ');
  return (
    `INSERT INTO supplements (${cols.join(', ')})\nVALUES (${vals.map(sql).join(', ')})\n` +
    `ON CONFLICT(name_key) DO UPDATE SET ${byName}\nON CONFLICT(slug) DO UPDATE SET ${bySlug};`
  );
}

// ---------- minimal CSV parser (RFC 4180: quotes, escaped quotes, newlines inside quotes) ----------

export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
