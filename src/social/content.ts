/**
 * What the site posts to X, and when. Three kinds, all about the site's own content:
 *   article  - a 3 to 4 post thread for each blog article (once per article)
 *   fact     - a fact from a supplement page, rotating through the catalogue
 *   research - a post per new research note
 * Posts wait in social_posts and go out from the hourly cron on a fixed schedule: X_POSTS_PER_WEEK posts a week (7 in
 * wrangler.jsonc: one a day), each at X_POST_HOUR_UTC on a posting day (see postingPlan). Each kind has its own lane
 * so a backlog of article threads never stops facts or research notes from being drafted, and the sender takes the
 * kinds in turn (the one that went out longest ago first). A failed send is retried once the next day and reported by
 * email (ALERT_EMAIL, else the EMAIL_FROM address) when Resend is configured.
 */
import { POSTS, type BlogPost } from '../blog';
import { getMeta, listSupplements, setMeta, type Supplement } from '../db';
import { alertRecipient, sendEmail, type EmailEnv } from '../email';
import { escapeHtml } from '../html';
import { chatJson, useFakeAi, type AiEnv } from '../openai';
import { pubmedUrl, unqueuedNotes } from '../research';
import { postThread, tweetLength, xEnabled, type XEnv } from './x';

export interface SocialEnv extends AiEnv, XEnv, EmailEnv {
  DB: D1Database;
  CANONICAL_HOST?: string;
  /** "false" keeps posts queued without sending them. */
  X_AUTOPOST?: string;
  /** Posts a week (default 1). Up to 7: one post per posting day at X_POST_HOUR_UTC; more: spread over the daytime window. */
  X_POSTS_PER_WEEK?: string;
  /** Posting days for up to seven posts a week, e.g. "tue" or "tue,fri" (default by count: tue; tue,fri; mon,wed,fri; ...). */
  X_POST_DAYS?: string;
  /** UTC hour of the post on a posting day (default 14: 16:00 in Madrid in summer, 10:00 in New York). */
  X_POST_HOUR_UTC?: string;
}

export interface SocialPost {
  id: number;
  channel: string;
  kind: string;
  ref: string;
  thread_json: string;
  status: string;
  scheduled_at: string;
  posted_at: string | null;
  external_id: string | null;
  error: string | null;
  created_at: string;
}

const MAX_TWEET = 270; // leave headroom under 280 after URL counting
const WINDOW_START_UTC = 7;
const WINDOW_END_UTC = 20;
const MIN_GAP_MINUTES = 150; // between two posts when more than seven a week are spread over the day
const SAME_DAY_HOURS = 22; // a posting day holds one post; 22 rather than 24 so a late cron run keeps the slot
const FAIL_PAUSE_HOURS = 3; // after a failed send, no further attempt for this long
const STALE_RESEARCH_DAYS = 60; // a research note still queued after this long is no longer news
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_DAYS: string[][] = [
  [],
  ['tue'],
  ['tue', 'fri'],
  ['mon', 'wed', 'fri'],
  ['mon', 'tue', 'thu', 'fri'],
  ['mon', 'tue', 'wed', 'thu', 'fri'],
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  DAY_NAMES,
];

export function siteOrigin(env: SocialEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim();
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : 'https://aiww.io';
}

function clampTweet(text: string, max = MAX_TWEET): string {
  let t = text.replace(/\s+/g, ' ').trim();
  while (tweetLength(t) > max) t = t.slice(0, t.length - 10).replace(/\s+\S*$/, '').trim() + '…';
  return t;
}

async function enqueue(db: D1Database, kind: string, ref: string, tweets: string[], when: Date): Promise<void> {
  await db
    .prepare('INSERT INTO social_posts (channel, kind, ref, thread_json, scheduled_at) VALUES (?, ?, ?, ?, ?)')
    .bind('x', kind, ref, JSON.stringify(tweets.map((t) => clampTweet(t))), when.toISOString().slice(0, 19).replace('T', ' '))
    .run();
}

// ---------- drafts ----------

const threadSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tweets: { type: 'array', items: { type: 'string' }, description: '3 or 4 posts, each under 240 characters. No hashtags, no emoji, no URLs.' },
  },
  required: ['tweets'],
} as const;

const factSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', description: 'One post under 200 characters. No hashtags, no emoji, no URL.' } },
  required: ['text'],
} as const;

const VOICE =
  'Voice: calm, specific, evidence-first, like a well-read friend who happens to be a pharmacist. Short sentences. ' +
  'No hype, no exclamation marks, no "game changer", no emoji, no hashtags. Never promise cures. Numbers and forms over adjectives.';

async function articleThread(env: SocialEnv, post: BlogPost): Promise<string[]> {
  const url = `${siteOrigin(env)}/blog/${post.slug}`;
  if (useFakeAi(env)) return [`[Dev mode] ${post.title}`, `[Dev mode] ${post.excerpt}`, `Full article: ${url}`];
  const text = post.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500);
  const draft = await chatJson<{ tweets: string[] }>(
    env,
    'article_thread',
    threadSchema,
    [
      `Write a thread for X announcing this article from Wellness Whizz. ${VOICE}`,
      'Post 1 is the hook: the single most useful, concrete point of the article, stated plainly. Posts 2 and 3 each give one specific finding or rule of thumb. Do not include the link; it is added separately.',
      `Title: ${post.title}`,
      `Description: ${post.description}`,
      `Article text (beginning): ${text}`,
    ].join('\n'),
  );
  const tweets = (draft.tweets ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  if (!tweets.length) throw new Error('empty thread draft');
  tweets.push(`Full article, with sources and the products we checked: ${url}`);
  return tweets;
}

async function factPost(env: SocialEnv, sup: Supplement): Promise<string[]> {
  const url = `${siteOrigin(env)}/supplement/${sup.slug}`;
  if (useFakeAi(env)) return [`[Dev mode] ${sup.name}: ${sup.summary} ${url}`];
  const article = sup.holistic_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1800);
  const draft = await chatJson<{ text: string }>(
    env,
    'fact_post',
    factSchema,
    [
      `Write one post for X about ${sup.name} for Wellness Whizz. ${VOICE}`,
      'Pick one concrete, useful detail (a dose range, a timing rule, a form that absorbs better, a common mistake, who should not take it) and state it as a tip. End with a short clause that invites reading the full profile, without a link.',
      `Summary: ${sup.summary}`,
      `Benefits: ${sup.benefits_html.replace(/<[^>]+>/g, ' ').slice(0, 600)}`,
      `Article: ${article}`,
    ].join('\n'),
  );
  const text = (draft.text ?? '').trim();
  if (!text) throw new Error('empty fact draft');
  return [`${text} ${url}`];
}

// ---------- queue builders (idempotent, run hourly) ----------

export async function buildQueue(env: SocialEnv): Promise<{ queued: string[] }> {
  const queued: string[] = [];
  const now = new Date();
  await env.DB
    .prepare("UPDATE social_posts SET status = 'skipped', error = ? WHERE status = 'queued' AND kind = 'research' AND created_at < datetime('now', ?)")
    .bind(`not sent within ${STALE_RESEARCH_DAYS} days`, `-${STALE_RESEARCH_DAYS} days`)
    .run();
  const pendingByKind = new Map<string, number>();
  for (const row of (await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM social_posts WHERE status = 'queued' GROUP BY kind").all<{ kind: string; n: number }>()).results) {
    pendingByKind.set(row.kind, Number(row.n));
  }
  const pending = (kind: string) => pendingByKind.get(kind) ?? 0;

  // 1. One thread per article, never twice (meta flag); drafted one per run while fewer than three threads wait.
  for (const post of POSTS) {
    if (pending('article') >= 3) break;
    const flag = `x:article:${post.slug}`;
    if (await getMeta(env.DB, flag)) continue;
    const tweets = await articleThread(env, post);
    await enqueue(env.DB, 'article', post.slug, tweets, now);
    await setMeta(env.DB, flag, now.toISOString());
    queued.push(`article:${post.slug}`);
    break; // one per run; the next hour handles the next article
  }

  // 2. One supplement fact drafted per day while fewer than two wait.
  const today = now.toISOString().slice(0, 10);
  const factToday = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE kind = 'fact' AND substr(created_at, 1, 10) = ?")
    .bind(today)
    .first<{ n: number }>();
  if (!(factToday?.n ?? 0) && pending('fact') < 2) {
    const all = (await listSupplements(env.DB, 500, true)).filter((s) => s.holistic_html.length > 400);
    const done = new Set((await env.DB.prepare("SELECT ref FROM social_posts WHERE kind = 'fact'").all<{ ref: string }>()).results.map((r) => r.ref));
    const candidates = all.filter((s) => !done.has(s.slug));
    const pool = candidates.length ? candidates : all;
    if (pool.length) {
      const sup = pool[Math.floor(Math.random() * pool.length)];
      const tweets = await factPost(env, sup);
      await enqueue(env.DB, 'fact', sup.slug, tweets, now);
      queued.push(`fact:${sup.slug}`);
    }
  }

  // 3. Research notes: at most two drafted per 7 days and two waiting at a time, regardless of the article backlog.
  const recentResearch = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE kind = 'research' AND created_at >= datetime('now', '-7 days')")
    .first<{ n: number }>();
  if ((recentResearch?.n ?? 0) < 2 && pending('research') < 2) {
    for (const note of await unqueuedNotes(env.DB, 1)) {
      const page = `${siteOrigin(env)}/supplement/${note.supplement_slug}`;
      const text = `${note.tweet.trim()} Study: ${pubmedUrl(note.pmid)} Our ${note.supplement_name} profile: ${page}`;
      await enqueue(env.DB, 'research', note.pmid, [text], now);
      await env.DB.prepare('UPDATE research_notes SET queued = 1 WHERE id = ?').bind(note.id).run();
      queued.push(`research:${note.pmid}`);
    }
  }
  return { queued };
}

// ---------- posting ----------

export interface PostingPlan {
  per_week: number;
  /** Posting days (three-letter names) when at most one post goes out a day; null when posts are spread over the day. */
  days: string[] | null;
  hour_utc: number;
  per_day: number;
}

/** The schedule from the X_POSTS_PER_WEEK, X_POST_DAYS and X_POST_HOUR_UTC variables. */
export function postingPlan(env: SocialEnv): PostingPlan {
  const perWeek = Math.max(1, Math.round(Number(env.X_POSTS_PER_WEEK ?? '1') || 1));
  if (perWeek > 7) return { per_week: perWeek, days: null, hour_utc: WINDOW_START_UTC, per_day: Math.ceil(perWeek / 7) };
  const hour = Math.min(WINDOW_END_UTC - 1, Math.max(0, Math.floor(Number(env.X_POST_HOUR_UTC ?? '14') || 0)));
  const custom = [...new Set((env.X_POST_DAYS ?? '').toLowerCase().split(/[\s,]+/).map((d) => d.slice(0, 3)).filter((d) => DAY_NAMES.includes(d)))];
  return { per_week: perWeek, days: custom.length ? custom : DEFAULT_DAYS[perWeek], hour_utc: hour, per_day: 1 };
}

export interface SendState {
  ok: boolean;
  /** Why not right now ('' when ok). */
  reason: string;
  last_post_at: string | null;
  /** When the sender may post next (UTC, ISO minutes), 'now' when ok. */
  next_slot: string | null;
}

function parseDb(t: string | null | undefined): number {
  return t ? Date.parse(t.replace(' ', 'T') + 'Z') : 0;
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

/** Whether the sender may post right now under the plan, and otherwise when. Shared by postDue and the admin page. */
export async function sendState(env: SocialEnv, db: D1Database, now = new Date()): Promise<SendState> {
  const plan = postingPlan(env);
  const last = await db.prepare("SELECT MAX(posted_at) AS t FROM social_posts WHERE status = 'posted'").first<{ t: string | null }>();
  const lastAt = parseDb(last?.t);
  const lastPost = last?.t ?? null;
  const t = now.getTime();
  const hour = now.getUTCHours();
  const lastFail = Date.parse((await getMeta(db, 'social:lastfail')) ?? '') || 0;
  const pausedUntil = lastFail + FAIL_PAUSE_HOURS * 3600_000;

  if (plan.days) {
    // One post per posting day, from the planned hour until the end of the daytime window.
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let slot: number | null = null;
    for (let d = 0; d <= 7 && slot === null; d++) {
      const open = dayStart + d * 86_400_000 + plan.hour_utc * 3600_000;
      const close = dayStart + d * 86_400_000 + WINDOW_END_UTC * 3600_000;
      const date = new Date(open);
      if (!plan.days.includes(DAY_NAMES[date.getUTCDay()])) continue;
      if (close <= t || close <= lastAt + SAME_DAY_HOURS * 3600_000) continue; // over for today, or today's post is out
      slot = Math.max(open, t, lastAt + SAME_DAY_HOURS * 3600_000, pausedUntil);
      if (slot >= close) slot = null; // the pause runs past the window: next posting day
    }
    if (slot === null) return { ok: false, reason: 'no posting day within a week', last_post_at: lastPost, next_slot: null };
    if (slot <= t) return { ok: true, reason: '', last_post_at: lastPost, next_slot: 'now' };
    const reason =
      t < pausedUntil && t >= dayStart + plan.hour_utc * 3600_000 && hour < WINDOW_END_UTC
        ? `paused ${FAIL_PAUSE_HOURS}h after a failed post`
        : lastAt && t - lastAt < SAME_DAY_HOURS * 3600_000
          ? "today's post is out"
          : plan.days.includes(DAY_NAMES[now.getUTCDay()]) && hour < plan.hour_utc
            ? `before the ${String(plan.hour_utc).padStart(2, '0')}:00 UTC slot`
            : 'not a posting day';
    return { ok: false, reason, last_post_at: lastPost, next_slot: isoMinute(slot) };
  }

  // More than seven a week: spread over the daytime window, a cap a day, a minimum gap between two.
  const inWindow = (ms: number) => {
    const h = new Date(ms).getUTCHours();
    return h >= WINDOW_START_UTC && h < WINDOW_END_UTC;
  };
  const toWindow = (ms: number) => {
    if (inWindow(ms)) return ms;
    const d = new Date(ms);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WINDOW_START_UTC);
    return d.getUTCHours() < WINDOW_START_UTC ? start : start + 86_400_000;
  };
  const recent = await db
    .prepare("SELECT COUNT(*) AS n, MIN(posted_at) AS oldest FROM social_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-24 hours')")
    .first<{ n: number; oldest: string | null }>();
  let candidate = Math.max(t, lastAt + MIN_GAP_MINUTES * 60_000, pausedUntil);
  let reason = '';
  if ((recent?.n ?? 0) >= plan.per_day) {
    candidate = Math.max(candidate, parseDb(recent?.oldest) + 86_400_000);
    reason = 'daily cap reached';
  } else if (t < pausedUntil) reason = `paused ${FAIL_PAUSE_HOURS}h after a failed post`;
  else if (lastAt && t - lastAt < MIN_GAP_MINUTES * 60_000) reason = 'too soon after the last post';
  else if (!inWindow(t)) reason = 'outside posting window';
  candidate = toWindow(candidate);
  if (candidate <= t && !reason) return { ok: true, reason: '', last_post_at: lastPost, next_slot: 'now' };
  return { ok: false, reason: reason || 'outside posting window', last_post_at: lastPost, next_slot: isoMinute(candidate) };
}

export async function postDue(env: SocialEnv): Promise<{ posted: string[]; failed: string[]; skipped: string }> {
  const posted: string[] = [];
  const failed: string[] = [];
  if (env.X_AUTOPOST === 'false') return { posted, failed, skipped: 'X_AUTOPOST=false' };
  if (!xEnabled(env)) return { posted, failed, skipped: 'X keys not configured' };
  const state = await sendState(env, env.DB);
  if (!state.ok) return { posted, failed, skipped: state.reason };

  const next = await nextDue(env.DB);
  if (!next) return { posted, failed, skipped: 'nothing due' };
  try {
    const tweets = JSON.parse(next.thread_json) as string[];
    const id = await postThread(env, tweets);
    await env.DB.prepare("UPDATE social_posts SET status = 'posted', posted_at = datetime('now'), external_id = ?, error = NULL WHERE id = ?").bind(id, next.id).run();
    posted.push(`${next.kind}:${next.ref}`);
  } catch (err) {
    const message = String(err).slice(0, 300);
    // The first failure gets one more try a day later (the error stays visible); the second parks the post as failed.
    const parked = !!next.error;
    if (parked) await env.DB.prepare("UPDATE social_posts SET status = 'failed', error = ? WHERE id = ?").bind(message, next.id).run();
    else await env.DB.prepare("UPDATE social_posts SET scheduled_at = datetime('now', '+1 day'), error = ? WHERE id = ?").bind(message, next.id).run();
    await setMeta(env.DB, 'social:lastfail', new Date().toISOString());
    failed.push(`${next.kind}:${next.ref}: ${message.slice(0, 160)}`);
    await alertFailure(env, next, message, parked);
  }
  return { posted, failed, skipped: '' };
}

/** One email per failed send, through Resend when it is configured; never throws. */
async function alertFailure(env: SocialEnv, post: SocialPost, message: string, parked: boolean): Promise<void> {
  const to = alertRecipient(env);
  if (!to) return;
  const first = (() => {
    try {
      return (JSON.parse(post.thread_json) as string[])[0] ?? '';
    } catch {
      return '';
    }
  })();
  const admin = `${siteOrigin(env)}/api/admin/social?key=<your STATS_KEY>`;
  const nextStep = parked
    ? `This was its second failure, so it is parked as "failed". To try again: ${admin}&action=retry&id=${post.id}`
    : 'It will be tried once more on the next posting day. Nothing to do unless this email comes again.';
  const subject = `X post failed: ${post.kind} ${post.ref}`;
  const text = [`The site could not publish a post on X.`, '', `Post: ${post.kind} ${post.ref} (id ${post.id})`, `Error: ${message}`, '', `First tweet: ${first}`, '', nextStep, '', `Queue and status: ${admin}`].join('\n');
  const html = `<p>The site could not publish a post on X.</p>
<p><b>Post:</b> ${escapeHtml(post.kind)} ${escapeHtml(post.ref)} (id ${post.id})<br><b>Error:</b> ${escapeHtml(message)}</p>
<p style="color:#555">${escapeHtml(first)}</p>
<p>${escapeHtml(nextStep)}</p>
<p>Queue and status: ${escapeHtml(admin)}</p>`;
  try {
    await sendEmail(env, to, subject, html, text);
  } catch (err) {
    console.error(`alert email failed: ${String(err)}`);
  }
}

/**
 * The next post to send: the kind that went out longest ago first (a kind never posted before any other; article,
 * then fact, then research on a tie), the oldest post within that kind. The kinds therefore take turns however
 * long the article backlog is: article, fact, research, article...
 */
export async function nextDue(db: D1Database): Promise<SocialPost | null> {
  const due = (
    await db
      .prepare("SELECT * FROM social_posts WHERE status = 'queued' AND scheduled_at <= datetime('now') ORDER BY scheduled_at, id LIMIT 20")
      .all<SocialPost>()
  ).results;
  if (!due.length) return null;
  const lastByKind = new Map<string, string>();
  for (const row of (await db.prepare("SELECT kind, MAX(posted_at) AS t FROM social_posts WHERE status = 'posted' GROUP BY kind").all<{ kind: string; t: string | null }>()).results) {
    lastByKind.set(row.kind, row.t ?? '');
  }
  const order = ['article', 'fact', 'research'];
  const rank = (kind: string) => (order.includes(kind) ? order.indexOf(kind) : order.length);
  return [...due].sort(
    (a, b) =>
      (lastByKind.get(a.kind) ?? '').localeCompare(lastByKind.get(b.kind) ?? '') ||
      rank(a.kind) - rank(b.kind) ||
      a.scheduled_at.localeCompare(b.scheduled_at) ||
      a.id - b.id,
  )[0];
}

export async function listSocialPosts(db: D1Database, limit = 50): Promise<SocialPost[]> {
  const { results } = await db.prepare('SELECT * FROM social_posts ORDER BY id DESC LIMIT ?').bind(limit).all<SocialPost>();
  return results;
}

export async function setSocialStatus(db: D1Database, id: number, status: 'queued' | 'skipped', scheduledAt?: string): Promise<void> {
  if (scheduledAt) await db.prepare('UPDATE social_posts SET status = ?, scheduled_at = ?, error = NULL WHERE id = ?').bind(status, scheduledAt, id).run();
  else await db.prepare('UPDATE social_posts SET status = ?, error = NULL WHERE id = ?').bind(status, id).run();
}
