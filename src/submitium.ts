/**
 * Submitium (https://submitium.com) submits the site to its directories by hand; src/badges.ts shows the
 * badges that result. This module keeps score of the order: the directories bought
 * (data/submitium-directories.json), how far each one is, and a "Submitium" tab in the backlinks sheet written
 * through the Google service account (the same key as Search Console; the sheet must be shared with its
 * email as an editor). The tab uses the ID | Resource | Status | … layout that src/sheet.ts reads back, so
 * these rows join the counts, the "went live" digest line and the admin page like every other directory.
 *
 * What the feed tells us: most directories list a product only while its badge is on the product's site, so
 * a badge appears in the feed as soon as Submitium queues that directory, linking the directory's homepage
 * ("badge": shown in our footer, listing pending). When the listing exists the link becomes the listing's own
 * page ("live"); the step fetches that page once to confirm it mentions the site. Directories that need no
 * badge never appear in the feed, so they stay "queued" until their listing link shows up. Submitium itself has
 * no API for its queue: anything still waiting long after the submission date is flagged as overdue so the
 * owner can chase them with a list.
 */
import { fetchWall } from '@submitium/badges';
import directoriesJson from '../data/submitium-directories.json';
import { getMeta, setMeta } from './db';
import { accessToken, credentials, type GscEnv } from './gsc';

export interface SubmitiumEnv extends GscEnv {
  SUBMITIUM_API_KEY?: string;
  BACKLINK_SHEET_ID?: string;
  /** The day Submitium promised to have everything submitted by (ISO date); overdue is counted from it. */
  SUBMITIUM_SUBMITTED_BY?: string;
}

interface Directory {
  name: string;
  domain: string;
  dr: number | null;
  category: string;
}

export type DirectoryStatus = 'queued' | 'badge' | 'live' | 'overdue';

export interface DirectoryState extends Directory {
  status: DirectoryStatus;
  /** The listing's page once Submitium links it (the badge's link leaves the directory's homepage). */
  listing_url: string;
  live_at: string | null;
  /** The listing page was fetched and mentions the site ('yes'), did not ('no'), could not be fetched ('unreachable'), or was not checked yet (''). */
  verified: 'yes' | 'no' | 'unreachable' | '';
  checked: string;
}

export interface SubmitiumState {
  at: string;
  directories: DirectoryState[];
  live: number;
  badge: number;
  queued: number;
  overdue: number;
  newly_live: string[];
  error: string | null;
  sheet: { at: string | null; error: string | null };
}

const DIRECTORIES = directoriesJson as Directory[];
const STATE_META = 'submitium:state';
const TAB = 'Submitium';
const FIRST_ID = 201;
const BATCH = 'Submitium';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_SUBMITTED_BY = '2026-11-03';
const OVERDUE_AFTER_DAYS = 45;
/** Listing pages fetched per run to confirm a listing (the Worker's subrequest budget is small). */
const VERIFY_PER_RUN = 12;

type Badge = NonNullable<Awaited<ReturnType<typeof fetchWall>>>['badges'][number];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const host = (s: string) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/** A badge links the directory's homepage until the listing exists; a path beyond "/" is the listing's page. */
function listingLink(href: string): string {
  try {
    const u = new URL(href);
    return u.pathname.replace(/\/+$/, '') ? href : '';
  } catch {
    return '';
  }
}

/** Fetch a listing page and look for the site on it. */
async function verifyListing(url: string): Promise<'yes' | 'no' | 'unreachable'> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; WellnessWhizzBot/1.0; +https://aiww.io)', accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 'unreachable';
    const text = (await res.text()).toLowerCase();
    return text.includes('aiww.io') || text.includes('wellness whizz') ? 'yes' : 'no';
  } catch {
    return 'unreachable';
  }
}

export function submitiumEnabled(env: SubmitiumEnv): boolean {
  return !!(env.SUBMITIUM_API_KEY ?? '').trim();
}

export async function submitiumState(env: SubmitiumEnv): Promise<SubmitiumState | null> {
  try {
    const raw = await getMeta(env.DB, STATE_META);
    return raw ? (JSON.parse(raw) as SubmitiumState) : null;
  } catch {
    return null;
  }
}

/** Read the wall feed, update the directory states (never losing a live one when the API is down) and write the sheet tab. */
export async function submitiumStep(env: SubmitiumEnv): Promise<SubmitiumState> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const prev = await submitiumState(env);
  const previous = new Map((prev?.directories ?? []).map((d) => [key(d.name), d]));
  const apiKey = (env.SUBMITIUM_API_KEY ?? '').trim();
  let badges: Badge[] | null = null;
  let error: string | null = null;
  if (!apiKey) error = 'SUBMITIUM_API_KEY is not set';
  else {
    try {
      const wall = await fetchWall({ apiKey, timeout: 8000 });
      badges = wall?.badges ?? null;
      if (!badges) error = 'no wall from the Submitium API';
    } catch (err) {
      error = String(err).slice(0, 200);
    }
  }
  const byDomain = new Map((badges ?? []).map((b) => [host(b.domain), b]));
  const byName = new Map((badges ?? []).map((b) => [key(b.name), b]));
  const submittedBy = (env.SUBMITIUM_SUBMITTED_BY ?? '').trim() || DEFAULT_SUBMITTED_BY;
  const overdue = (Date.now() - Date.parse(submittedBy)) / 86_400_000 > OVERDUE_AFTER_DAYS;
  const classify = (d: Directory, old: DirectoryState | undefined, badge: Badge | undefined): DirectoryState => {
    const base = { ...d, domain: d.domain || (badge ? host(badge.domain) : old?.domain ?? ''), checked: today };
    // The feed could not be read: keep what we knew.
    if (!badges && old) return { ...old, checked: today };
    const link = badge ? listingLink(badge.href) : '';
    if (link) return { ...base, status: 'live', listing_url: link, live_at: old?.status === 'live' ? old.live_at : today, verified: old?.listing_url === link ? old.verified : '' };
    // A listing once linked stays live even if the feed later drops the badge (a directory can stop asking for it).
    if (old?.status === 'live' && listingLink(old.listing_url)) return { ...old, ...base, status: 'live' };
    const waiting: DirectoryStatus = overdue ? 'overdue' : badge ? 'badge' : 'queued';
    return { ...base, status: waiting, listing_url: '', live_at: null, verified: '' };
  };
  const directories: DirectoryState[] = DIRECTORIES.map((d) =>
    classify(d, previous.get(key(d.name)), badges ? (d.domain ? byDomain.get(host(d.domain)) : undefined) ?? byName.get(key(d.name)) : undefined),
  );
  // A badge for a directory that is not on the order (Submitium added one): keep it too, so the sheet shows it.
  const known = new Set(directories.map((d) => key(d.name)));
  const knownHosts = new Set(directories.map((d) => host(d.domain)).filter(Boolean));
  for (const b of badges ?? []) {
    if (known.has(key(b.name)) || knownHosts.has(host(b.domain))) continue;
    directories.push(classify({ name: b.name, domain: host(b.domain), dr: null, category: '' }, previous.get(key(b.name)), b));
  }
  // Confirm a few listing pages per run: the ones never checked first, then the oldest checks.
  let budget = VERIFY_PER_RUN;
  for (const d of directories.filter((x) => x.status === 'live' && x.verified !== 'yes').sort((a, b) => (a.verified ? 1 : 0) - (b.verified ? 1 : 0))) {
    if (budget-- <= 0) break;
    d.verified = await verifyListing(d.listing_url);
  }
  const newly = directories.filter((d) => d.status === 'live' && previous.get(key(d.name))?.status !== 'live').map((d) => d.name);
  const count = (status: DirectoryStatus) => directories.filter((d) => d.status === status).length;
  const state: SubmitiumState = {
    at: now,
    directories,
    live: count('live'),
    badge: count('badge'),
    queued: count('queued'),
    overdue: count('overdue'),
    newly_live: newly,
    error,
    sheet: { at: prev?.sheet.at ?? null, error: null },
  };
  try {
    await writeTab(env, directories, submittedBy);
    state.sheet = { at: now, error: null };
  } catch (err) {
    state.sheet = { at: prev?.sheet.at ?? null, error: String(err instanceof Error ? err.message : err).slice(0, 300) };
  }
  await setMeta(env.DB, STATE_META, JSON.stringify(state));
  return state;
}

/** The email to share the sheet with (the service account's), or null when the Search Console key is not set. */
export function serviceAccountEmail(env: SubmitiumEnv): string | null {
  return credentials(env)?.client_email ?? null;
}

// ---------- the sheet tab ----------

async function sheets<T>(env: SubmitiumEnv, url: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const token = await accessToken(env, false, SHEETS_SCOPE);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && retry) {
    await accessToken(env, true, SHEETS_SCOPE);
    return sheets<T>(env, url, init, false);
  }
  if (res.status === 403) {
    // Either the sheet is not shared with the service account, or the Sheets API is off in its Google Cloud project.
    const detail = (await res.text()).slice(0, 300);
    const who = serviceAccountEmail(env);
    if (/has not been used|is disabled|accessNotConfigured/i.test(detail)) throw new Error(`the Google Sheets API is not enabled in the service account's project: ${detail.replace(/\s+/g, ' ')}`);
    throw new Error(`the sheet is not shared with the service account${who ? ` (share it with ${who} as an editor)` : ''}: ${detail.replace(/\s+/g, ' ')}`);
  }
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function writeTab(env: SubmitiumEnv, rows: DirectoryState[], submittedBy: string): Promise<void> {
  const id = (env.BACKLINK_SHEET_ID ?? '').trim();
  if (!id) throw new Error('BACKLINK_SHEET_ID is not set');
  if (!credentials(env)) throw new Error('GSC_SERVICE_ACCOUNT is not set (the sheet is written with it)');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
  const meta = await sheets<{ sheets?: { properties?: { title?: string } }[] }>(env, `${base}?fields=sheets.properties.title`);
  if (!(meta.sheets ?? []).some((s) => s.properties?.title === TAB)) {
    await sheets(env, `${base}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
  }
  const count = (status: DirectoryStatus) => rows.filter((r) => r.status === status).length;
  const values: string[][] = [
    [`Wellness Whizz — Submitium order (${rows.length} directories, submitted by Submitium by ${submittedBy})`],
    [`Written by the Worker every morning from the Submitium badge feed. ${count('live')} live; ${count('badge')} with the badge in our footer, listing pending; ${count('queued')} queued${count('overdue') ? `; ${count('overdue')} overdue (still waiting ${OVERDUE_AFTER_DAYS} days after the submission date)` : ''}. Last written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`],
    [],
    ['ID', 'Resource', 'Status', 'Resource URL', 'Submission URL', 'Listing URL', 'Checked', 'Batch', 'Note'],
    ...rows.map((r, i) => [
      String(FIRST_ID + i),
      r.name,
      r.status === 'live' ? 'live' : 'submitted',
      r.domain ? `https://${r.domain}/` : '',
      'https://submitium.com/',
      r.listing_url,
      r.checked,
      BATCH,
      [
        r.dr !== null ? `DR ${r.dr}` : '',
        r.category,
        r.status === 'live'
          ? `listing linked since ${r.live_at}${r.verified === 'yes' ? ', page confirmed' : r.verified === 'no' ? ', page does not mention us yet' : r.verified === 'unreachable' ? ', page not reachable' : ''}`
          : r.status === 'badge'
            ? 'badge in our footer, listing pending'
            : r.status === 'overdue'
              ? 'OVERDUE: still waiting long after the submission date, ask Submitium'
              : 'queued at Submitium',
      ]
        .filter(Boolean)
        .join(' · '),
    ]),
  ];
  const range = encodeURIComponent(`${TAB}!A1:I${values.length + 50}`);
  await sheets(env, `${base}/values/${range}:clear`, { method: 'POST', body: {} });
  await sheets(env, `${base}/values/${encodeURIComponent(`${TAB}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: { range: `${TAB}!A1`, majorDimension: 'ROWS', values } });
}

// ---------- digest and report lines ----------

/** For the daily digest: only when something happened (a listing went live, an overdue one, or the sheet could not be written). */
export async function submitiumDigestLine(env: SubmitiumEnv): Promise<string> {
  if (!submitiumEnabled(env)) return '';
  const s = await submitiumState(env);
  if (!s) return '';
  const parts: string[] = [];
  if (s.newly_live.length) parts.push(`new listings live: ${s.newly_live.join(', ')}`);
  if (s.overdue) parts.push(`${s.overdue} overdue`);
  if (s.sheet.error) parts.push(`sheet tab not updated: ${s.sheet.error}`);
  if (s.error) parts.push(`feed: ${s.error}`);
  if (!parts.length) return '';
  return `Submitium: ${s.live} of ${s.directories.length} directories live, ${s.badge} with the badge up and the listing pending, ${s.queued} queued; ${parts.join('; ')}.`;
}

/** For the weekly report: always the totals. */
export async function submitiumReportLine(env: SubmitiumEnv): Promise<string> {
  if (!submitiumEnabled(env)) return '';
  const s = await submitiumState(env);
  if (!s) return '';
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const week = s.directories.filter((d) => d.status === 'live' && d.live_at && d.live_at >= since).length;
  return `Submitium: ${s.live} of ${s.directories.length} directories live (${week} new this week), ${s.badge} with the badge up and the listing pending, ${s.queued} queued${s.overdue ? `, ${s.overdue} overdue` : ''}.`;
}
