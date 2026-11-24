/**
 * Swap plan: for one supplement page, which tested products could take the place of an untested pick.
 *
 * The owner's three rules (24 November 2026):
 *  1. Same thing, in range, in stock: the tested product is the same supplement and form as the page, iHerb sells
 *     it now, and (checked when a swap is applied) its dose passes the page's dose check.
 *  2. Content tests count more than doping tests. Programmes that test what is in the bottle (USP, NSF, IFOS and
 *     its siblings) may be used on any page; banned-substance programmes (Informed Sport/Choice/Protein, BSCG) only
 *     on sports pages.
 *  3. At most two swaps a page, and a pick that already carries a tested or studied line is never replaced.
 *
 * planSwaps only proposes: it finds listed products whose name carries the page's subject, takes the iHerb pages
 * found for each (from iHerb's product sitemap), asks the Claude API which iHerb result is that listed product and whether it fits the page, and stores the plan in
 * meta under "swap:<slug>". Nothing on the site changes here.
 */
import { CERTIFIED } from './certified';
import { SOURCES, type Listing } from './checks';
import { claudeJson, type ClaudeEnv } from './claude';
import { getSupplementBySlug, setMeta } from './db';
import { MAX_PICKS, STATE_RANK, doseFor, getDoseCheck } from './dose';
import type { IherbProduct } from './products';
import { STUDIED } from './studied';

type SwapEnv = ClaudeEnv & { DB: D1Database };
const CONTENT = new Set(['paid', 'usp', 'nsf-173', 'nsf-sport', 'ifos', 'ikos', 'iaos', 'ipro', 'nutrastrong']);
const SPORTS_PAGE = /creatine|protein|whey|casein|bcaa|amino|pre-?workout|electrolyte|beta-?alanine|hmb|citrulline|glutamine|carnitine|arginine|nitric|collagen|mct|beet/i;
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const MARK = new Map(SOURCES.map((s) => [s.key, s.mark]));

export interface SwapProposal { source: string; out: { url: string; brand: string; name: string }; in: { url: string; brand: string; name: string; image: string }; mark: string; listed: string; link: string; why: string; stock: string; rating: number; ratings: number }
interface Shop { isDiscontinued?: boolean; isAvailableToPurchase?: boolean; stockStatusMessage?: string; averageRating?: number; totalRatingCount?: number }
export interface SwapPlan { skipped?: string[]; lookups?: { key: string; source: string; brand: string; product: string }[]; slug: string; name: string; at: string; tested_now: number; candidates: number; searched: number; proposals: SwapProposal[]; note?: string }

const SYSTEM = `You help a supplement site replace untested product picks with independently tested ones. You get one supplement page, and a numbered list of candidates. Each candidate is a product on a certifier's list, with the search results iHerb returned for it.
For each candidate decide:
- fits: the listed product is the SAME KIND of supplement as the page (same active ingredient as the page's subject, sold mainly for it, in a normal form for it). A blend where the page's subject is a minor ingredient, a product for children or pets, a bar or a drink when the page is about a supplement, or a different ingredient does not fit.
- result: the index of the iHerb search result that is THE SAME PRODUCT as the listed one (same brand, same product line, same form, same strength where stated; another flavour or pack size is fine), or -1 if none is. Never pick a result of another brand or another product of the same brand.
A different chemical form that is sold as its own supplement does not fit (acetyl-L-carnitine on an L-carnitine page, niacinamide on a niacin page). A combination does not fit: a name with "+", "plus", "complex", "with <another active>", or a branded formula built around several ingredients, unless the page itself is about that combination.
Be strict: when unsure, answer fits false or result -1. Give one short plain reason.`;
const SCHEMA = { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'fits', 'result', 'why'], properties: { n: { type: 'integer' }, fits: { type: 'boolean' }, result: { type: 'integer' }, why: { type: 'string' } } } } } };

/** What the caller found for a candidate on iHerb. iHerb refuses search requests, so its public product sitemap is read outside the Worker and the matches are handed in. */
export interface Supplied { key: string; results: IherbProduct[] }
export const candidateKey = (l: Listing) => `${l.source}|${l.brand}|${l.product}`;

/**
 * Without `supplied` this returns the candidates to look up (plan.lookups) and stops. With it, the plan is made from
 * the iHerb pages the caller found for each candidate.
 */
export async function planSwaps(env: SwapEnv, slug: string, supplied?: Supplied[], forced: string[] = [], listings?: Listing[]): Promise<SwapPlan> {
  const sup = await getSupplementBySlug(env.DB, slug);
  if (!sup) throw new Error(`no supplement ${slug}`);
  const picks = sup.products.slice(0, MAX_PICKS);
  const marked = (await env.DB.prepare("SELECT url FROM pick_marks WHERE state = 'on'").all<{ url: string }>()).results.map((r) => r.url);
  // `forced` are picks that must leave whatever they carry: gone from the shop, or failed a test. They leave first.
  const tested = new Set([...marked, ...Object.keys(CERTIFIED)].filter((u) => !forced.includes(u)));
  const plan: SwapPlan = { slug, name: sup.name, at: new Date().toISOString(), tested_now: picks.filter((p) => tested.has(p.url)).length, candidates: 0, searched: 0, proposals: [] };
  const done = async () => { await setMeta(env.DB, `swap:${slug}`, JSON.stringify(plan)); return plan; };
  const must = picks.filter((p) => forced.includes(p.url)).length;
  const room = Math.max(must, Math.min(2, picks.filter((p) => !tested.has(p.url) && !STUDIED[p.url]).length, 2 - Math.min(2, plan.tested_now)));
  if (room <= 0 || !picks.length) { plan.note = picks.length ? 'already has two tested picks, or nothing replaceable' : 'no picks'; return done(); }

  // The page's subject as it would appear in a product name: "Magnesium", "Vitamin D", "Omega-3", "Creatine".
  const subject = sup.name.replace(/\(.*?\)/g, '').replace(/\b(supplements?|extracts?|fatty acids|powders?)\b/gi, '').trim();
  const key = norm(subject);
  if (key.length < 4) { plan.note = 'the page name is too short to match safely'; return done(); }
  const sports = SPORTS_PAGE.test(sup.name) || /protein/i.test(sup.category);
  const have = new Set(picks.map((p) => norm(`${p.brand} ${p.name}`)));
  // The candidates come from the caller, who holds one downloaded copy of the lists. Reading all ten thousand
  // listings here for every page is what used up the database's daily allowance on 24 November 2026.
  if (!listings) { plan.note = 'the caller must supply the candidate listings (GET /api/admin/checks/listings once, then filter)'; return plan; }
  const rows = listings
    .filter((l) => (CONTENT.has(l.source) || sports) && norm(l.product).includes(key))
    // A privately sourced test older than five years earns no line, so it is no reason to bring a product in.
    .filter((l) => l.source !== 'paid' || Math.max(0, ...(l.link.match(/(19|20)\d\d/g) ?? []).map(Number)) >= new Date().getUTCFullYear() - 5);
  // One candidate a brand: content programmes first, then brands this page already picks from.
  const siteBrands = new Set(picks.map((p) => norm(p.brand ?? '')));
  const score = (l: Listing) => (l.source === 'paid' ? 0.5 : 0) + (CONTENT.has(l.source) ? 0 : 2) + (siteBrands.has(norm(l.brand)) ? 0 : 1) + l.product.length / 1000;
  const byBrand = new Map<string, Listing>();
  for (const l of rows.sort((a, b) => score(a) - score(b))) if (!byBrand.has(norm(l.brand)) && !have.has(norm(`${l.brand} ${l.product}`))) byBrand.set(norm(l.brand), l);
  const candidates = [...byBrand.values()].slice(0, 7);
  plan.candidates = rows.length;
  if (!candidates.length) { plan.note = 'no listed product carries this page\'s subject in its name'; return done(); }

  if (!supplied) { plan.lookups = candidates.map((l) => ({ key: candidateKey(l), source: l.source, brand: l.brand, product: l.product })); return plan; }
  const given = new Map(supplied.map((x) => [x.key, x.results]));
  const found: { l: Listing; results: IherbProduct[] }[] = candidates.map((l) => ({ l, results: (given.get(candidateKey(l)) ?? []).slice(0, 5) })).filter((f) => f.results.length);
  plan.searched = found.length;
  if (!found.length) { plan.note = 'none of the listed products was found on iHerb'; return done(); }

  const user = `PAGE: ${sup.name} (${sup.category})\nCurrent picks: ${picks.map((p) => `${p.brand} ${p.name}`).join('; ')}\n\nCANDIDATES\n${found.map((f, n) => `${n}. Listed by ${MARK.get(f.l.source)}: ${f.l.brand} — ${f.l.product}\n${f.results.map((r, i) => `   result ${i}: ${r.brand} | ${r.name}`).join('\n')}`).join('\n')}`;
  const out = await claudeJson<{ candidates: { n: number; fits: boolean; result: number; why: string }[] }>(env, SYSTEM, user, SCHEMA, { maxTokens: 3000 });
  const dose = await getDoseCheck(env.DB, slug);
  // Who leaves: the untested, unstudied pick that ranks last on the page (worst dose verdict, then lowest place).
  const leaving = picks.map((p, i) => ({ p, i, rank: STATE_RANK[doseFor(dose, p.url)?.state ?? 'unknown'] })).filter((x) => forced.includes(x.p.url) || (!tested.has(x.p.url) && !STUDIED[x.p.url])).sort((a, b) => Number(forced.includes(b.p.url)) - Number(forced.includes(a.p.url)) || b.rank - a.rank || b.i - a.i);
  const taken = new Set(picks.map((p) => p.url));
  const skipped: string[] = [];
  for (const c of out.candidates) {
    if (plan.proposals.length >= room) break;
    const f = found[c.n];
    const r = f && c.fits && c.result >= 0 ? f.results[c.result] : undefined;
    if (f && (!c.fits || c.result < 0)) skipped.push(`${f.l.brand} ${f.l.product}: ${c.why}`);
    if (f && r && taken.has(r.url)) skipped.push(`${f.l.brand} ${f.l.product}: already a pick on this page`);
    if (!f || !r || taken.has(r.url) || norm(r.brand) !== norm(f.l.brand) && !norm(r.brand).startsWith(norm(f.l.brand).slice(0, 5))) continue;
    // Rule 1, "iHerb sells it now": the stock state comes with the page the caller found (iHerb answers the Worker with 403).
    const shop = (r as IherbProduct & { shop?: Shop }).shop;
    if (!shop) { skipped.push(`${f.l.brand} ${f.l.product}: no stock information`); continue; }
    if (shop.isDiscontinued || shop.isAvailableToPurchase === false) { skipped.push(`${f.l.brand} ${f.l.product}: ${shop.stockStatusMessage || 'not available'}`); continue; }
    const gone = leaving[plan.proposals.length];
    if (!gone) break;
    taken.add(r.url);
    plan.proposals.push({ out: { url: gone.p.url, brand: gone.p.brand ?? '', name: gone.p.name }, in: { url: r.url, brand: r.brand, name: r.name, image: r.image }, source: f.l.source, mark: MARK.get(f.l.source) ?? f.l.source, listed: f.l.product, link: f.l.link, why: c.why, stock: shop.stockStatusMessage ?? '', rating: shop.averageRating ?? 0, ratings: shop.totalRatingCount ?? 0 });
  }
  plan.skipped = skipped;
  if (!plan.proposals.length) plan.note ??= 'no listed product was both on iHerb in stock and a fit for the page';
  return done();
}
