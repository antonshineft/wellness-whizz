/**
 * Telling search engines about new and changed pages.
 *
 * - IndexNow (indexnow.org): one POST with the changed URLs reaches Bing, Yandex, Naver, Seznam and, through Bing's
 *   index, DuckDuckGo and ChatGPT search. Google does not take part. The key in INDEXNOW_KEY is public by design:
 *   the site serves it at /<key>.txt (public/<key>.txt) so the engines can check that the submissions are ours.
 * - WebSub (PubSubHubbub): when /feed.xml gains an item, Google's public hub is told and the feed fetchers come
 *   straight away instead of on their own schedule.
 * - The hourly cron calls indexSync(), which works out what changed since the last run (new or updated supplement
 *   pages, new articles, new research notes) and submits only that. /api/admin/indexnow does the same on demand;
 *   &all=1 submits every page in the sitemap (for the first run, or after a redesign).
 *
 * The sitemap and the feed live here too, so that "what changed" and "what we tell the engines" stay one list.
 */
import { POSTS } from './blog';
import type { BlogPost } from './blog/types';
import { getMeta, setMeta } from './db';
import { listResearchNotes, pubmedUrl, type ResearchNote } from './research';

export interface IndexingEnv {
  DB: D1Database;
  /** 32 hexadecimal characters, also the name of public/<key>.txt; empty switches the pings off. */
  INDEXNOW_KEY?: string;
  /** "false" switches the pings off (local development). */
  INDEXNOW?: string;
  CANONICAL_HOST?: string;
}

// One submission reaches every IndexNow engine whichever endpoint takes it. The shared endpoint rate-limits by IP,
// and Cloudflare Workers share their outbound addresses, so a 429 there is retried at Bing's and Yandex's own endpoints.
const INDEXNOW_ENDPOINTS = ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow', 'https://yandex.com/indexnow'];
const WEBSUB_HUB = 'https://pubsubhubbub.appspot.com/';
const FEED_PATH = '/feed.xml';
const FEED_ITEMS = 40;
const STATE_KEY = 'indexing:state';
const LAST_KEY = 'indexing:last';
const KEY_RE = /^[0-9a-f]{32}$/;

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority: string;
}

export interface IndexSyncResult {
  at: string;
  /** Site-relative paths that were (or, with dry, would be) submitted. */
  paths: string[];
  feedChanged: boolean;
  dry: boolean;
  indexnow: { enabled: boolean; status: number | null; endpoint?: string; error?: string } | null;
  websub: { status: number | null; error?: string } | null;
}

interface SyncState {
  /** SQLite datetime (UTC) of the previous run; rows created or updated after it are new. */
  since: string;
  /** Article slugs already submitted. */
  posts: string[];
  /** Research notes with a summary at the previous run (the feed and /research change when it moves). */
  notes: number;
}

export function indexingEnabled(env: IndexingEnv): boolean {
  return env.INDEXNOW !== 'false' && KEY_RE.test((env.INDEXNOW_KEY ?? '').trim());
}

function origin(env: IndexingEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim();
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : 'https://aiww.io';
}

/** "2026-10-13 06:52:24", the format SQLite's datetime('now') writes, so it compares with created_at columns. */
function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : undefined);
const latest = (...values: (string | undefined)[]) => values.filter((v): v is string => Boolean(v)).sort().pop();

// ---------- sitemap ----------

interface SupplementStamp {
  slug: string;
  created_at: string;
  updated_at: string;
}

async function supplementStamps(db: D1Database, curatedOnly: boolean): Promise<SupplementStamp[]> {
  const { results } = await db
    .prepare(`SELECT slug, created_at, updated_at FROM supplements${curatedOnly ? " WHERE source = 'cms'" : ''} ORDER BY name`)
    .all<SupplementStamp>();
  return results;
}

async function latestNoteAt(db: D1Database): Promise<string | undefined> {
  const row = await db.prepare(`SELECT MAX(created_at) AS at FROM research_notes WHERE summary != ''`).first<{ at: string | null }>();
  return row?.at ?? undefined;
}

/**
 * Every page the site wants indexed, with the date it last changed where that is known. Google reads lastmod and
 * ignores priority; a lastmod that moves without the page changing teaches it to ignore ours, so static pages
 * carry none, supplement pages carry their last content change and the lists carry their newest item.
 */
export async function sitemapEntries(db: D1Database, curatedOnly: boolean): Promise<SitemapEntry[]> {
  const [supplements, noteAt] = await Promise.all([supplementStamps(db, curatedOnly), latestNoteAt(db)]);
  const supplementEntries = supplements.map((s) => ({
    loc: `/supplement/${s.slug}`,
    lastmod: day(s.updated_at || s.created_at),
    priority: '0.7',
  }));
  const postEntries = POSTS.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: p.date, priority: '0.8' }));
  const latestPost = latest(...POSTS.map((p) => p.date));
  const latestSupplement = latest(...supplementEntries.map((e) => e.lastmod));
  return [
    { loc: '/', lastmod: latest(latestPost, latestSupplement), priority: '1.0' },
    { loc: '/wellness-quiz', priority: '0.9' },
    { loc: '/blog', lastmod: latestPost, priority: '0.8' },
    { loc: '/supplements', lastmod: latestSupplement, priority: '0.8' },
    { loc: '/research', lastmod: day(noteAt), priority: '0.7' },
    { loc: '/how-it-works', priority: '0.6' },
    { loc: '/terms', priority: '0.2' },
    ...postEntries,
    ...supplementEntries,
  ];
}

export function renderSitemap(site: string, entries: SitemapEntry[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries
      .map((u) => `  <url><loc>${xml(site + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`)
      .join('\n') +
    '\n</urlset>\n'
  );
}

// ---------- feed ----------

function xml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or a plain date, as an RFC 822 date for RSS. */
function rfc822(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T09:00:00Z` : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return (Number.isNaN(date.getTime()) ? new Date() : date).toUTCString();
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  category: string;
  /** date or SQLite datetime, for sorting and pubDate */
  at: string;
}

function postItem(site: string, p: BlogPost): FeedItem {
  return { title: p.title, link: `${site}/blog/${p.slug}`, description: p.excerpt || p.description, category: p.category, at: p.date };
}

function noteItem(site: string, n: ResearchNote): FeedItem {
  const name = n.supplement_name ?? '';
  const text = [n.summary, n.takeaway ? `What it means: ${n.takeaway}` : '', `Study: ${pubmedUrl(n.pmid)}`].filter(Boolean).join(' ');
  return {
    title: name ? `New research on ${name}: ${n.title}` : n.title,
    link: `${site}/research#pmid-${encodeURIComponent(n.pmid)}`,
    description: text,
    category: 'Research notes',
    at: n.created_at,
  };
}

/** RSS 2.0 with the articles and the research notes, newest first, announcing Google's WebSub hub. */
export function renderFeed(site: string, posts: readonly BlogPost[], notes: ResearchNote[]): string {
  const items = [...posts.map((p) => postItem(site, p)), ...notes.map((n) => noteItem(site, n))]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, FEED_ITEMS);
  const newest = items[0]?.at;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n' +
    `  <title>Wellness Whizz</title>\n` +
    `  <link>${xml(site)}/</link>\n` +
    `  <description>Supplement guides, comparison articles and plain-language notes on new PubMed research, from the AI supplement advisor.</description>\n` +
    `  <language>en</language>\n` +
    `  <lastBuildDate>${newest ? rfc822(newest) : new Date().toUTCString()}</lastBuildDate>\n` +
    `  <atom:link href="${xml(site + FEED_PATH)}" rel="self" type="application/rss+xml"/>\n` +
    `  <atom:link href="${WEBSUB_HUB}" rel="hub"/>\n` +
    items
      .map(
        (i) =>
          `  <item>\n    <title>${xml(i.title)}</title>\n    <link>${xml(i.link)}</link>\n    <guid isPermaLink="true">${xml(i.link)}</guid>\n` +
          `    <pubDate>${rfc822(i.at)}</pubDate>\n    <category>${xml(i.category)}</category>\n    <description>${xml(i.description)}</description>\n  </item>`,
      )
      .join('\n') +
    '\n</channel>\n</rss>\n'
  );
}

export async function feedXml(db: D1Database, site: string): Promise<string> {
  return renderFeed(site, POSTS, await listResearchNotes(db, FEED_ITEMS));
}

// ---------- pings ----------

async function submitIndexNow(env: IndexingEnv, paths: string[]): Promise<IndexSyncResult['indexnow']> {
  if (!indexingEnabled(env)) return { enabled: false, status: null };
  const site = origin(env);
  const key = (env.INDEXNOW_KEY ?? '').trim();
  const body = JSON.stringify({ host: new URL(site).host, key, keyLocation: `${site}/${key}.txt`, urlList: paths.slice(0, 10000).map((p) => site + p) });
  let last: IndexSyncResult['indexnow'] = { enabled: true, status: null };
  for (const endpoint of INDEXNOW_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body });
      // 200 and 202 both mean accepted (202 while the key file has not been verified yet).
      if (res.status === 200 || res.status === 202) return { enabled: true, status: res.status, endpoint };
      last = { enabled: true, status: res.status, endpoint, error: (await res.text()).slice(0, 200) };
      // Anything but rate limiting is about the key or the payload and will not improve at another endpoint.
      if (res.status !== 429) return last;
    } catch (err) {
      last = { enabled: true, status: null, endpoint, error: String(err).slice(0, 200) };
    }
  }
  return last;
}

async function publishFeed(env: IndexingEnv): Promise<{ status: number | null; error?: string }> {
  const params = new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': origin(env) + FEED_PATH });
  try {
    const res = await fetch(WEBSUB_HUB, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
    if (res.status === 204 || res.status === 200) return { status: res.status };
    return { status: res.status, error: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { status: null, error: String(err).slice(0, 200) };
  }
}

async function loadState(db: D1Database): Promise<SyncState | null> {
  try {
    const raw = await getMeta(db, STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { since: String(parsed.since ?? ''), posts: Array.isArray(parsed.posts) ? parsed.posts.map(String) : [], notes: Number(parsed.notes ?? 0) || 0 };
  } catch {
    return null;
  }
}

export interface IndexSyncOptions {
  /** Submit every page in the sitemap, not only what changed. */
  all?: boolean;
  /** Extra site-relative paths to submit. */
  paths?: string[];
  /** Work out the list and record nothing; nothing is sent. */
  dry?: boolean;
  /** Hide AI-created supplements, as the sitemap does when LIST_AI_SUPPLEMENTS is "false". */
  curatedOnly?: boolean;
}

/**
 * Submit what changed since the previous run. The first run (no state yet) records the current state and submits
 * nothing on its own, so a fresh deployment does not resubmit the whole site every hour; use all=true for that.
 */
export async function indexSync(env: IndexingEnv, opts: IndexSyncOptions = {}): Promise<IndexSyncResult> {
  const db = env.DB;
  const now = sqliteNow();
  const state = await loadState(db);
  const curatedOnly = opts.curatedOnly ?? false;
  const noteCount = (await db.prepare(`SELECT COUNT(*) AS n FROM research_notes WHERE summary != ''`).first<{ n: number }>())?.n ?? 0;
  const postSlugs = POSTS.map((p) => p.slug);

  const paths = new Set<string>();
  let feedChanged = false;
  if (opts.all) {
    for (const e of await sitemapEntries(db, curatedOnly)) paths.add(e.loc);
    feedChanged = true;
  } else if (state) {
    const { results } = await db
      .prepare(`SELECT slug, created_at, updated_at FROM supplements WHERE (created_at > ? OR updated_at > ?)${curatedOnly ? " AND source = 'cms'" : ''}`)
      .bind(state.since, state.since)
      .all<SupplementStamp>();
    for (const s of results) {
      paths.add(`/supplement/${s.slug}`);
      if (s.created_at > state.since) {
        paths.add('/supplements');
        paths.add('/');
      }
    }
    const newPosts = postSlugs.filter((slug) => !state.posts.includes(slug));
    if (newPosts.length) {
      for (const slug of newPosts) paths.add(`/blog/${slug}`);
      paths.add('/blog');
      paths.add('/');
      feedChanged = true;
    }
    if (noteCount !== state.notes) {
      paths.add('/research');
      feedChanged = true;
    }
  }
  for (const p of opts.paths ?? []) if (/^\/[A-Za-z0-9/_.%-]*$/.test(p)) paths.add(p);
  if (feedChanged) paths.add(FEED_PATH);

  const list = [...paths];
  const result: IndexSyncResult = { at: new Date().toISOString(), paths: list, feedChanged, dry: Boolean(opts.dry), indexnow: null, websub: null };
  if (opts.dry) return result;

  if (list.length) result.indexnow = await submitIndexNow(env, list);
  if (feedChanged) result.websub = await publishFeed(env);
  await setMeta(db, STATE_KEY, JSON.stringify({ since: now, posts: postSlugs, notes: noteCount } satisfies SyncState));
  if (list.length || state === null) await setMeta(db, LAST_KEY, JSON.stringify(result));
  return result;
}
