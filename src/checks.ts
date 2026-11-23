/**
 * The weekly product check. It keeps four things about the picks current without anyone doing it by hand:
 *
 *  1. Independent testing: the certifiers' own published lists are downloaded, and each pick is compared with the
 *     entries of its brand. The Claude API judges whether an entry is the same product. A new "independently tested"
 *     line goes live only on an exact match; a near match waits for the owner in the Monday report; a line whose
 *     listing has gone is taken off.
 *  2. The shop: whether each pick is still sold and in stock on iHerb, and whether iHerb has published a batch test.
 *  3. Recalls: recent FDA supplement recalls that name a brand we pick from. Reported, never shown without a person.
 *  4. Swaps: for supplements with no tested pick, listed products that could take a place. Reported for a decision.
 *
 * A run is a queue of small steps (one list, a few brands, a batch of products), taken one at a time by the
 * five-minute cron so no single invocation does much. State lives in meta under "checks:run"; the finished summary
 * in "checks:last" feeds the Monday email (src/report.ts).
 */
import { CERTIFIED } from './certified';
import { claudeJson, type ClaudeEnv } from './claude';
import { getMeta, listSupplements, setMeta, type Supplement } from './db';
import { MAX_PICKS } from './dose';

export interface Listing { source: string; brand: string; product: string; link: string }
interface Source { key: string; mark: string; home: string; load: () => Promise<Listing[]> }
type CheckEnv = ClaudeEnv & { DB: D1Database };

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; WellnessWhizz-listing-check/1.0; +https://aiww.io/how-it-works)' };
const text = async (url: string, init?: RequestInit): Promise<string> => {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.text();
};
const clean = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|â/g, "'").replace(/Â|®|™|â¢|Ⓡ/g, '').replace(/\s+/g, ' ').trim();
const unslug = (s: string) => decodeURIComponent(s).replace(/-/g, ' ').trim();

/** Informed Choice, Sport and Protein publish every certified product as /supplement-search/<brand>/<product> in their sitemap. */
const informed = (host: string, key: string) => async (): Promise<Listing[]> => {
  const xml = await text(`https://${host}/sitemap.xml`);
  return [...xml.matchAll(/<loc>(https:\/\/[^<]+\/supplement-search\/([^/<]+)\/([^/<]+))<\/loc>/g)].map((m) => ({ source: key, brand: unslug(m[2]), product: unslug(m[3]), link: m[1] }));
};

/** Nutrasource programmes (IFOS fish oil and its siblings): a paged JSON list; the brand is the first four letters of the product number. */
const nutrasource = (programme: string, key: string) => async (): Promise<Listing[]> => {
  const base = 'https://certifications.nutrasource.ca/umbraco/surface/NutrasourceContent';
  const brands = new Map<string, string>();
  for (let page = 1; page <= 12; page++) {
    const d = JSON.parse(await text(`${base}/GetFilteredBrands?pageNumber=${page}&pageSize=50&forCertification=${programme}&forInterest=&forCategory=&byName=`)) as { html?: string; totalCount?: number };
    const found = [...(d.html ?? '').matchAll(/results__brand[^>]*><strong><a href="\/certified-products\/brand\?id=([A-Z0-9]+)">([^<]*)</g)];
    for (const m of found) brands.set(m[1], clean(m[2]));
    if (page * 50 >= (d.totalCount ?? 0) || !found.length) break;
  }
  const out: Listing[] = [];
  for (let page = 1; page <= 30; page++) {
    const d = JSON.parse(await text(`${base}/GetFilteredProducts?pageNumber=${page}&pageSize=50&forCertification=${programme}&forInterest=&forCategory=&byName=`)) as { totalCount: number; list: { ProductNum: string; ProductName: string }[] };
    for (const p of d.list ?? []) out.push({ source: key, brand: brands.get(p.ProductNum.slice(0, 4)) ?? '', product: clean(p.ProductName), link: `https://certifications.nutrasource.ca/certified-products/product?id=${p.ProductNum}` });
    if (out.length >= d.totalCount || !(d.list ?? []).length) break;
  }
  return out.filter((l) => l.brand);
};

export const SOURCES: Source[] = [
  {
    key: 'nsf-sport', mark: 'NSF Certified for Sport', home: 'https://www.nsfsport.com/certified-products/',
    load: async () => {
      const html = await text('https://www.nsfsport.com/certified-products/search-results.php');
      return [...html.matchAll(/listing-detail\.php\?id=(\d+)"[\s\S]*?results__product-name">([^<]*)<[\s\S]*?results__company-name">([^<]*)</g)].map((m) => ({ source: 'nsf-sport', brand: clean(m[3]), product: clean(m[2]), link: `https://www.nsfsport.com/certified-products/listing-detail.php?id=${m[1]}` }));
    },
  },
  {
    key: 'nsf-173', mark: 'NSF Contents Certified', home: 'https://info.nsf.org/Certified/Dietary/',
    load: async () => {
      const html = await text('https://info.nsf.org/Certified/Dietary/Listings.asp');
      const out: Listing[] = [];
      // One block per company: its name in a large font, then rows whose first cell is the trade name.
      for (const block of html.split(/<hr noshade><br><table/).slice(1)) {
        const company = clean(/<font size='\+2'>([\s\S]*?)<\/font>/.exec(block)?.[1] ?? '');
        if (!company) continue;
        for (const m of block.matchAll(/<td align="left" valign="top" width="28%">([\s\S]*?)<\/td>/g)) {
          const product = clean(m[1]);
          if (product) out.push({ source: 'nsf-173', brand: company, product, link: `https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=${encodeURIComponent(company.split(/[ ,]/)[0])}` });
        }
      }
      return out;
    },
  },
  { key: 'informed-choice', mark: 'Informed Choice', home: 'https://choice.wetestyoutrust.com', load: informed('choice.wetestyoutrust.com', 'informed-choice') },
  { key: 'informed-sport', mark: 'Informed Sport', home: 'https://sport.wetestyoutrust.com', load: informed('sport.wetestyoutrust.com', 'informed-sport') },
  { key: 'informed-protein', mark: 'Informed Protein', home: 'https://protein.wetestyoutrust.com', load: informed('protein.wetestyoutrust.com', 'informed-protein') },
  {
    key: 'bscg', mark: 'BSCG Certified Drug Free', home: 'https://www.bscg.org/certified-drug-free-database',
    load: async () => {
      const rows = JSON.parse(await text('https://www.bscg.org/load_products', { method: 'POST' })) as { company: string; product: string; program: string; company_slug: string; product_slug: string }[];
      const seen = new Set<string>();
      return rows.filter((r) => r.program === '1' && !seen.has(`${r.company}|${r.product}`) && seen.add(`${r.company}|${r.product}`)).map((r) => ({ source: 'bscg', brand: clean(r.company), product: clean(r.product), link: 'https://www.bscg.org/certified-drug-free-database' }));
    },
  },
  { key: 'ifos', mark: 'IFOS', home: 'https://certifications.nutrasource.ca', load: nutrasource('IFOS', 'ifos') },
  { key: 'ikos', mark: 'IKOS', home: 'https://certifications.nutrasource.ca', load: nutrasource('IKOS', 'ikos') },
  { key: 'iaos', mark: 'IAOS', home: 'https://certifications.nutrasource.ca', load: nutrasource('IAOS', 'iaos') },
  { key: 'ipro', mark: 'IPRO', home: 'https://certifications.nutrasource.ca', load: nutrasource('IPRO', 'ipro') },
  { key: 'nutrastrong', mark: 'NutraStrong', home: 'https://certifications.nutrasource.ca', load: nutrasource('NutraStrong', 'nutrastrong') },
];
const SOURCE = new Map(SOURCES.map((s) => [s.key, s]));

export const CHECK_SQL = [
  `CREATE TABLE IF NOT EXISTS cert_listings (source TEXT NOT NULL, brand TEXT NOT NULL, product TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', PRIMARY KEY (source, brand, product))`,
  // state: on (shown), review (a near match, waiting for the owner), off (was shown, the listing has gone)
  `CREATE TABLE IF NOT EXISTS pick_marks (url TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, listed TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL, PRIMARY KEY (url, source))`,
  `CREATE TABLE IF NOT EXISTS pick_shop (url TEXT PRIMARY KEY, json TEXT NOT NULL, checked_at TEXT NOT NULL)`,
];

// ---------- matching ----------

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
/** Names a certifier files a brand under when they differ from the name on our picks. */
const ALIASES: Record<string, string[]> = {
  nowfoods: ['now', 'nowsports', 'nowhealthgroup'], swansonvitamins: ['swanson'], optimumnutrition: ['on', 'optimumnutritionon'], '21stcentury': ['21stcenturyhealthcare'],
  naturesplus: ['naturesplus', 'naturalorganics'], naturesbounty: ['naturesbounty'], legionathletics: ['legion'], dripdrop: ['dripdrophydration', 'dripdrop'], animal: ['universalnutrition', 'animal'],
  nuun: ['nuunhydration'], megafood: ['foodstateincdbamegafood'], californiagoldnutrition: ['californiagoldnutrition', 'cgn'], dymatize: ['dymatizenutrition'], evlutionnutrition: ['evl', 'evlnutrition'],
  jymsupplementscience: ['jym'], ruleoneproteins: ['ruleone', 'r1'], lifeextension: ['lifeextension'], doctorsbest: ['doctorsbest'], sportsresearch: ['sportsresearch', 'sportsresearchcorporation'],
};
function sameBrand(pick: string, listed: string): boolean {
  const a = norm(pick), b = norm(listed);
  if (!a || !b) return false;
  if (a === b) return true;
  if ((ALIASES[a] ?? []).includes(b)) return true;
  // "Thorne" and "Thorne Research", "Garden of Life" and "Garden of Life, LLC": one starts the other, and it is not a three-letter accident.
  return Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a));
}

/** Some lists file a brand under its parent company but start the product name with the brand. */
const ofBrand = (brand: string, l: { brand: string; product: string }) => sameBrand(brand, l.brand) || (norm(brand).length >= 5 && norm(l.product).startsWith(norm(brand)));

interface Pick { url: string; brand: string; name: string; title: string; sup: string; slug: string }
async function allPicks(db: D1Database): Promise<Pick[]> {
  const sups = await listSupplements(db, 500, false);
  const titles = new Map((await db.prepare('SELECT url, title FROM dose_labels').all<{ url: string; title: string }>()).results.map((r) => [r.url, r.title]));
  const seen = new Set<string>();
  return sups.flatMap((s) => s.products.slice(0, MAX_PICKS).filter((p) => p.brand && !seen.has(p.url) && seen.add(p.url)).map((p) => ({ url: p.url, brand: p.brand!, name: p.name, title: titles.get(p.url) ?? '', sup: s.name, slug: s.slug })));
}

const MATCH_SYSTEM = `You compare supplement products for a consumer site that marks a product "independently tested" only when it is on a certifier's own list.
You get the site's products of one brand and the entries one certifier lists for that brand. For each site product decide whether a listed entry is THE SAME PRODUCT.
- "exact": same product line, same active ingredient, same form (capsule, powder, softgel, gummy) and the same strength where either side states one. A different flavour, pack size or a market suffix such as (USA) is still the same product. When the certifier lists a product per flavour, any flavour of the same product counts.
- "near": probably the same product but something is unstated or unclear (strength missing on one side, a slightly different name, a possible reformulation).
- "none": no entry is this product. A different strength, form, or a different product of the same line is "none". Most products have no entry: answer "none" freely.
Never match on the brand alone. Give one short plain sentence of reason.`;
const MATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pick', 'entry', 'verdict', 'why'], properties: { pick: { type: 'integer' }, entry: { type: 'integer' }, verdict: { type: 'string', enum: ['exact', 'near', 'none'] }, why: { type: 'string' } } } } },
};

/** Compare one brand's picks with one certifier's entries for it and store the outcome. Returns what changed. */
async function matchBrand(env: CheckEnv, brand: string, source: string, picks: Pick[], entries: Listing[], log: RunLog): Promise<void> {
  const user = `Certifier: ${SOURCE.get(source)!.mark}\nBrand: ${brand}\n\nSITE PRODUCTS\n${picks.map((p, i) => `${i}. ${p.name}${p.title ? ` | shop title: ${p.title}` : ''} | on the page: ${p.sup}`).join('\n')}\n\nCERTIFIER ENTRIES\n${entries.slice(0, 400).map((e, i) => `${i}. ${e.product}`).join('\n')}`;
  const out = await claudeJson<{ results: { pick: number; entry: number; verdict: 'exact' | 'near' | 'none'; why: string }[] }>(env, MATCH_SYSTEM, user, MATCH_SCHEMA, { maxTokens: 6000 });
  const now = new Date().toISOString();
  const verdicts = new Map(out.results.filter((r) => picks[r.pick]).map((r) => [r.pick, r]));
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const v = verdicts.get(i);
    const e = v && v.verdict !== 'none' ? entries[v.entry] : undefined;
    const before = await env.DB.prepare('SELECT state FROM pick_marks WHERE url = ? AND source = ?').bind(p.url, source).first<{ state: string }>();
    if (before?.state === 'rejected') continue; // the owner said no to this one
    const seeded = CERTIFIED[p.url]?.mark === SOURCE.get(source)!.mark;
    const shown = before ? before.state === 'on' : seeded;
    const state = e && v!.verdict === 'exact' ? 'on' : e ? (shown ? 'on' : 'review') : shown ? 'off' : '';
    if (!state) { if (before) await env.DB.prepare('DELETE FROM pick_marks WHERE url = ? AND source = ?').bind(p.url, source).run(); continue; }
    await env.DB.prepare('INSERT INTO pick_marks (url, source, state, listed, link, why, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url, source) DO UPDATE SET state = excluded.state, listed = excluded.listed, link = excluded.link, why = excluded.why, checked_at = excluded.checked_at')
      .bind(p.url, source, state, e?.product ?? '', e?.link ?? '', v?.why ?? '', now).run();
    const line = `${p.brand} ${p.name} (${p.sup}) · ${SOURCE.get(source)!.mark}${e ? `: listed as "${e.product}"` : ''}`;
    if (state === 'on' && !shown) log.added.push(line);
    if (state === 'review' && before?.state !== 'review') log.review.push(line);
    if (state === 'off') log.removed.push(line);
  }
}

// ---------- the run ----------

interface RunLog { added: string[]; review: string[]; removed: string[]; sources: string[]; shop: string[]; recalls: string[]; swaps: string[]; errors: string[] }
interface Run { started: string; queue: string[]; log: RunLog; steps: number }
const emptyLog = (): RunLog => ({ added: [], review: [], removed: [], sources: [], shop: [], recalls: [], swaps: [], errors: [] });

/** Queue a full run: every list, then matching, the shop check, recalls and swap ideas. */
export async function startChecks(env: CheckEnv): Promise<Run> {
  const run: Run = { started: new Date().toISOString(), queue: [...SOURCES.map((s) => `fetch:${s.key}`), 'plan'], log: emptyLog(), steps: 0 };
  await setMeta(env.DB, 'checks:run', JSON.stringify(run));
  return run;
}

async function storeListings(db: D1Database, key: string, rows: Listing[]): Promise<string> {
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM cert_listings WHERE source = ?').bind(key).first<{ n: number }>())?.n ?? 0;
  // A list that suddenly lost most of its entries is a broken download, not a mass delisting: keep last week's.
  if (rows.length < 5 || rows.length < before * 0.5) throw new Error(`${key}: only ${rows.length} entries read (had ${before}); kept the earlier list`);
  await db.prepare('DELETE FROM cert_listings WHERE source = ?').bind(key).run();
  const unique = [...new Map(rows.map((r) => [`${r.brand}|${r.product}`, r])).values()];
  for (let i = 0; i < unique.length; i += 50) {
    await db.batch(unique.slice(i, i + 50).map((r) => db.prepare('INSERT OR IGNORE INTO cert_listings (source, brand, product, link) VALUES (?, ?, ?, ?)').bind(key, r.brand.slice(0, 120), r.product.slice(0, 200), r.link.slice(0, 300))));
  }
  return `${SOURCE.get(key)!.mark}: ${unique.length} products${before ? ` (${unique.length - before >= 0 ? '+' : ''}${unique.length - before})` : ''}`;
}

const iherbId = (url: string) => /\/(\d+)(?:\?.*)?$/.exec(url)?.[1];

/** Take the next step of a running check. Returns null when no run is active. */
export async function stepChecks(env: CheckEnv): Promise<{ step: string; left: number } | null> {
  const raw = await getMeta(env.DB, 'checks:run');
  if (!raw) return null;
  const run = JSON.parse(raw) as Run;
  const step = run.queue.shift();
  if (!step) return null;
  run.steps += 1;
  const [kind, arg, arg2] = step.split(':');
  try {
    if (kind === 'fetch') {
      run.log.sources.push(await storeListings(env.DB, arg, await SOURCE.get(arg)!.load()));
    } else if (kind === 'plan') {
      // Which brand of ours appears on which list: one matching step for each such pair, then the rest of the run.
      const picks = await allPicks(env.DB);
      const brands = [...new Set(picks.map((p) => p.brand))];
      for (const s of SOURCES) {
        const listed = (await env.DB.prepare('SELECT brand, product FROM cert_listings WHERE source = ?').bind(s.key).all<{ brand: string; product: string }>()).results;
        for (const b of brands) if (listed.some((l) => ofBrand(b, l))) run.queue.push(`match:${s.key}:${encodeURIComponent(b)}`);
      }
      for (let i = 0; i < picks.length; i += 40) run.queue.push(`shop:${i}`);
      run.queue.push('recalls', 'swaps', 'done');
    } else if (kind === 'match') {
      const brand = decodeURIComponent(arg2);
      const picks = (await allPicks(env.DB)).filter((p) => p.brand === brand);
      const entries = (await env.DB.prepare('SELECT source, brand, product, link FROM cert_listings WHERE source = ?').bind(arg).all<Listing>()).results.filter((l) => ofBrand(brand, l));
      for (let i = 0; i < picks.length; i += 30) await matchBrand(env, brand, arg, picks.slice(i, i + 30), entries, run.log);
    } else if (kind === 'shop') {
      const picks = (await allPicks(env.DB)).slice(Number(arg), Number(arg) + 40);
      for (const p of picks) {
        const id = iherbId(p.url);
        if (!id || !p.url.includes('iherb.com/pr/')) continue;
        const r = await fetch(`https://catalog.app.iherb.com/product/${id}`, { headers: UA });
        if (!r.ok) { if (r.status === 404) run.log.shop.push(`${p.brand} ${p.name} (${p.sup}): no longer on iHerb`); else throw new Error(`iHerb answered ${r.status}`); continue; }
        const d = (await r.json()) as { isDiscontinued?: boolean; isAvailableToPurchase?: boolean; stockStatusMessage?: string; discountPrice?: string; averageRating?: number; totalRatingCount?: number; iTestedImageIndices?: number[] };
        const shop = { discontinued: !!d.isDiscontinued, available: d.isAvailableToPurchase !== false, stock: d.stockStatusMessage ?? '', price: d.discountPrice ?? '', rating: d.averageRating ?? 0, ratings: d.totalRatingCount ?? 0, itested: (d.iTestedImageIndices ?? []).length > 0 };
        await env.DB.prepare('INSERT INTO pick_shop (url, json, checked_at) VALUES (?, ?, ?) ON CONFLICT (url) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at').bind(p.url, JSON.stringify(shop), new Date().toISOString()).run();
        if (shop.discontinued) run.log.shop.push(`${p.brand} ${p.name} (${p.sup}): discontinued on iHerb`);
        else if (!shop.available) run.log.shop.push(`${p.brand} ${p.name} (${p.sup}): ${shop.stock || 'not available'}`);
      }
    } else if (kind === 'recalls') {
      const since = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
      const d = JSON.parse(await text(`https://api.fda.gov/food/enforcement.json?search=report_date:[${since}+TO+29991231]+AND+product_description:(supplement+capsules+tablets+softgels)&limit=1000`)) as { results?: { recalling_firm: string; product_description: string; reason_for_recall: string; report_date: string; classification: string }[] };
      const brands = [...new Set((await allPicks(env.DB)).map((p) => p.brand))].filter((b) => norm(b).length >= 5);
      for (const r of d.results ?? []) {
        const hay = norm(`${r.recalling_firm} ${r.product_description}`);
        const b = brands.find((x) => hay.includes(norm(x)));
        if (b) run.log.recalls.push(`${b}: ${r.product_description.slice(0, 110)} · ${r.reason_for_recall.slice(0, 110)} (${r.classification}, ${r.report_date})`);
      }
    } else if (kind === 'swaps') {
      // Supplements with no tested pick: listed products whose name carries the supplement's own name.
      const sups = await listSupplements(env.DB, 500, false);
      const on = new Set((await env.DB.prepare("SELECT url FROM pick_marks WHERE state = 'on'").all<{ url: string }>()).results.map((r) => r.url));
      const listings = (await env.DB.prepare('SELECT source, brand, product, link FROM cert_listings').all<Listing>()).results;
      for (const s of sups as Supplement[]) {
        const picks = s.products.slice(0, MAX_PICKS);
        if (!picks.length || picks.some((p) => on.has(p.url) || CERTIFIED[p.url])) continue;
        const key = norm(s.name.replace(/\(.*?\)/g, '').replace(/supplements?|extracts?/gi, ''));
        if (key.length < 5) continue;
        const found = [...new Map(listings.filter((l) => norm(l.product).includes(key)).map((l) => [`${norm(l.brand)}`, l])).values()].slice(0, 3);
        if (found.length) run.log.swaps.push(`${s.name}: ${found.map((l) => `${l.brand} ${l.product} (${SOURCE.get(l.source)?.mark ?? l.source})`).join('; ')}`);
      }
    } else if (kind === 'done') {
      await setMeta(env.DB, 'checks:last', JSON.stringify({ started: run.started, finished: new Date().toISOString(), steps: run.steps, log: run.log }));
      await env.DB.prepare("DELETE FROM meta WHERE key = 'checks:run'").run();
      return { step, left: 0 };
    }
  } catch (err) {
    run.log.errors.push(`${step}: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
    // The shop refused us once: it will refuse the rest of this run too.
    if (kind === 'shop') run.queue = run.queue.filter((q) => !q.startsWith('shop:'));
  }
  await setMeta(env.DB, 'checks:run', JSON.stringify(run));
  return { step, left: run.queue.length };
}

// ---------- what the site shows, and what the owner reads ----------

let loadedAt = 0;
const seed = { ...CERTIFIED };
/** Bring the marks the pages show (the CERTIFIED map) in line with the database: at most every ten minutes per isolate. */
export async function loadMarks(db: D1Database): Promise<void> {
  if (Date.now() - loadedAt < 600_000) return;
  loadedAt = Date.now();
  try {
    const rows = (await db.prepare("SELECT url, source, state, listed, link FROM pick_marks WHERE state IN ('on', 'off')").all<{ url: string; source: string; state: string; listed: string; link: string }>()).results;
    for (const k of Object.keys(CERTIFIED)) delete CERTIFIED[k];
    Object.assign(CERTIFIED, seed);
    for (const r of rows.filter((x) => x.state === 'off')) if (CERTIFIED[r.url]?.mark === SOURCE.get(r.source)?.mark) delete CERTIFIED[r.url];
    for (const r of rows.filter((x) => x.state === 'on')) if (!CERTIFIED[r.url] && SOURCE.get(r.source)) CERTIFIED[r.url] = { mark: SOURCE.get(r.source)!.mark, source: r.link || SOURCE.get(r.source)!.home, listed: r.listed };
  } catch {
    /* the tables do not exist yet: the seed stands */
  }
}

/** Lines for the Monday email: what the last run changed and what waits for a decision. */
export async function checksReportLines(db: D1Database): Promise<string[]> {
  const raw = await getMeta(db, 'checks:last');
  if (!raw) return ['Product check: no run has finished yet.'];
  const { finished, log } = JSON.parse(raw) as { finished: string; log: RunLog };
  const some = (title: string, list: string[], max = 8) => (list.length ? [`${title} (${list.length}): ${list.slice(0, max).join(' | ')}${list.length > max ? ` | and ${list.length - max} more` : ''}`] : []);
  const shown = (await db.prepare("SELECT COUNT(*) AS n FROM pick_marks WHERE state = 'on'").first<{ n: number }>())?.n ?? 0;
  return [
    `Product check finished ${finished.slice(0, 10)}: ${log.sources.length} certifier lists read, ${shown} tested lines confirmed, ${log.added.length} added, ${log.removed.length} removed, ${log.review.length} waiting for your yes or no.`,
    ...some('New tested lines now live', log.added),
    ...some('Near matches, not shown until you say yes', log.review),
    ...some('Tested lines taken off (listing gone)', log.removed),
    ...some('Picks with a problem on iHerb', log.shop),
    ...some('FDA recalls naming a brand we pick from (check before acting)', log.recalls, 5),
    ...some('Tested products that could replace an untested pick', log.swaps, 10),
    ...some('Steps that failed', log.errors, 6),
  ];
}
