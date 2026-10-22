/**
 * Google Search Console (src/gsc.ts): what Google makes of the site, pulled by the Worker with a service account.
 *
 * Setup: the secret GSC_SERVICE_ACCOUNT holds the account's JSON key, and the account's email is a user of the
 * Search Console property GSC_SITE (a domain property such as sc-domain:aiww.io). No model call anywhere here.
 *
 *   - inspectStep(): the URL Inspection API over the sitemap's pages, a few per five-minute tick, every page about
 *     once a day (gsc_pages: verdict, coverage state, last crawl, canonical). Google allows 2,000 calls a day.
 *   - analyticsStep(): once a day, clicks, impressions, CTR and position by day for the last 28 days (gsc_daily),
 *     plus the top queries and pages of the last seven complete days (meta gsc:analytics). Search data trails by
 *     two to three days, so "last 7 days" ends the day before yesterday.
 *   - gscSummary() and gscDigestLine(): for /api/stats, /api/admin/gsc and the daily outreach digest.
 */
import { getMeta, setMeta } from './db';
import type { Lang } from './i18n';
import { sitemapEntries } from './indexing';

export interface GscEnv {
  DB: D1Database;
  /** The service account's JSON key (secret). */
  GSC_SERVICE_ACCOUNT?: string;
  /** The Search Console property, e.g. sc-domain:aiww.io (default: sc-domain:<CANONICAL_HOST>). */
  GSC_SITE?: string;
  CANONICAL_HOST?: string;
}

export interface InspectOptions {
  /** Site origin the sitemap paths hang off, e.g. https://aiww.io */
  origin: string;
  curatedOnly: boolean;
  langs: readonly Lang[];
  /** Pages to inspect in this step (default 20, at most 40: the free plan allows 50 subrequests per invocation). */
  max?: number;
  /** Retry pages whose last inspection failed, however recent (the tick waits an hour). */
  retryErrors?: boolean;
}

export const GSC_SQL = [
  `CREATE TABLE IF NOT EXISTS gsc_pages (url TEXT PRIMARY KEY, verdict TEXT NOT NULL DEFAULT '', coverage TEXT NOT NULL DEFAULT '', indexing_state TEXT NOT NULL DEFAULT '', robots TEXT NOT NULL DEFAULT '', last_crawl TEXT, canonical_ok INTEGER NOT NULL DEFAULT 1, indexed INTEGER NOT NULL DEFAULT 0, prev_indexed INTEGER NOT NULL DEFAULT 0, first_indexed_at TEXT, changed_at TEXT, checked_at TEXT, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS gsc_daily (day TEXT PRIMARY KEY, clicks INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, ctr REAL NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const TOKEN_META = 'gsc:token';
const ANALYTICS_META = 'gsc:analytics';
const ANALYTICS_DAY_META = 'gsc:analytics:day';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function credentials(env: GscEnv): ServiceAccount | null {
  const raw = (env.GSC_SERVICE_ACCOUNT ?? '').trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<ServiceAccount>;
    return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
  } catch {
    return null;
  }
}

function site(env: GscEnv): string {
  const explicit = (env.GSC_SITE ?? '').trim();
  if (explicit) return explicit;
  const host = (env.CANONICAL_HOST ?? '').trim();
  return host ? `sc-domain:${host}` : '';
}

/** Search Console is configured when the key parses and a property is known. */
export function gscEnabled(env: GscEnv): boolean {
  return !!credentials(env) && !!site(env);
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A signed JWT the token endpoint swaps for an access token (RS256 with the key's PKCS#8 private key). */
export async function signJwt(sa: ServiceAccount, scope = SCOPE, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(signature)}`;
}

async function accessToken(env: GscEnv, fresh = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!fresh) {
    try {
      const cached = JSON.parse((await getMeta(env.DB, TOKEN_META)) ?? 'null') as { token?: string; exp?: number } | null;
      if (cached?.token && (cached.exp ?? 0) > now + 120) return cached.token;
    } catch {
      /* no usable cache */
    }
  }
  const sa = credentials(env);
  if (!sa) throw new Error('GSC_SERVICE_ACCOUNT is not set or is not a service account key');
  const assertion = await signJwt(sa);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  await setMeta(env.DB, TOKEN_META, JSON.stringify({ token: j.access_token, exp: now + (j.expires_in || 3600) }));
  return j.access_token;
}

async function api<T>(env: GscEnv, url: string, body: unknown, retry = true): Promise<T> {
  const token = await accessToken(env);
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry) {
    await accessToken(env, true);
    return api<T>(env, url, body, false);
  }
  if (!res.ok) throw new Error(`Search Console ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// ---------- URL inspection ----------

interface IndexStatus {
  verdict: string;
  coverage: string;
  indexingState: string;
  robots: string;
  lastCrawl: string | null;
  googleCanonical: string;
  userCanonical: string;
}

interface InspectResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      indexingState?: string;
      robotsTxtState?: string;
      lastCrawlTime?: string;
      googleCanonical?: string;
      userCanonical?: string;
    };
  };
}

async function inspect(env: GscEnv, url: string): Promise<IndexStatus> {
  const j = await api<InspectResponse>(env, INSPECT_URL, { inspectionUrl: url, siteUrl: site(env), languageCode: 'en-US' });
  const r = j.inspectionResult?.indexStatusResult ?? {};
  return {
    verdict: r.verdict ?? '',
    coverage: r.coverageState ?? '',
    indexingState: r.indexingState ?? '',
    robots: r.robotsTxtState ?? '',
    lastCrawl: r.lastCrawlTime ?? null,
    googleCanonical: r.googleCanonical ?? '',
    userCanonical: r.userCanonical ?? '',
  };
}

export interface InspectResult {
  inspected: number;
  indexed: number;
  errors: number;
  /** "+ /path" newly indexed, "- /path" dropped out, this step. */
  changed: string[];
  /** Sitemap pages still waiting for today's check after this step. */
  pending: number;
}

/**
 * Inspect up to `max` sitemap pages that have not been checked in the last 22 hours, new pages first. Returns null
 * when Search Console is not configured; { inspected: 0 } when every page has been checked today.
 */
export async function inspectStep(env: GscEnv, opts: InspectOptions): Promise<InspectResult | null> {
  if (!gscEnabled(env)) return null;
  const max = Math.max(1, Math.min(40, opts.max ?? 20));
  const entries = await sitemapEntries(env.DB, opts.curatedOnly, opts.langs);
  const urls = entries.map((e) => `${opts.origin}${e.loc}`);
  // Rows for pages new to the sitemap (one query for the known ones; each D1 call counts as a subrequest).
  const known = new Set((await env.DB.prepare('SELECT url FROM gsc_pages').all<{ url: string }>()).results.map((r) => r.url));
  const missing = urls.filter((u) => !known.has(u));
  for (let i = 0; i < missing.length; i += 50) {
    await env.DB.batch(missing.slice(i, i + 50).map((u) => env.DB.prepare('INSERT OR IGNORE INTO gsc_pages (url) VALUES (?)').bind(u)));
  }
  // Pages gone from the sitemap stop being refreshed; drop them once they are three days stale.
  await env.DB.prepare("DELETE FROM gsc_pages WHERE checked_at IS NOT NULL AND checked_at < datetime('now', '-3 days')").run();
  // Never checked first, English before Spanish, then the oldest check; a failed inspection is retried after an hour.
  const due = await env.DB
    .prepare(
      `SELECT url, indexed FROM gsc_pages
       WHERE checked_at IS NULL OR checked_at < datetime('now', '-22 hours') OR (error != '' AND (? = 1 OR checked_at < datetime('now', '-1 hour')))
       ORDER BY checked_at IS NOT NULL, url LIKE '%/es/%', checked_at, url LIMIT ?`,
    )
    .bind(opts.retryErrors ? 1 : 0, max)
    .all<{ url: string; indexed: number }>();
  const result: InspectResult = { inspected: 0, indexed: 0, errors: 0, changed: [], pending: 0 };
  const statements: D1PreparedStatement[] = [];
  const rows = due.results;
  for (let i = 0; i < rows.length; i += 4) {
    const chunk = rows.slice(i, i + 4);
    const outcomes = await Promise.all(chunk.map((row) => inspect(env, row.url).then((s) => ({ row, s, error: '' })).catch((err) => ({ row, s: null, error: String(err).slice(0, 200) }))));
    for (const { row, s, error } of outcomes) {
      result.inspected++;
      const path = row.url.replace(/^https?:\/\/[^/]+/, '');
      if (!s) {
        result.errors++;
        statements.push(env.DB.prepare("UPDATE gsc_pages SET error = ?, checked_at = datetime('now') WHERE url = ?").bind(error, row.url));
        continue;
      }
      const indexed = s.verdict === 'PASS' ? 1 : 0;
      if (indexed) result.indexed++;
      const canonicalOk = !s.googleCanonical || !s.userCanonical || s.googleCanonical === s.userCanonical ? 1 : 0;
      const changed = indexed !== row.indexed;
      if (changed) result.changed.push(`${indexed ? '+' : '-'} ${path}`);
      statements.push(
        env.DB
          .prepare(
            `UPDATE gsc_pages SET verdict = ?, coverage = ?, indexing_state = ?, robots = ?, last_crawl = ?, canonical_ok = ?, prev_indexed = indexed, indexed = ?,
               first_indexed_at = CASE WHEN ? = 1 AND first_indexed_at IS NULL THEN datetime('now') ELSE first_indexed_at END,
               changed_at = CASE WHEN ? THEN datetime('now') ELSE changed_at END, checked_at = datetime('now'), error = '' WHERE url = ?`,
          )
          .bind(s.verdict, s.coverage, s.indexingState, s.robots, s.lastCrawl, canonicalOk, indexed, indexed, changed ? 1 : 0, row.url),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM gsc_pages WHERE checked_at IS NULL OR checked_at < datetime('now', '-22 hours') OR error != ''").first<{ n: number }>();
  result.pending = pending?.n ?? 0;
  return result;
}

// ---------- search analytics ----------

interface AnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AnalyticsTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Analytics {
  at: string;
  /** The seven complete days the top lists cover. */
  from: string;
  to: string;
  week: AnalyticsTotals;
  previousWeek: AnalyticsTotals;
  queries: { query: string; clicks: number; impressions: number; position: number }[];
  pages: { page: string; clicks: number; impressions: number; position: number }[];
}

function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function totals(rows: AnalyticsRow[]): AnalyticsTotals {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const position = impressions ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : 0;
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: Math.round(position * 10) / 10 };
}

async function searchAnalytics(env: GscEnv, body: Record<string, unknown>): Promise<AnalyticsRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site(env))}/searchAnalytics/query`;
  const j = await api<{ rows?: AnalyticsRow[] }>(env, url, body);
  return j.rows ?? [];
}

/**
 * Pull the daily series and the top queries and pages. Runs once a day unless `force`; returns null when Search
 * Console is not configured or today's pull is already done.
 */
export async function analyticsStep(env: GscEnv, force = false): Promise<Analytics | null> {
  if (!gscEnabled(env)) return null;
  const today = dayAgo(0);
  if (!force && (await getMeta(env.DB, ANALYTICS_DAY_META)) === today) return null;
  const to = dayAgo(2);
  const from = dayAgo(8);
  const previousFrom = dayAgo(15);
  const byDay = await searchAnalytics(env, { startDate: dayAgo(29), endDate: to, dimensions: ['date'], rowLimit: 40 });
  if (byDay.length) {
    await env.DB.batch(
      byDay.map((r) =>
        env.DB
          .prepare("INSERT INTO gsc_daily (day, clicks, impressions, ctr, position, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(day) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, ctr = excluded.ctr, position = excluded.position, updated_at = excluded.updated_at")
          .bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position),
      ),
    );
  }
  // The API orders by clicks; with few clicks that is arbitrary, so ask for more rows and rank by impressions here.
  const byImpressions = (rows: AnalyticsRow[]) => rows.slice().sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks).slice(0, 12);
  const [queries, pages] = (
    await Promise.all([
      searchAnalytics(env, { startDate: from, endDate: to, dimensions: ['query'], rowLimit: 100 }),
      searchAnalytics(env, { startDate: from, endDate: to, dimensions: ['page'], rowLimit: 100 }),
    ])
  ).map(byImpressions);
  const week = totals(byDay.filter((r) => r.keys[0] >= from && r.keys[0] <= to));
  const previousWeek = totals(byDay.filter((r) => r.keys[0] >= previousFrom && r.keys[0] < from));
  const analytics: Analytics = {
    at: new Date().toISOString(),
    from,
    to,
    week,
    previousWeek,
    queries: queries.map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
    pages: pages.map((r) => ({ page: r.keys[0].replace(/^https?:\/\/[^/]+/, ''), clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
  };
  await setMeta(env.DB, ANALYTICS_META, JSON.stringify(analytics));
  await setMeta(env.DB, ANALYTICS_DAY_META, today);
  return analytics;
}

// ---------- summary ----------

export interface GscSummary {
  enabled: boolean;
  pages: {
    total: number;
    checked: number;
    indexed: number;
    en: { total: number; indexed: number };
    es: { total: number; indexed: number };
    /** Pages that became indexed in the last 24 hours (paths). */
    newlyIndexed: string[];
    /** Pages that dropped out of the index in the last 24 hours (paths). */
    dropped: string[];
    /** Why the rest is not indexed, by Google's coverage state. */
    notIndexed: { coverage: string; count: number }[];
    lastChecked: string | null;
  };
  analytics: Analytics | null;
}

export async function gscSummary(env: GscEnv): Promise<GscSummary> {
  const enabled = gscEnabled(env);
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS total, SUM(checked_at IS NOT NULL) AS checked, SUM(indexed) AS indexed,
              SUM(url LIKE '%/es/%') AS es_total, SUM(CASE WHEN url LIKE '%/es/%' THEN indexed ELSE 0 END) AS es_indexed, MAX(checked_at) AS last_checked
       FROM gsc_pages`,
    )
    .first<{ total: number; checked: number | null; indexed: number | null; es_total: number | null; es_indexed: number | null; last_checked: string | null }>();
  const paths = (rows: { url: string }[]) => rows.map((r) => r.url.replace(/^https?:\/\/[^/]+/, ''));
  const [newly, dropped, why] = await Promise.all([
    env.DB.prepare("SELECT url FROM gsc_pages WHERE indexed = 1 AND prev_indexed = 0 AND changed_at >= datetime('now', '-1 day') ORDER BY changed_at DESC LIMIT 40").all<{ url: string }>(),
    env.DB.prepare("SELECT url FROM gsc_pages WHERE indexed = 0 AND prev_indexed = 1 AND changed_at >= datetime('now', '-1 day') ORDER BY changed_at DESC LIMIT 40").all<{ url: string }>(),
    env.DB.prepare("SELECT coverage, COUNT(*) AS count FROM gsc_pages WHERE indexed = 0 AND checked_at IS NOT NULL GROUP BY coverage ORDER BY count DESC").all<{ coverage: string; count: number }>(),
  ]);
  let analytics: Analytics | null = null;
  try {
    analytics = JSON.parse((await getMeta(env.DB, ANALYTICS_META)) ?? 'null') as Analytics | null;
  } catch {
    analytics = null;
  }
  const total = row?.total ?? 0;
  const indexed = row?.indexed ?? 0;
  const esTotal = row?.es_total ?? 0;
  const esIndexed = row?.es_indexed ?? 0;
  return {
    enabled,
    pages: {
      total,
      checked: row?.checked ?? 0,
      indexed,
      en: { total: total - esTotal, indexed: indexed - esIndexed },
      es: { total: esTotal, indexed: esIndexed },
      newlyIndexed: paths(newly.results),
      dropped: paths(dropped.results),
      notIndexed: why.results.map((r) => ({ coverage: r.coverage || '(not checked yet)', count: r.count })),
      lastChecked: row?.last_checked ?? null,
    },
    analytics,
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** One or two sentences for the daily digest; empty when Search Console is not configured or has no data yet. */
export async function gscDigestLine(env: GscEnv): Promise<string> {
  if (!gscEnabled(env)) return '';
  const s = await gscSummary(env);
  const parts: string[] = [];
  if (s.pages.checked) {
    const list = (items: string[]) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`;
    parts.push(
      `Google index: ${s.pages.indexed} of ${s.pages.total} pages (English ${s.pages.en.indexed} of ${s.pages.en.total}, Spanish ${s.pages.es.indexed} of ${s.pages.es.total}).` +
        (s.pages.newlyIndexed.length ? ` Newly indexed: ${list(s.pages.newlyIndexed)}.` : '') +
        (s.pages.dropped.length ? ` Dropped out: ${list(s.pages.dropped)}.` : ''),
    );
  }
  const a = s.analytics;
  if (a) {
    const top = a.queries.slice(0, 3).map((q) => `${q.query} (${fmt(q.impressions)})`).join(', ');
    parts.push(
      `Google search, ${a.from} to ${a.to}: ${fmt(a.week.impressions)} impressions, ${fmt(a.week.clicks)} clicks` +
        (a.previousWeek.impressions ? ` (previous week ${fmt(a.previousWeek.impressions)} / ${fmt(a.previousWeek.clicks)})` : '') +
        (top ? `; top queries: ${top}.` : '.'),
    );
  }
  return parts.join(' ');
}
