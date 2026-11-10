/**
 * Studied dose ranges from published research, for supplements that have no official daily need.
 *
 * For one supplement this searches PubMed for reviews, meta-analyses and trials, gives their abstracts to the Claude
 * API and asks for the range of daily doses those papers report, as a quantity a product label states (EPA plus DHA,
 * curcuminoids, a standardised extract). The model must quote the sentence each figure comes from, and the code checks
 * every quote against the abstract it names: a figure whose quote is not in the paper, or whose number is not in the
 * quote, is thrown away. A range needs two such figures from two different papers.
 *
 * A range found this way is a draft. It is used by the dose check (src/dose.ts) only after the owner route approves
 * it, so each one is read by a person first.
 */
import { claudeJson } from './claude';
import type { Supplement } from './db';
import { pubmedSummaries, searchPubmedRelevant, pubmedAbstracts, type ResearchEnv } from './research';

export interface RefEvidence {
  pmid: string;
  title: string;
  /** The sentence of the abstract the figure was read from, word for word. */
  quote: string;
  /** The daily dose that sentence states, in the reference unit. */
  dose: number;
}

export interface DoseRef {
  slug: string;
  name: string;
  status: 'draft' | 'approved' | 'none';
  /** Why no range was found (status "none"). */
  reason: string;
  /** What the doses measure, as a label would state it: "EPA plus DHA", "curcuminoids", "root extract". */
  marker: string;
  unit: string;
  low: number | null;
  high: number | null;
  /** How to read the quantity from a Supplement Facts label. */
  labelRule: string;
  evidence: RefEvidence[];
  /** The PubMed search that was run. */
  term: string;
  at: string;
}

const planSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    researchable: { type: 'boolean', description: 'false when the page is a category of products (sleep aids, multivitamins, protein bars, weight-management supplements) or a food rather than one supplement with its own dosing studies.' },
    reason: { type: 'string', description: 'One short sentence when researchable is false; empty otherwise.' },
    names: { type: 'string', description: 'The supplement as PubMed titles name it, as an OR list of 1 to 3 names in quotes, e.g. "ashwagandha" OR "Withania somnifera". Empty when not researchable.' },
  },
  required: ['researchable', 'reason', 'names'],
} as const;

const refSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true only when at least two of the papers state daily oral doses of the same quantity.' },
    reason: { type: 'string', description: 'When found is false: why (one sentence). Empty otherwise.' },
    marker: { type: 'string', description: 'What the doses measure, named as a product label would: "EPA plus DHA", "curcuminoids", "standardised root extract", "silymarin", "the powder itself". At most six words.' },
    unit: { type: 'string', description: 'mg, g, mcg, IU, mL, FU (fibrinolytic units) or "billion CFU". One unit for every dose.' },
    label_rule: { type: 'string', description: 'One sentence telling a reader of a Supplement Facts label which line(s) give this quantity, and when a product must be left out (for example a plain herb powder when the doses are of a standardised extract).' },
    evidence: {
      type: 'array',
      description: 'Three to six daily doses the papers report for this quantity, covering the lowest and the highest in ordinary oral use. Skip single loading doses, intravenous use and doses for children.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pmid: { type: 'string' },
          quote: { type: 'string', description: 'The sentence (or part of it, at most 240 characters) of that abstract that states the dose, copied character for character.' },
          dose: { type: 'number', description: 'The DAILY dose that sentence states, converted to the unit above (2 g twice daily = 4000 mg).' },
        },
        required: ['pmid', 'quote', 'dose'],
      },
    },
  },
  required: ['found', 'reason', 'marker', 'unit', 'label_rule', 'evidence'],
} as const;

const PLAN_SYSTEM = 'You help a consumer supplement site decide what to look up in PubMed. Answer about the supplement named, nothing else.';

const REF_SYSTEM = `You read PubMed abstracts for a consumer supplement site and report the daily oral doses used in human studies of ONE supplement.

Rules:
- Use only the abstracts given. Never use a dose you remember from elsewhere.
- Choose one quantity that product labels state, and report every dose as that quantity. If the papers dose a standardised extract, the quantity is the extract (or its marker compound when the abstracts give that), not the whole plant.
- Every dose needs the sentence it comes from, copied character for character from the abstract of the paper you name. A dose you cannot quote is not reported.
- Report daily doses in ordinary use by adults. Convert a divided dose to its daily total and say nothing you cannot show.
- A range stated in one sentence of a review or meta-analysis ("doses ranged from 500 to 2000 mg/day") counts as two doses: report its lower and its upper end, each with that sentence.
- If the abstracts give fewer than two doses of the same quantity, answer found: false.`;

const norm = (s: string) => s.toLowerCase().replace(/[‐-―−]/g, '-').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Whether the quote is in the abstract and names the dose (as stated, or in the neighbouring unit: 2 g for 2000 mg). */
function supported(abstract: string, quote: string, dose: number): boolean {
  const q = norm(quote).replace(/^["“”'…. ]+|["“”'…. ]+$/g, '');
  if (q.length < 12 || !norm(abstract).includes(q)) return false;
  const digits = q.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const numbers = [...digits.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.001);
  // The dose itself, the same amount in grams or micrograms, or a divided dose whose parts are stated (500 mg twice daily).
  return numbers.some((n) => same(n, dose) || same(n * 1000, dose) || same(n / 1000, dose) || [2, 3, 4].some((k) => same(n * k, dose) || same(n * 1000 * k, dose)));
}

const round = (v: number) => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/** Look the supplement up in PubMed and store what the papers support as a draft (or the reason nothing was found). */
export async function researchReference(env: ResearchEnv, sup: Supplement): Promise<DoseRef> {
  const base: DoseRef = { slug: sup.slug, name: sup.name, status: 'none', reason: '', marker: '', unit: '', low: null, high: null, labelRule: '', evidence: [], term: '', at: new Date().toISOString() };
  const save = async (ref: DoseRef) => {
    const before = await getDoseRef(env.DB, ref.slug);
    if (before?.status === 'approved') return before; // an approved range is replaced only by hand
    await env.DB.prepare("INSERT INTO dose_refs (slug, json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (slug) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").bind(ref.slug, JSON.stringify(ref)).run();
    return ref;
  };

  const plan = await claudeJson<{ researchable: boolean; reason: string; names: string }>(env, PLAN_SYSTEM, `Supplement page: ${sup.name} (category: ${sup.category})`, planSchema, { tier: 'fast', maxTokens: 400 });
  if (!plan.researchable || !plan.names.trim()) return save({ ...base, reason: plan.reason.trim() || 'not a single supplement with its own dosing studies' });

  // Each name gets its own field tag: "(a OR b)[Title]" would tag only the last one and let the others match anything.
  const names = plan.names.split(/\s+OR\s+/i).map((n) => n.trim().replace(/^\(+|\)+$/g, '')).filter(Boolean);
  const tagged = (field: string) => `(${names.map((n) => `${n}[${field}]`).join(' OR ')})`;
  const about = '(dose[Title/Abstract] OR dosage[Title/Abstract] OR doses[Title/Abstract] OR "mg/day"[Title/Abstract] OR "mg daily"[Title/Abstract] OR "g/day"[Title/Abstract] OR supplementation[Title/Abstract])';
  const kinds = '(meta-analysis[pt] OR systematic review[pt] OR randomized controlled trial[pt]) AND humans[mh]';
  let term = `${tagged('Title')} AND ${about} AND ${kinds}`;
  let pmids = await searchPubmedRelevant(env, term, 16);
  if (pmids.length < 6) {
    // Few papers name it in the title: look in the abstracts too, and keep whatever the title search found first.
    term = `${tagged('Title/Abstract')} AND ${about} AND ${kinds}`;
    pmids = [...new Set([...pmids, ...(await searchPubmedRelevant(env, term, 16))])].slice(0, 16);
  }
  if (pmids.length < 2) return save({ ...base, term, reason: `PubMed lists ${pmids.length} matching ${pmids.length === 1 ? 'paper' : 'papers'}` });
  const [abstracts, summaries] = await Promise.all([pubmedAbstracts(env, pmids), pubmedSummaries(env, pmids)]);
  const titles = new Map(summaries.map((s) => [s.uid, s.title]));
  const papers = pmids.filter((id) => (abstracts.get(id) ?? '').length > 200);
  if (papers.length < 2) return save({ ...base, term, reason: 'too few of the papers have an abstract' });

  const user = [`Supplement: ${sup.name}`, '', ...papers.map((id) => `PMID ${id}: ${titles.get(id) ?? ''}\n${abstracts.get(id)}`)].join('\n\n');
  const out = await claudeJson<{ found: boolean; reason: string; marker: string; unit: string; label_rule: string; evidence: { pmid: string; quote: string; dose: number }[] }>(env, REF_SYSTEM, user, refSchema, { tier: 'main', maxTokens: 3000 });
  if (!out.found) return save({ ...base, term, reason: out.reason.trim() || 'the papers do not state comparable doses' });

  const evidence: RefEvidence[] = [];
  for (const e of out.evidence ?? []) {
    const id = String(e.pmid).replace(/\D/g, '');
    const abstract = abstracts.get(id);
    if (!abstract || !(e.dose > 0) || !supported(abstract, e.quote, e.dose)) continue;
    evidence.push({ pmid: id, title: (titles.get(id) ?? '').replace(/\.$/, ''), quote: e.quote.trim().slice(0, 260), dose: round(e.dose) });
  }
  const sources = new Set(evidence.map((e) => e.pmid));
  // Two papers, or one review or meta-analysis that itself states the range of the trials it pooled.
  const kindOf = new Map(summaries.map((x) => [x.uid, (x.pubtype ?? []).join(' ').toLowerCase()]));
  const pooled = [...sources].some((id) => /meta-analysis|systematic review|review/.test(kindOf.get(id) ?? ''));
  if (evidence.length < 2 || (sources.size < 2 && !pooled)) return save({ ...base, term, reason: `only ${evidence.length} of ${out.evidence?.length ?? 0} reported doses could be matched to a sentence of their paper` });
  const doses = evidence.map((e) => e.dose);
  const low = Math.min(...doses);
  const high = Math.max(...doses);
  if (!out.unit.trim() || !out.marker.trim() || high / low > 60) return save({ ...base, term, evidence, reason: 'the doses found are too far apart to be one range' });
  return save({ ...base, status: 'draft', marker: out.marker.trim().slice(0, 60), unit: out.unit.trim(), low, high, labelRule: out.label_rule.trim().slice(0, 300), evidence, term });
}

export async function getDoseRef(db: D1Database, slug: string): Promise<DoseRef | null> {
  try {
    const row = await db.prepare('SELECT json FROM dose_refs WHERE slug = ?').bind(slug).first<{ json: string }>();
    return row ? (JSON.parse(row.json) as DoseRef) : null;
  } catch {
    return null;
  }
}

export async function listDoseRefs(db: D1Database): Promise<DoseRef[]> {
  const rows = (await db.prepare('SELECT json FROM dose_refs ORDER BY slug').all<{ json: string }>()).results ?? [];
  return rows.map((r) => { try { return JSON.parse(r.json) as DoseRef; } catch { return null; } }).filter((r): r is DoseRef => !!r);
}

/** Mark drafts as read and fit to use, or take that back. Returns the slugs changed. */
export async function setRefStatus(db: D1Database, slugs: string[], status: 'approved' | 'draft'): Promise<string[]> {
  const changed: string[] = [];
  for (const slug of slugs) {
    const ref = await getDoseRef(db, slug);
    if (!ref || ref.status === 'none' || ref.status === status) continue;
    await db.prepare("UPDATE dose_refs SET json = ?, updated_at = datetime('now') WHERE slug = ?").bind(JSON.stringify({ ...ref, status }), slug).run();
    changed.push(slug);
  }
  return changed;
}

/**
 * A range set by hand from named papers: for a figure a position stand states that the search does not surface. The
 * quotes go through the same test as the automatic ones (the sentence must be in the abstract of the paper named and
 * contain the number), and the range is still a draft until approved.
 */
export async function setManualRef(env: ResearchEnv, sup: Supplement, input: { marker: string; unit: string; labelRule: string; evidence: { pmid: string; quote: string; dose: number }[] }): Promise<DoseRef | { error: string }> {
  const ids = [...new Set(input.evidence.map((e) => String(e.pmid).replace(/\D/g, '')))].filter(Boolean);
  if (!ids.length || !input.marker.trim() || !input.unit.trim()) return { error: 'marker, unit and at least one quoted dose are needed' };
  const [abstracts, summaries] = await Promise.all([pubmedAbstracts(env, ids), pubmedSummaries(env, ids)]);
  const titles = new Map(summaries.map((x) => [x.uid, x.title]));
  const evidence: RefEvidence[] = [];
  for (const e of input.evidence) {
    const id = String(e.pmid).replace(/\D/g, '');
    const abstract = abstracts.get(id);
    if (!abstract || !supported(abstract, e.quote, e.dose)) return { error: `the quote for ${e.dose} is not in the abstract of PMID ${id}, or does not contain that number` };
    evidence.push({ pmid: id, title: (titles.get(id) ?? '').replace(/\.$/, ''), quote: e.quote.trim().slice(0, 260), dose: round(e.dose) });
  }
  const doses = evidence.map((e) => e.dose);
  if (doses.length < 2) return { error: 'two quoted doses are needed: the low and the high end' };
  const ref: DoseRef = { slug: sup.slug, name: sup.name, status: 'draft', reason: '', marker: input.marker.trim().slice(0, 60), unit: input.unit.trim(), low: Math.min(...doses), high: Math.max(...doses), labelRule: input.labelRule.trim().slice(0, 300), evidence, term: 'set by hand', at: new Date().toISOString() };
  await env.DB.prepare("INSERT INTO dose_refs (slug, json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (slug) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").bind(ref.slug, JSON.stringify(ref)).run();
  return ref;
}
