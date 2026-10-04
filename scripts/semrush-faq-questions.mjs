#!/usr/bin/env node
/**
 * Turn a Semrush "Keyword Strategy Builder" export (url, keyword, volume, keyword difficulty, intent) into the
 * question list the supplement FAQ writer works from: data/faq-questions.json = { "<slug>": [{ q, v, kd }, ...] }.
 *
 *   node scripts/semrush-faq-questions.mjs path/to/keyword_strategy.csv
 *
 * Keywords Semrush mapped to a supplement page stay with that page. Keywords it could not place (mapped to the home
 * page) are assigned to the supplement whose name or alias they contain, longest name first. Brand terms, other
 * languages, "where to buy" and plain "<name> benefits" phrases (sections the page already has) are dropped; near
 * duplicates collapse to the highest-volume phrasing; each supplement keeps its top 10 by search volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: node scripts/semrush-faq-questions.mjs <keyword_strategy.csv>');
  process.exit(1);
}

/** Extra ways people name a supplement (lower case); the slug prefix identifies the supplement. */
const ALIASES = {
  'coenzyme-q10': ['coq10', 'q10', 'ubiquinol'],
  'vitamin-d3': ['vitamin d', 'd3'],
  'omega-3-fatty-acids': ['omega 3', 'omega-3', 'fish oil', 'omega three', 'epa', 'dha'],
  'b-vitamins': ['b complex', 'vitamin b', 'b12', 'b6', 'b-complex'],
  'whey-protein-isolate': ['whey isolate', 'isolate'],
  'protein-powder-whey': ['whey protein', 'whey'],
  'protein-powder-casein': ['casein'],
  'green-superfood-powders': ['greens powder', 'super greens', 'superfood powder', 'greens supplement', 'powdered greens'],
  'electrolyte-drinks': ['electrolyte', 'electrolytes'],
  'sleep-aids': ['sleep aid', 'sleep supplement', 'sleep aids'],
  'pre-workout-supplements': ['pre workout', 'pre-workout', 'preworkout'],
  'meal-replacement-shakes': ['meal replacement', 'meal shakes'],
  'weight-management-supplements': ['weight loss supplement', 'weight loss pills', 'diet pills', 'weight loss vitamins', 'metabolism booster', 'fat burner'],
  'womens-health-supplements': ['vitamins for women', 'multivitamin for women', 'vitamins for females', 'women supplement'],
  'mens-health-supplements': ['vitamins for men', 'supplements for men', 'multivitamins for men', 'men food supplement'],
  'hmb-beta-hydroxy-beta-methylbutyrate': ['hmb'],
  'msm-methylsulfonylmethane': ['msm'],
  'zma-zinc-magnesium-aspartate': ['zma'],
  'l-glutamine': ['glutamine'],
  'l-carnitine': ['carnitine'],
  'l-theanine': ['theanine'],
  'goji-berry-supplements': ['goji'],
  'acai-berry-supplements': ['acai'],
  'pomegranate-supplements': ['pomegranate'],
  'cranberry-supplements': ['cranberry'],
  'blueberry-supplements': ['blueberry', 'blueberries'],
  'saffron-extracts': ['saffron'],
  'garlic-extract': ['aged garlic', 'garlic extract'],
  curcumin: ['turmeric'],
  'fiber-supplements': ['fiber', 'fibre', 'psyllium'],
  'joint-health-supplements': ['joint supplement', 'joint pain', 'joint health', 'joint care', 'joint food'],
  'heart-health-supplements': ['heart health', 'heart supplement', 'cardio health'],
  'thyroid-support-supplements': ['thyroid'],
  'glucose-management-supplements': ['blood sugar', 'blood glucose', 'glucose'],
  'urinary-tract-support-supplements': ['urinary', 'bladder'],
  'prenatal-vitamins': ['prenatal'],
  'childrens-vitamins': ['kids vitamins', 'vitamins for kids', "children's vitamins", 'childrens vitamins', 'vitamins for children'],
  multivitamins: ['multivitamin', 'multi vitamin'],
  probiotics: ['probiotic'],
  'keto-supplements': ['keto', 'ketone'],
  'paleo-supplements': ['paleo'],
  'vegan-supplements': ['vegan supplement', 'vegetarian', 'vegans'],
  'stress-relief-supplements': ['stress supplement', 'supplements for stress', 'anxiety', 'stress relief'],
  'nitric-oxide-boosters': ['nitric oxide', 'nitric boost'],
  'energy-bars': ['energy bar'],
  'protein-bars': ['protein bar'],
  'mixed-plant-proteins': ['plant based protein', 'plant protein', 'vegan protein'],
  'rice-protein': ['rice protein'],
  'pea-protein': ['pea protein'],
  'hemp-protein': ['hemp protein', 'hemp seeds protein'],
  'soy-protein': ['soy protein', 'soya protein'],
  'protein-powder-egg': ['egg protein', 'egg white protein'],
  'mct-oil': ['mct'],
  'apple-cider-vinegar': ['cider vinegar', 'acv'],
  'ginkgo-biloba': ['ginkgo'],
  'rhodiola-rosea': ['rhodiola'],
  'vitamin-k': ['k2', 'vitamin k2'],
  'folic-acid': ['folate'],
  'beta-alanine': ['beta alanine', 'alanine'],
  'vitamin-c': ['ascorbic'],
  'vitamin-e': ['tocopherol'],
  magnesium: ['magnesium'],
  calcium: ['calcium'],
  zinc: ['zinc'],
  iron: ['iron'],
  potassium: ['potassium'],
  creatine: ['creatine'],
  collagen: ['collagen'],
  biotin: ['biotin'],
  ashwagandha: ['ashwagandha'],
  'milk-thistle': ['milk thistle'],
  spirulina: ['spirulina'],
  chlorella: ['chlorella'],
  inositol: ['inositol', 'myo inositol'],
  choline: ['choline', 'alpha gpc'],
  selenium: ['selenium'],
  iodine: ['iodine'],
  copper: ['copper'],
  boron: ['boron'],
  chromium: ['chromium'],
  manganese: ['manganese'],
  lutein: ['lutein'],
  lycopene: ['lycopene'],
  quercetin: ['quercetin'],
  resveratrol: ['resveratrol'],
  echinacea: ['echinacea'],
  ginseng: ['ginseng'],
  ginger: ['ginger'],
  garlic: ['garlic'],
  'bee-pollen': ['bee pollen'],
  'saw-palmetto': ['saw palmetto'],
  glucosamine: ['glucosamine', 'chondroitin'],
  citrulline: ['citrulline'],
  'olive-leaf-extract': ['olive leaf', 'olive leaves'],
  'green-tea-extract': ['green tea'],
  'zinc-citrate': ['zinc citrate'],
  'casein-protein': ['micellar casein', 'casein protein'],
};

/** Brand and retailer words: a brand query makes a poor FAQ for an ingredient page. */
const BRANDS = /\b(barbell|nature made|relaxium|gold standard|optimum nutrition|hiya|visbiome|kyolic|perfect foods?|quest|garden of life|thorne|nordic naturals|ritual|athletic greens|ag1|bloom|olly|smartypants|one a day|centrum|now foods|pure encapsulations|kirkland|amazon|walmart|costco|cvs|walgreens|gnc|iherb|myprotein|huel|orgain|vega|premier protein|ensure|boost|nature's bounty|natures bounty|solgar|jarrow|life extension|doctor's best|swanson|vitacost|muscletech|cellucor|c4|ghost|alani|transparent labs|legion|bulk|near me|reddit|amazon)\b/i;
const NOT_ENGLISH = /\b(vitaminas|para|ninos|niños|proteinpulver|pulver|suplemento|vitamina|proteina|magnesio|calcio|hierro|zinco|magnésium|vitamine)\b/i;
const STOP = new Set('the a an of for to and in on is are what how does do with best vs or you your my me can i it be take taking supplement supplements per day daily mg should good which when much many why will if from at as by about into than that this'.split(' '));

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const supplements = JSON.parse(fs.readFileSync(path.join(root, 'data/supplements.json'), 'utf8'));
const slugs = supplements.map((s) => s.slug);
const slugByPrefix = (prefix) => slugs.find((s) => s === prefix || s.startsWith(`${prefix}-`) && /^-[0-9a-f]{5}$/.test(s.slice(prefix.length)));

// name and alias -> slug, longest match first so "zinc citrate" beats "zinc" and "whey isolate" beats "whey".
const matchers = [];
for (const s of supplements) {
  const base = s.name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (base.length > 2) matchers.push([base, s.slug]);
}
for (const [prefix, aliases] of Object.entries(ALIASES)) {
  const slug = slugByPrefix(prefix);
  if (!slug) continue;
  for (const a of aliases) matchers.push([a, slug]);
}
matchers.sort((a, b) => b[0].length - a[0].length);
const matchSlug = (kw) => {
  const padded = ` ${kw.replace(/[^a-z0-9]+/g, ' ')} `;
  for (const [needle, slug] of matchers) if (padded.includes(` ${needle} `)) return slug;
  return null;
};

const perSlug = new Map();
const add = (slug, kw, v, kd) => {
  if (!perSlug.has(slug)) perSlug.set(slug, []);
  perSlug.get(slug).push({ q: kw, v, kd });
};

let placed = 0;
let dropped = 0;
for (const r of rows) {
  const kw = (r.keyword || '').toLowerCase().trim();
  const v = Number(r.volume || 0);
  const kd = Number(r['keyword difficulty'] || 0);
  if (!kw || v < 50) continue;
  const url = (r.url || '').replace(/^https?:\/\/aiww\.io/, '');
  let slug = null;
  const m = url.match(/^\/supplement\/([^/?#]+)/);
  if (m) slug = slugs.includes(m[1]) ? m[1] : null;
  else if (url === '/' || url === '') slug = matchSlug(kw);
  else continue; // blog, quiz and research keywords belong to those pages
  if (!slug) continue;
  if (BRANDS.test(kw) || NOT_ENGLISH.test(kw) || /\b(buy|purchase|price|cheap|coupon|discount|sale|store|shop)\b/.test(kw)) { dropped++; continue; }
  add(slug, kw, v, kd);
  placed++;
}

// Drop phrases the page already answers with a section, collapse near duplicates, keep the top 10.
const out = {};
for (const [slug, list] of perSlug) {
  const sup = supplements.find((s) => s.slug === slug);
  const name = sup.name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  const nameKey = tokens(name).join(' ');
  const seen = new Map();
  for (const item of list.sort((a, b) => b.v - a.v || a.kd - b.kd)) {
    const toks = tokens(item.q);
    const key = toks.filter((t) => !nameKey.split(' ').includes(t)).sort().join(' ');
    // Bare name, "<name> supplement(s)", "<name> benefits" and "benefits of <name>" are already sections on the page.
    if (!key || key === 'benefits' || key === 'benefit' || key === 'advantages' || key === 'uses') continue;
    if (seen.has(key)) continue;
    seen.set(key, item);
  }
  const top = [...seen.values()].slice(0, 10);
  if (top.length) out[slug] = top;
}

const target = path.join(root, 'data/faq-questions.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
const covered = Object.keys(out).length;
console.log(`placed ${placed} keywords (${dropped} dropped as brand/retail/other-language); ${covered} of ${slugs.length} supplements have questions`);
console.log('without questions:', slugs.filter((s) => !out[s]).join(', ') || 'none');

function tokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t)).map(stem);
}
function stem(t) {
  return t.replace(/(ies)$/, 'y').replace(/(s|es)$/, '').replace(/^(.{4,}?)(ing|ed)$/, '$1');
}
function parseCsv(text) {
  const lines = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; lines.push(row); row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); lines.push(row); }
  const header = lines.shift().map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  return lines.filter((l) => l.length > 1).map((l) => Object.fromEntries(header.map((h, i) => [h, l[i] ?? ''])));
}
