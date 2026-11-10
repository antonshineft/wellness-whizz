/**
 * Dose check: how much of a supplement each product pick delivers a day, set against a reference.
 *
 *  - Vitamins and minerals are judged against the official adult figures (NIH Office of Dietary Supplements): the
 *    daily need (RDA, or AI where no RDA exists) and the tolerable upper intake level (UL). These numbers are fixed in
 *    NUTRIENTS below and never come from a model.
 *  - Everything else has no official norm, so it is judged against the daily doses used in studies, which the Claude
 *    API reads from the site's own page about the supplement (and only from there).
 *  - What a product contains comes from its Supplement Facts label on iHerb, stored in dose_labels by the label
 *    collector (a script outside the Worker). The Claude API reads the amount of this page's supplement from that
 *    label; products without a readable label get no verdict.
 *
 * The verdict itself is arithmetic, done here. Results live in dose_checks, one row per supplement.
 */
import { claudeJson } from './claude';
import type { Supplement } from './db';
import type { VideoEnv } from './videos';

export interface Nutrient {
  key: string;
  match: RegExp;
  unit: 'mg' | 'mcg';
  /** Adult daily need: the RDA, or the AI where no RDA is set (the higher of the figures for men and women). */
  need: number;
  needKind: 'RDA' | 'AI';
  /** Tolerable upper intake level for adults; null where none has been set. */
  ceiling: number | null;
  /** A single-dose size above which absorption is known to fall off. */
  absorb?: { above: number; note: string };
  note: string;
}

export const NUTRIENTS: Nutrient[] = [
  { key: 'vitamin C', match: /vitamin c\b|ascorb/i, unit: 'mg', need: 90, needKind: 'RDA', ceiling: 2000, absorb: { above: 999, note: 'From a single dose of 1,000 mg or more the body absorbs less than half.' }, note: 'The body absorbs 70 to 90% of vitamin C at 30 to 180 mg a day.' },
  { key: 'vitamin D', match: /vitamin d\d?\b|cholecalciferol/i, unit: 'mcg', need: 15, needKind: 'RDA', ceiling: 100, note: '1 mcg equals 40 IU, so the ceiling of 100 mcg is 4,000 IU.' },
  { key: 'vitamin A', match: /vitamin a\b|retin/i, unit: 'mcg', need: 900, needKind: 'RDA', ceiling: 3000, note: 'The ceiling applies to preformed vitamin A (retinol), not to beta-carotene.' },
  { key: 'vitamin E', match: /vitamin e\b|tocopher/i, unit: 'mg', need: 15, needKind: 'RDA', ceiling: 1000, note: 'The ceiling applies to vitamin E from supplements.' },
  { key: 'vitamin K', match: /vitamin k\d?\b|menaquinone|phylloquinone/i, unit: 'mcg', need: 120, needKind: 'AI', ceiling: null, note: 'No ceiling has been set for vitamin K.' },
  { key: 'thiamin', match: /thiamin|vitamin b1\b/i, unit: 'mg', need: 1.2, needKind: 'RDA', ceiling: null, note: 'No ceiling has been set for thiamin.' },
  { key: 'riboflavin', match: /riboflavin|vitamin b2\b/i, unit: 'mg', need: 1.3, needKind: 'RDA', ceiling: null, note: 'No ceiling has been set for riboflavin.' },
  { key: 'niacin', match: /niacin|vitamin b3\b|nicotinamide$|niacinamide/i, unit: 'mg', need: 16, needKind: 'RDA', ceiling: 35, note: 'The ceiling of 35 mg is the amount from supplements at which flushing begins.' },
  { key: 'pantothenic acid', match: /pantothen|vitamin b5\b/i, unit: 'mg', need: 5, needKind: 'AI', ceiling: null, note: 'No ceiling has been set for pantothenic acid.' },
  { key: 'vitamin B6', match: /vitamin b6\b|pyridox/i, unit: 'mg', need: 1.7, needKind: 'RDA', ceiling: 100, note: 'Long-term intake above the ceiling can damage nerves.' },
  { key: 'biotin', match: /biotin|vitamin b7\b/i, unit: 'mcg', need: 30, needKind: 'AI', ceiling: null, note: 'No ceiling has been set for biotin. High doses can distort some blood tests.' },
  // Labels state folate twice: in mcg DFE and, in brackets, as mcg of folic acid itself (1 mcg folic acid = 1.7 mcg DFE).
  // The ceiling is set in mcg of folic acid, so that is the unit here; the daily need of 400 mcg DFE is 240 mcg of it.
  { key: 'folate', match: /folate|folic|methylfolate|vitamin b9\b/i, unit: 'mcg', need: 240, needKind: 'RDA', ceiling: 1000, note: 'Amounts are micrograms of folic acid itself, the figure labels give in brackets. 240 mcg of folic acid covers the daily need of 400 mcg DFE; the ceiling of 1,000 mcg applies to folic acid from supplements and fortified food.' },
  { key: 'vitamin B12', match: /vitamin b12\b|cobalamin/i, unit: 'mcg', need: 2.4, needKind: 'RDA', ceiling: null, note: 'No ceiling has been set. Only a small share of a large dose is absorbed, which is why tablets carry far more than the daily need.' },
  { key: 'calcium', match: /calcium/i, unit: 'mg', need: 1000, needKind: 'RDA', ceiling: 2500, absorb: { above: 500, note: 'Calcium is absorbed best in single doses of 500 mg or less.' }, note: 'The daily need includes calcium from food.' },
  { key: 'magnesium', match: /magnesium/i, unit: 'mg', need: 420, needKind: 'RDA', ceiling: 350, note: 'The ceiling of 350 mg counts magnesium from supplements only; above it loose stools are common. Food magnesium does not count.' },
  { key: 'zinc', match: /zinc/i, unit: 'mg', need: 11, needKind: 'RDA', ceiling: 40, note: 'Long-term intake above the ceiling can lower copper levels.' },
  { key: 'iron', match: /\biron\b/i, unit: 'mg', need: 18, needKind: 'RDA', ceiling: 45, note: 'The daily need is 18 mg for women aged 19 to 50 and 8 mg for men.' },
  { key: 'selenium', match: /selenium/i, unit: 'mcg', need: 55, needKind: 'RDA', ceiling: 400, note: '' },
  { key: 'iodine', match: /iodine|iodide|kelp/i, unit: 'mcg', need: 150, needKind: 'RDA', ceiling: 1100, note: '' },
  { key: 'copper', match: /copper/i, unit: 'mg', need: 0.9, needKind: 'RDA', ceiling: 10, note: '' },
  { key: 'manganese', match: /manganese/i, unit: 'mg', need: 2.3, needKind: 'AI', ceiling: 11, note: '' },
  { key: 'chromium', match: /chromium/i, unit: 'mcg', need: 35, needKind: 'AI', ceiling: null, note: 'No ceiling has been set for chromium.' },
  { key: 'molybdenum', match: /molybdenum/i, unit: 'mcg', need: 45, needKind: 'RDA', ceiling: 2000, note: '' },
  { key: 'potassium', match: /potassium/i, unit: 'mg', need: 3400, needKind: 'AI', ceiling: null, note: 'No ceiling has been set. Supplements usually carry far less than the daily need, most of which comes from food.' },
  { key: 'choline', match: /choline/i, unit: 'mg', need: 550, needKind: 'AI', ceiling: 3500, note: '' },
];

/** The nutrient a supplement page is about, by its name; only for pages in the vitamin and mineral categories. */
export function nutrientFor(sup: Pick<Supplement, 'name' | 'category'>): Nutrient | null {
  if (!['Vitamin', 'Mineral'].includes(sup.category) && !/choline$/i.test(sup.name.trim())) return null;
  // "Alpha-GPC" or "citicoline" are choline donors, not choline itself; "Vitamin D3 and K2" is two nutrients.
  if (/\band\b|\+|&|complex|multi/i.test(sup.name)) return null;
  return NUTRIENTS.find((n) => n.match.test(sup.name)) ?? null;
}

/** Picks per supplement page: a two by three grid. */
export const MAX_PICKS = 6;

export type DoseState = 'within' | 'above' | 'more' | 'over' | 'under' | 'in' | 'beyond' | 'unknown';

export interface DoseProduct {
  name: string;
  url: string;
  /** Amount of this page's supplement in one serving, in the reference unit; null when the label did not say. */
  amount: number | null;
  per: string;
  servings: number;
  /** amount x servings a day at the label's directions. */
  daily: number | null;
  line: string;
  state: DoseState;
  /** Other vitamins and minerals in the product that exceed their own ceiling at the label's directions. */
  also: string[];
}

export interface DoseCheck {
  slug: string;
  name: string;
  basis: 'official' | 'studied';
  unit: string;
  /** Official: the daily need. Studied: the low end of the daily doses used in studies. */
  low: number | null;
  /** Official: the ceiling (null when none is set). Studied: the high end of the daily doses used in studies. */
  high: number | null;
  lowLabel: string;
  highLabel: string;
  note: string;
  source: string;
  products: DoseProduct[];
  at: string;
}

interface LabelRow { url: string; title: string; label: string; directions: string }

const answerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reference: {
      type: 'object',
      additionalProperties: false,
      description: 'Only for supplements without an official daily need: the range of DAILY doses used in the human studies the page describes. All null when the page gives no dose.',
      properties: {
        low: { type: ['number', 'null'], description: 'Lowest daily dose the page reports from studies.' },
        high: { type: ['number', 'null'], description: 'Highest daily dose the page reports from studies.' },
        unit: { type: 'string', description: 'mg, g, mcg, IU, or "billion CFU". One unit for low, high and every product amount.' },
        quote: { type: 'string', description: 'The sentence from the page the range rests on, word for word, at most 200 characters; empty when there is none.' },
      },
      required: ['low', 'high', 'unit', 'quote'],
    },
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n: { type: 'integer', description: 'The product number as given.' },
          amount: { type: ['number', 'null'], description: 'Amount of THIS page\'s supplement in ONE serving, in the reference unit. Null when neither the label nor the product title states it.' },
          per: { type: 'string', description: 'What one serving is, e.g. "tablet", "2 capsules", "scoop".' },
          servings_per_day: { type: ['number', 'null'], description: 'Servings a day at the label\'s directions (the lower figure when a range is given); null when the directions do not say.' },
          line: { type: 'string', description: 'The label line (or title fragment) the amount was read from, word for word; empty when amount is null.' },
          others: {
            type: 'array',
            description: 'Other vitamins and minerals on the label with their amount per serving, at most eight. Empty for single-ingredient products.',
            items: { type: 'object', additionalProperties: false, properties: { ingredient: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string', description: 'mg or mcg (convert IU: vitamin D 40 IU = 1 mcg).' } }, required: ['ingredient', 'amount', 'unit'] },
          },
        },
        required: ['n', 'amount', 'per', 'servings_per_day', 'line', 'others'],
      },
    },
  },
  required: ['reference', 'products'],
};

const DOSE_SYSTEM = `You read supplement labels for a consumer site. You are given one supplement, the site's own page text about it, and for each product the Supplement Facts label and directions copied from the shop.

Report facts only:
- For each product, the amount of THIS supplement in one serving, read from the label. If the label lists several forms of it, add them. If the label is missing, use the amount stated in the product title; if neither states it, answer null. Never estimate, never use what you remember about a product.
- Convert the amount into the reference unit you are told to use. Folate and folic acid: report the micrograms of folic acid (or methylfolate) itself, the figure the label gives in brackets, never the mcg DFE figure. Vitamin D: 40 IU = 1 mcg. Vitamin A: 1 mcg RAE = 3.33 IU retinol. Vitamin E: 1 mg = 1.49 IU natural (d-alpha) or 2.22 IU synthetic (dl-alpha). For minerals use the elemental amount the label states, not the weight of the compound. For botanical extracts use the extract weight.
- Servings a day come from the directions only. When the directions give a range ("1 to 3 times daily"), report the LOWER figure: the check is about ordinary use, not the maximum.
- For a supplement without an official daily need, also report the range of daily doses used in human studies, taken ONLY from the page text given. If the page does not state doses, answer null for both.`;

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

const round = (v: number) => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/** Convert between the units a label may use and the reference unit; null when they cannot be compared. */
function toUnit(amount: number, from: string, to: string): number | null {
  const f = from.trim().toLowerCase().replace('µg', 'mcg').replace('μg', 'mcg');
  const t = to.trim().toLowerCase();
  if (f === t) return amount;
  const mg: Record<string, number> = { g: 1000, mg: 1, mcg: 0.001 };
  return f in mg && t in mg ? (amount * mg[f]) / mg[t] : null;
}

function verdict(basis: 'official' | 'studied', low: number | null, high: number | null, amount: number | null, daily: number | null, nutrient: Nutrient | null): DoseState {
  if (amount === null || daily === null) return 'unknown';
  if (basis === 'official') {
    if (high !== null && daily > high) return 'over';
    if (low !== null && daily <= Math.min(low, high ?? low)) return 'within';
    return nutrient?.absorb && amount > nutrient.absorb.above ? 'more' : 'above';
  }
  if (low === null || high === null) return 'unknown';
  if (daily < low * 0.8) return 'under';
  if (daily > high * 1.25) return 'beyond';
  return 'in';
}

/** Read the labels of one supplement's picks through the Claude API and store the check. */
export async function checkSupplement(env: VideoEnv, sup: Supplement): Promise<DoseCheck> {
  const products = sup.products.slice(0, MAX_PICKS);
  const nutrient = nutrientFor(sup);
  const labels = new Map<string, LabelRow>();
  for (const p of products) {
    const row = await env.DB.prepare('SELECT url, title, label, directions FROM dose_labels WHERE url = ?').bind(p.url).first<LabelRow>();
    if (row) labels.set(p.url, row);
  }
  const page = plain(`${sup.holistic_html} ${sup.studies_html} ${sup.enhancing_html}`).slice(0, 6000);
  const user = [
    `Supplement: ${sup.name} (${sup.category})`,
    nutrient
      ? `This is a nutrient with an official daily need. Reference unit: ${nutrient.unit}. Leave the reference range null.`
      : 'This supplement has no official daily need. Choose one reference unit and report the range of daily doses used in the studies described in the page text.',
    '',
    `Page text:\n${nutrient ? '(not needed)' : page}`,
    '',
    ...products.map((p, i) => {
      const l = labels.get(p.url);
      return `PRODUCT ${i + 1}: ${p.name}${p.brand ? ` (${p.brand})` : ''}\nTitle in the shop: ${l?.title || '(not available)'}\nSupplement Facts:\n${l?.label || '(label not available)'}\nDirections: ${l?.directions || '(not available)'}`;
    }),
  ].join('\n');
  const out = products.length
    ? await claudeJson<{ reference: { low: number | null; high: number | null; unit: string; quote: string }; products: { n: number; amount: number | null; per: string; servings_per_day: number | null; line: string; others: { ingredient: string; amount: number; unit: string }[] }[] }>(env, DOSE_SYSTEM, user, answerSchema, { tier: 'fast', maxTokens: 4000 })
    : { reference: { low: null, high: null, unit: '', quote: '' }, products: [] };

  const basis: 'official' | 'studied' = nutrient ? 'official' : 'studied';
  const unit = nutrient ? nutrient.unit : String(out.reference?.unit ?? '').trim();
  const refLow = nutrient ? nutrient.need : out.reference?.low ?? null;
  const refHigh = nutrient ? nutrient.ceiling : out.reference?.high ?? null;
  const usable = basis === 'official' || (refLow !== null && refHigh !== null && refLow > 0 && refHigh >= refLow && !!unit && !!String(out.reference?.quote ?? '').trim());
  const check: DoseCheck = {
    slug: sup.slug,
    name: sup.name,
    basis,
    unit,
    low: usable ? refLow : null,
    high: usable ? refHigh : null,
    lowLabel: nutrient ? `Daily need (${nutrient.needKind})` : 'Lowest daily dose in studies',
    highLabel: nutrient ? 'Safe ceiling (UL)' : 'Highest daily dose in studies',
    note: nutrient ? nutrient.note : String(out.reference?.quote ?? '').trim().slice(0, 240),
    source: nutrient ? 'NIH Office of Dietary Supplements, figures for adults' : 'Doses used in the studies described on this page',
    products: products.map((p, i) => {
      const r = (out.products ?? []).find((x) => x.n === i + 1);
      const amount = r && typeof r.amount === 'number' && r.amount > 0 && String(r.line ?? '').trim() ? round(r.amount) : null;
      const servings = r && typeof r.servings_per_day === 'number' && r.servings_per_day > 0 && r.servings_per_day <= 12 ? r.servings_per_day : 1;
      const daily = amount === null ? null : round(amount * servings);
      const also: string[] = [];
      for (const o of r?.others ?? []) {
        const n = NUTRIENTS.find((x) => x.match.test(o.ingredient));
        if (!n || n.ceiling === null || (nutrient && n.key === nutrient.key)) continue;
        const v = toUnit(o.amount, o.unit, n.unit);
        if (v !== null && v * servings > n.ceiling) also.push(`${n.key} ${round(v * servings)} ${n.unit} a day (ceiling ${n.ceiling} ${n.unit})`);
      }
      return { name: p.name, url: p.url, amount, per: String(r?.per ?? '').trim().slice(0, 40) || 'serving', servings, daily, line: String(r?.line ?? '').trim().slice(0, 160), state: usable ? verdict(basis, refLow, refHigh, amount, daily, nutrient) : 'unknown', also };
    }),
    at: new Date().toISOString(),
  };
  await env.DB.prepare("INSERT INTO dose_checks (slug, json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (slug) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").bind(sup.slug, JSON.stringify(check)).run();
  return check;
}

export async function getDoseCheck(db: D1Database, slug: string): Promise<DoseCheck | null> {
  try {
    const row = await db.prepare('SELECT json FROM dose_checks WHERE slug = ?').bind(slug).first<{ json: string }>();
    return row ? (JSON.parse(row.json) as DoseCheck) : null;
  } catch {
    return null;
  }
}

export async function listDoseChecks(db: D1Database): Promise<DoseCheck[]> {
  const rows = (await db.prepare('SELECT json FROM dose_checks ORDER BY slug').all<{ json: string }>()).results ?? [];
  return rows.map((r) => { try { return JSON.parse(r.json) as DoseCheck; } catch { return null; } }).filter((c): c is DoseCheck => !!c);
}

export async function storeLabels(db: D1Database, items: { url: string; title?: string; label?: string; directions?: string }[]): Promise<number> {
  let n = 0;
  for (const i of items.slice(0, 60)) {
    if (!/^https:\/\/(www\.)?iherb\.(co|com)\//.test(String(i.url))) continue;
    await db.prepare("INSERT INTO dose_labels (url, title, label, directions, fetched_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT (url) DO UPDATE SET title = excluded.title, label = excluded.label, directions = excluded.directions, fetched_at = excluded.fetched_at")
      .bind(String(i.url), String(i.title ?? '').slice(0, 300), String(i.label ?? '').slice(0, 4000), String(i.directions ?? '').slice(0, 800)).run();
    n += 1;
  }
  return n;
}

// ---------- rendering: one scale per product ----------

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: n >= 100 ? 0 : 2 });

/** Best-dosed first when the picks are ordered: in range, then merely above the need, down to above the ceiling. */
export const STATE_RANK: Record<DoseState, number> = { in: 0, within: 0, above: 1, under: 2, unknown: 3, more: 4, beyond: 5, over: 6 };

const WORDS: Record<DoseState, { mark: string; cls: string; text: string }> = {
  within: { mark: '✓', cls: 'ok', text: 'Within the daily need' },
  above: { mark: 'i', cls: 'info', text: 'Above the daily need, under the safe ceiling' },
  more: { mark: '!', cls: 'more', text: 'More than your body absorbs' },
  over: { mark: '✕', cls: 'over', text: 'Above the safe ceiling' },
  under: { mark: 'i', cls: 'info', text: 'Below the doses used in studies' },
  in: { mark: '✓', cls: 'ok', text: 'In the range used in studies' },
  beyond: { mark: '!', cls: 'more', text: 'Above the doses used in studies' },
  unknown: { mark: '?', cls: 'info', text: 'Dose not confirmed from the label' },
};

interface Zone { cls: string; label: string; sub: string }

/** The zones of a check's scale and the figures between them. */
function scaleOf(c: DoseCheck): { zones: Zone[]; edges: number[] } {
  const low = c.low ?? 0;
  if (c.basis === 'studied') {
    return { zones: [{ cls: 'z0', label: 'Below', sub: 'less than studies used' }, { cls: 'z1', label: 'Studied range', sub: 'the doses trials tested' }, { cls: 'z2', label: 'Above', sub: 'more than studies used' }], edges: [low, c.high ?? low] };
  }
  if (c.high === null) return { zones: [{ cls: 'z1', label: 'Daily need', sub: 'covers what the body requires' }, { cls: 'z2', label: 'Extra', sub: 'no ceiling has been set' }], edges: [low] };
  // Magnesium: the ceiling counts supplements only and sits below the daily need, which food mostly covers.
  if (c.high <= low) return { zones: [{ cls: 'z1', label: 'Within the limit', sub: 'for supplements' }, { cls: 'z3', label: 'Too much', sub: 'above the safe ceiling' }], edges: [c.high] };
  return { zones: [{ cls: 'z1', label: 'Daily need', sub: 'covers what the body requires' }, { cls: 'z2', label: 'Extra', sub: 'safe, often not all absorbed' }, { cls: 'z3', label: 'Too much', sub: 'above the safe ceiling' }], edges: [low, c.high] };
}

/** Where a daily amount sits, in percent of the bar: zones are equally wide and the mark moves within its zone. */
function positionOf(c: DoseCheck, daily: number): number {
  const { zones, edges } = scaleOf(c);
  const w = 100 / zones.length;
  let k = edges.findIndex((e) => daily <= e);
  if (k < 0) k = zones.length - 1;
  const lower = k === 0 ? 0 : edges[k - 1];
  const upper = k < edges.length ? edges[k] : null;
  const frac = upper === null ? Math.min(1, (daily - lower) / (lower || 1)) * 0.8 : (daily - lower) / (upper - lower || 1);
  return (k + Math.min(0.94, Math.max(0.06, frac))) * w;
}

export function doseFor(c: DoseCheck | null | undefined, url: string): DoseProduct | null {
  const p = c?.products.find((x) => x.url === url) ?? null;
  return c && c.low !== null && p && p.state !== 'unknown' && p.daily !== null ? p : null;
}

function wordsFor(c: DoseCheck, state: DoseState): { mark: string; cls: string; text: string } {
  if (state === 'within' && c.basis === 'official' && c.high !== null && c.high <= (c.low ?? 0)) return { ...WORDS.within, text: 'Under the safe ceiling for supplements' };
  return WORDS[state];
}

/**
 * The scale of one product: verdict, a bar with a dot where the pick sits, and the reference figures under it.
 * `teaser` is the smaller form for the home page slider.
 */
export function doseScale(c: DoseCheck, p: DoseProduct, teaser = false): string {
  const { zones, edges } = scaleOf(c);
  const w = wordsFor(c, p.state);
  const at = positionOf(c, p.daily as number).toFixed(1);
  const cols = `grid-template-columns:repeat(${zones.length},1fr)`;
  const bar = zones.map((z) => `<i class="ww-dose-${z.cls}"></i>`).join('');
  const marks = edges.map((e, i) => `<span style="left:${(((i + 1) * 100) / zones.length).toFixed(1)}%">${fmt(e)} ${esc(c.unit)}</span>`).join('');
  // The pick's place is a dot on the bar; its amount is stated in the card's own line, and only the reference
  // figures sit under the ruler.
  const mark = `<span class="ww-dose-dot" style="left:${at}%" title="${fmt(p.daily as number)} ${esc(c.unit)} a day"></span>`;
  return `<div class="ww-dose ww-dose-${w.cls}${teaser ? ' ww-dose-teaser' : ''}">
          <div class="ww-dose-head"><span class="ww-dose-mark" aria-hidden="true">${w.mark}</span><span>${esc(w.text)}</span></div>
          <div class="ww-dose-bar" style="${cols}">${bar}${mark}</div>
          <div class="ww-dose-edges">${marks}</div>${!teaser && p.also.length ? `\n          <p class="ww-dose-also"><b>Also check:</b> ${esc(p.also.join('; '))}.</p>` : ''}
        </div>`;
}

/** What the zones mean, the note behind the figures and where they come from; shown once per section. */
export function doseLegend(c: DoseCheck): string {
  const { zones } = scaleOf(c);
  return `<div class="ww-dose-zones" style="grid-template-columns:repeat(${zones.length},1fr)">${zones.map((z) => `<div><b>${z.label}</b>${z.sub}</div>`).join('')}</div>
          ${c.note ? `<p class="ww-dose-note">${esc(c.note)}</p>` : ''}
          <p class="ww-dose-src">The scale shows each pick's daily amount at the label's directions. Figures: ${esc(c.source)}. Zones are not drawn to scale.</p>`;
}

/** "100 mg per capsule" or "500 mg per tablet, 2 a day". */
export function doseLine(c: DoseCheck, p: DoseProduct): string {
  return `${fmt(p.amount as number)} ${c.unit} per ${p.per}${p.servings > 1 ? `, ${fmt(p.servings)} a day` : ''}`;
}

/** The owner's report: every page with a pick outside the comfortable range, worst first. */
export function doseReport(checks: DoseCheck[]): { pages: number; products: number; unknown: number; counts: Record<string, number>; outliers: { slug: string; name: string; basis: string; product: string; state: DoseState; daily: number | null; unit: string; low: number | null; high: number | null; also: string[] }[]; noReference: string[] } {
  const counts: Record<string, number> = {};
  const outliers: ReturnType<typeof doseReport>['outliers'] = [];
  const noReference: string[] = [];
  let products = 0;
  let unknown = 0;
  for (const c of checks) {
    if (c.low === null) noReference.push(c.slug);
    for (const p of c.products) {
      products += 1;
      counts[p.state] = (counts[p.state] ?? 0) + 1;
      if (p.state === 'unknown') unknown += 1;
      if (['over', 'more', 'beyond', 'under'].includes(p.state) || p.also.length) outliers.push({ slug: c.slug, name: c.name, basis: c.basis, product: p.name, state: p.state, daily: p.daily, unit: c.unit, low: c.low, high: c.high, also: p.also });
    }
  }
  const rank: Record<string, number> = { over: 0, beyond: 1, more: 2, under: 3 };
  outliers.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.slug.localeCompare(b.slug));
  return { pages: checks.length, products, unknown, counts, outliers, noReference };
}
